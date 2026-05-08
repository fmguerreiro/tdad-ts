import fs from "node:fs";
import path from "node:path";
import { Project, ts, type SourceFile } from "ts-morph";
import {
  Graph,
  type ClassNode,
  type Edge,
  type FileNode,
  type FunctionNode,
} from "./graph.js";
import { isTestPath } from "./test-detect.js";
import {
  hashContent,
  loadCache,
  rehydrate,
  saveCache,
  snapshotFilesystem,
} from "./cache.js";

export interface IndexOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  tsConfigFilePath?: string;
  cachePath?: string;
}

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
];

export async function buildGraph(options: IndexOptions): Promise<Graph> {
  const root = path.resolve(options.root);
  const patterns = options.include ?? DEFAULT_INCLUDE;
  const ignore = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];

  const tsConfigHash = options.tsConfigFilePath
    ? hashContent(fs.readFileSync(path.resolve(options.tsConfigFilePath), "utf8"))
    : undefined;
  const snapshot = await snapshotFilesystem(root, patterns, ignore, tsConfigHash);

  if (options.cachePath) {
    const cached = loadCache(options.cachePath);
    if (cached && cached.fingerprint === snapshot.fingerprint) {
      return rehydrate(cached);
    }
  }

  const files = snapshot.files.map((file) => path.join(root, file.path));

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    ...(options.tsConfigFilePath
      ? { tsConfigFilePath: path.resolve(options.tsConfigFilePath) }
      : {
          compilerOptions: {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
          },
        }),
  });

  const graph = new Graph();
  const sourceFiles: SourceFile[] = [];

  for (const absolute of files) {
    const relative = path.relative(root, absolute);
    const content = fs.readFileSync(absolute, "utf8");
    const fileNode: FileNode = {
      kind: "File",
      id: fileId(relative),
      path: relative,
      contentHash: hashContent(content),
      isTest: isTestPath(relative),
    };
    graph.addNode(fileNode);
    sourceFiles.push(project.createSourceFile(absolute, content, { overwrite: true }));
  }

  for (const sourceFile of sourceFiles) {
    const relative = path.relative(root, sourceFile.getFilePath());
    addContains(graph, sourceFile, relative);
    addInherits(graph, sourceFile, relative);
  }

  addImports(graph, project, root);
  addCalls(graph, project, root);

  if (options.cachePath) {
    saveCache(options.cachePath, graph, snapshot);
  }

  return graph;
}

function addContains(graph: Graph, sourceFile: SourceFile, relativePath: string): void {
  const fileIdString = fileId(relativePath);

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (!name) continue;
    const node: FunctionNode = {
      kind: "Function",
      id: `${fileIdString}#fn:${name}`,
      name,
      file: fileIdString,
      startLine: declaration.getStartLineNumber(),
      endLine: declaration.getEndLineNumber(),
    };
    if (graph.hasNode(node.id)) continue;
    graph.addNode(node);
    graph.addEdge({ kind: "CONTAINS", from: fileIdString, to: node.id });
  }

  for (const declaration of sourceFile.getClasses()) {
    const name = declaration.getName();
    if (!name) continue;
    const node: ClassNode = {
      kind: "Class",
      id: `${fileIdString}#cls:${name}`,
      name,
      file: fileIdString,
      startLine: declaration.getStartLineNumber(),
      endLine: declaration.getEndLineNumber(),
    };
    if (graph.hasNode(node.id)) continue;
    graph.addNode(node);
    graph.addEdge({ kind: "CONTAINS", from: fileIdString, to: node.id });
  }
}

function addInherits(graph: Graph, sourceFile: SourceFile, relativePath: string): void {
  const fileIdString = fileId(relativePath);
  for (const declaration of sourceFile.getClasses()) {
    const name = declaration.getName();
    if (!name) continue;
    const childId = `${fileIdString}#cls:${name}`;
    const baseClause = declaration.getExtends();
    if (!baseClause) continue;
    const baseName = baseClause.getExpression().getText();
    const baseId = findClassByName(graph, baseName);
    if (!baseId) continue;
    graph.addEdge({ kind: "INHERITS", from: childId, to: baseId });
  }
}

function findClassByName(graph: Graph, name: string): string | undefined {
  for (const node of graph.nodes.values()) {
    if (node.kind === "Class" && node.name === name) return node.id;
  }
  return undefined;
}

function addImports(graph: Graph, project: Project, root: string): void {
  for (const sourceFile of project.getSourceFiles()) {
    const fromRelative = path.relative(root, sourceFile.getFilePath());
    const fromId = fileId(fromRelative);
    const seen = new Set<string>();

    for (const declaration of sourceFile.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target) continue;
      const toRelative = path.relative(root, target.getFilePath());
      if (toRelative.startsWith("..") || path.isAbsolute(toRelative)) continue;
      const toId = fileId(toRelative);
      if (toId === fromId) continue;
      if (!graph.hasNode(toId)) continue;
      if (seen.has(toId)) continue;
      seen.add(toId);
      const edge: Edge = { kind: "IMPORTS", from: fromId, to: toId };
      graph.addEdge(edge);
    }
  }
}

// Maps local identifier name → the exported function name it refers to and the source file path.
interface ImportedBinding {
  exportedName: string;
  sourceFileId: string;
}

function addCalls(graph: Graph, project: Project, root: string): void {
  for (const sourceFile of project.getSourceFiles()) {
    const fromRelative = path.relative(root, sourceFile.getFilePath());
    const fromFileId = fileId(fromRelative);

    // Build a map from local name → ImportedBinding for all named imports in this file.
    // Use the ts-morph import declarations (already resolved) to avoid redundant work.
    const importedBindings = new Map<string, ImportedBinding>();
    for (const declaration of sourceFile.getImportDeclarations()) {
      const targetSourceFile = declaration.getModuleSpecifierSourceFile();
      if (!targetSourceFile) continue;
      const targetRelative = path.relative(root, targetSourceFile.getFilePath());
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) continue;
      const targetFileId = fileId(targetRelative);
      for (const specifier of declaration.getNamedImports()) {
        const localName = specifier.getAliasNode()?.getText() ?? specifier.getName();
        importedBindings.set(localName, {
          exportedName: specifier.getName(),
          sourceFileId: targetFileId,
        });
      }
    }

    // Walk the raw TypeScript AST directly to avoid ts-morph wrapper allocation overhead.
    const emittedEdges = new Set<string>();
    const rawSourceFile = sourceFile.compilerNode;
    walkForCalls(rawSourceFile, undefined, fromFileId, graph, importedBindings, emittedEdges);
  }
}

// Walk the raw TypeScript AST, tracking the nearest enclosing named function/method.
// Uses ts.forEachChild to avoid allocating ts-morph wrapper nodes for every descendant.
function walkForCalls(
  node: ts.Node,
  enclosingFunctionName: string | undefined,
  fileId: string,
  graph: Graph,
  importedBindings: Map<string, ImportedBinding>,
  emittedEdges: Set<string>,
): void {
  let currentFunctionName = enclosingFunctionName;

  if (
    node.kind === ts.SyntaxKind.FunctionDeclaration ||
    node.kind === ts.SyntaxKind.MethodDeclaration
  ) {
    const named = node as ts.FunctionDeclaration | ts.MethodDeclaration;
    const nameNode = named.name;
    if (nameNode && ts.isIdentifier(nameNode)) {
      currentFunctionName = nameNode.text;
    }
  }

  if (node.kind === ts.SyntaxKind.CallExpression && currentFunctionName !== undefined) {
    const callExpr = node as ts.CallExpression;
    if (ts.isIdentifier(callExpr.expression)) {
      const calleeName = callExpr.expression.text;
      const callerFunctionId = `${fileId}#fn:${currentFunctionName}`;
      if (graph.hasNode(callerFunctionId)) {
        let targetFunctionId: string | undefined;
        const sameFileFunctionId = `${fileId}#fn:${calleeName}`;
        if (graph.hasNode(sameFileFunctionId) && sameFileFunctionId !== callerFunctionId) {
          targetFunctionId = sameFileFunctionId;
        } else {
          const binding = importedBindings.get(calleeName);
          if (binding) {
            const candidate = `${binding.sourceFileId}#fn:${binding.exportedName}`;
            if (graph.hasNode(candidate)) {
              targetFunctionId = candidate;
            }
          }
        }
        if (targetFunctionId !== undefined) {
          const edgeKey = `${callerFunctionId}→${targetFunctionId}`;
          if (!emittedEdges.has(edgeKey)) {
            emittedEdges.add(edgeKey);
            graph.addEdge({ kind: "CALLS", from: callerFunctionId, to: targetFunctionId });
          }
        }
      }
    }
  }

  ts.forEachChild(node, (child) => {
    walkForCalls(child, currentFunctionName, fileId, graph, importedBindings, emittedEdges);
  });
}

export function fileId(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}
