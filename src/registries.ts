import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, SyntaxKind, type SourceFile, type CallExpression, type ImportDeclaration } from "ts-morph";
import { Graph } from "./graph.js";
import { fileId } from "./parser.js";

export interface RegistryConfig {
  registries?: RegistryRule[];
  routes?: {
    appDir: string;
    fileNames?: string[];
  };
}

export interface RegistryRule {
  name: string;
  lookup: {
    import: string;
    function: string;
    argIndex: number;
  };
  registered: {
    files: string;
    key: "basename" | "stem";
  };
}

export function loadRegistryConfig(configPath: string): RegistryConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`registries config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as RegistryConfig;
  return parsed;
}

export async function emitRegistryEdges(
  graph: Graph,
  project: Project,
  root: string,
  rules: RegistryRule[],
): Promise<void> {
  for (const rule of rules) {
    const keyToFile = await buildKeyMap(root, rule);
    if (keyToFile.size === 0) continue;
    for (const sourceFile of project.getSourceFiles()) {
      const relativePath = path.relative(root, sourceFile.getFilePath()).split(path.sep).join("/");
      const callerId = fileId(relativePath);
      const callerNode = graph.nodes.get(callerId);
      if (!callerNode || callerNode.kind !== "File") continue;
      const aliases = importedAliases(sourceFile, root, rule.lookup.import, rule.lookup.function);
      if (aliases.size === 0) continue;
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const calleeName = calleeIdentifier(call);
        if (!calleeName || !aliases.has(calleeName)) continue;
        const argument = call.getArguments()[rule.lookup.argIndex];
        if (!argument) continue;
        const literal = stringLiteralValue(argument);
        if (literal === undefined) continue;
        const targetFile = keyToFile.get(literal);
        if (!targetFile) continue;
        if (callerId === targetFile) continue;
        if (graph.outgoing(callerId, "ROUTE").some((edge) => edge.to === targetFile)) continue;
        graph.addEdge({ kind: "ROUTE", from: callerId, to: targetFile });
      }
    }
  }
}

async function buildKeyMap(root: string, rule: RegistryRule): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const matches = await fg([rule.registered.files], {
    cwd: root,
    absolute: false,
    dot: false,
  });
  for (const match of matches) {
    const id = fileId(match);
    const key = deriveKey(match, rule.registered.key);
    if (map.has(key)) continue;
    map.set(key, id);
  }
  return map;
}

function deriveKey(filePath: string, mode: "basename" | "stem"): string {
  const base = path.basename(filePath);
  if (mode === "basename") {
    const lastDot = base.lastIndexOf(".");
    return lastDot === -1 ? base : base.slice(0, lastDot);
  }
  const noExt = base.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, "");
  return noExt;
}

function importedAliases(
  sourceFile: SourceFile,
  root: string,
  expectedImport: string,
  expectedFunction: string,
): Set<string> {
  const aliases = new Set<string>();
  const fileDir = path.dirname(sourceFile.getFilePath());
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!moduleSpecifierMatches(declaration, fileDir, root, expectedImport)) continue;
    for (const namedImport of declaration.getNamedImports()) {
      const name = namedImport.getNameNode().getText();
      const alias = namedImport.getAliasNode()?.getText();
      if (name === expectedFunction) {
        aliases.add(alias ?? name);
      }
    }
  }
  return aliases;
}

function moduleSpecifierMatches(
  declaration: ImportDeclaration,
  fileDir: string,
  root: string,
  expected: string,
): boolean {
  const value = declaration.getModuleSpecifierValue();
  const stripExt = (text: string) => text.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
  const normalizedExpected = stripExt(expected).replace(/^\.\//, "");
  const target = declaration.getModuleSpecifierSourceFile();
  if (target) {
    const relativeFromRoot = path
      .relative(root, target.getFilePath())
      .split(path.sep)
      .join("/");
    if (stripExt(relativeFromRoot) === normalizedExpected) return true;
  }
  if (value.startsWith(".")) {
    const resolved = path
      .normalize(path.join(path.relative(root, fileDir), value))
      .split(path.sep)
      .join("/");
    if (stripExt(resolved) === normalizedExpected) return true;
  }
  if (stripExt(value) === stripExt(expected)) return true;
  return false;
}

function calleeIdentifier(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (expression.getKind() === SyntaxKind.Identifier) return expression.getText();
  if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
    const lastDot = expression.getText().lastIndexOf(".");
    return lastDot === -1 ? expression.getText() : expression.getText().slice(lastDot + 1);
  }
  return undefined;
}

function stringLiteralValue(node: import("ts-morph").Node): string | undefined {
  if (node.getKind() === SyntaxKind.StringLiteral) {
    return (node.asKindOrThrow(SyntaxKind.StringLiteral)).getLiteralValue();
  }
  if (node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (node.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral)).getLiteralValue();
  }
  return undefined;
}
