import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, SyntaxKind, type SourceFile, type CallExpression, type ImportDeclaration } from "ts-morph";
import { Graph } from "./graph.js";
import { fileId } from "./parser.js";
import { forEachFileInGraph, addRouteEdgeOnce } from "./route-table.js";

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
  };
}

function validateRegistryConfig(value: unknown): RegistryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`registries config must be a JSON object`);
  }

  if ("routes" in value) {
    const routes = (value as Record<string, unknown>).routes;
    if (typeof routes !== "object" || routes === null || Array.isArray(routes)) {
      throw new Error(`registries config: "routes" must be an object`);
    }
    const routesObj = routes as Record<string, unknown>;
    if (typeof routesObj.appDir !== "string") {
      throw new Error(`registries config: "routes.appDir" must be a string`);
    }
    if ("fileNames" in routesObj) {
      if (!Array.isArray(routesObj.fileNames) || !routesObj.fileNames.every((item) => typeof item === "string")) {
        throw new Error(`registries config: "routes.fileNames" must be an array of strings`);
      }
    }
  }

  if ("registries" in value) {
    const registries = (value as Record<string, unknown>).registries;
    if (!Array.isArray(registries)) {
      throw new Error(`registries config: "registries" must be an array`);
    }
    for (let index = 0; index < registries.length; index++) {
      const rule = registries[index];
      if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
        throw new Error(`registries config: "registries[${index}]" must be an object`);
      }
      const ruleObj = rule as Record<string, unknown>;
      if (typeof ruleObj.name !== "string") {
        throw new Error(`registries config: "registries[${index}].name" must be a string`);
      }
      if (typeof ruleObj.lookup !== "object" || ruleObj.lookup === null || Array.isArray(ruleObj.lookup)) {
        throw new Error(`registries config: "registries[${index}].lookup" must be an object`);
      }
      const lookup = ruleObj.lookup as Record<string, unknown>;
      if (typeof lookup.import !== "string") {
        throw new Error(`registries config: "registries[${index}].lookup.import" must be a string`);
      }
      if (typeof lookup.function !== "string") {
        throw new Error(`registries config: "registries[${index}].lookup.function" must be a string`);
      }
      if (typeof lookup.argIndex !== "number" || lookup.argIndex < 0) {
        throw new Error(`registries config: "registries[${index}].lookup.argIndex" must be a non-negative number`);
      }
      if (typeof ruleObj.registered !== "object" || ruleObj.registered === null || Array.isArray(ruleObj.registered)) {
        throw new Error(`registries config: "registries[${index}].registered" must be an object`);
      }
      const registered = ruleObj.registered as Record<string, unknown>;
      if (typeof registered.files !== "string") {
        throw new Error(`registries config: "registries[${index}].registered.files" must be a string`);
      }
    }
  }

  return value as RegistryConfig;
}

export function loadRegistryConfig(configPath: string): RegistryConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`registries config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return validateRegistryConfig(parsed);
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
    forEachFileInGraph(graph, project, root, ({ sourceFile, callerId }) => {
      const aliases = importedAliases(sourceFile, root, rule.lookup.import, rule.lookup.function);
      if (aliases.size === 0) return;
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const calleeName = calleeIdentifier(call);
        if (!calleeName || !aliases.has(calleeName)) continue;
        const argument = call.getArguments()[rule.lookup.argIndex];
        if (!argument) continue;
        const literal = stringLiteralValue(argument);
        if (literal === undefined) continue;
        const targetFile = keyToFile.get(literal);
        if (!targetFile) continue;
        addRouteEdgeOnce(graph, callerId, targetFile);
      }
    });
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
    const key = deriveKey(match);
    if (map.has(key)) continue;
    map.set(key, id);
  }
  return map;
}

// Registry keys are always extension-stripped basenames (stems).
// The "key" field was removed because both modes produced the same result
// for .ts/.tsx files and the distinction added no real value.
function deriveKey(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, "");
}

function importedAliases(
  sourceFile: SourceFile,
  root: string,
  expectedImport: string,
  expectedFunction: string,
): Set<string> {
  const aliases = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!moduleSpecifierMatches(declaration, root, expectedImport)) continue;
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
  root: string,
  expected: string,
): boolean {
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
  const value = declaration.getModuleSpecifierValue();
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
