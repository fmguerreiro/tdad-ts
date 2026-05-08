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
import { buildRouteTable, emitRouteEdges } from "./route-table.js";
import { emitRegistryEdges, loadRegistryConfig } from "./registries.js";
import { emitCoverageEdges, loadCoverageJson } from "./coverage.js";

export interface IndexOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  tsConfigFilePath?: string;
  cachePath?: string;
  registriesConfigPath?: string;
  coveragePath?: string;
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

  const extraHashes: Record<string, string> = {};
  if (options.tsConfigFilePath) {
    extraHashes.tsconfig = hashContent(
      fs.readFileSync(path.resolve(options.tsConfigFilePath), "utf8"),
    );
  }
  if (options.registriesConfigPath) {
    extraHashes.registries = hashContent(
      fs.readFileSync(path.resolve(options.registriesConfigPath), "utf8"),
    );
  }
  if (options.coveragePath) {
    const rawCoverage = fs.readFileSync(path.resolve(options.coveragePath), "utf8");
    const parsedCoverage: unknown = JSON.parse(rawCoverage);
    const canonicalCoverage = JSON.stringify(parsedCoverage, sortedReplacer);
    extraHashes.coverage = hashContent(canonicalCoverage);
  }
  const snapshot = await snapshotFilesystem(root, patterns, ignore, extraHashes);

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

  if (options.registriesConfigPath) {
    const config = loadRegistryConfig(path.resolve(options.registriesConfigPath));
    if (config.routes) {
      const absoluteAppDir = path.resolve(root, config.routes.appDir);
      if (!fs.existsSync(absoluteAppDir)) {
        throw new Error(`registries config routes.appDir not found: ${absoluteAppDir}`);
      }
      const routes = await buildRouteTable(root, config.routes.appDir, config.routes.fileNames);
      emitRouteEdges(graph, project, root, routes);
    }
    if (config.registries) {
      await emitRegistryEdges(graph, project, root, config.registries);
    }
  }

  if (options.coveragePath) {
    const resolvedCoveragePath = path.resolve(options.coveragePath);
    const coverage = loadCoverageJson(resolvedCoveragePath);
    emitCoverageEdges(graph, coverage, resolvedCoveragePath);
  }

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
    // Register a default-export alias so default imports resolve to this function.
    // `export default function format(...)` exposes the function under the name
    // `default` to consumers using `import format from "./formatter"`.
    if (declaration.isDefaultExport()) {
      const aliasId = `${fileIdString}#fn:default`;
      if (!graph.hasNode(aliasId)) {
        const aliasNode: FunctionNode = {
          kind: "Function",
          id: aliasId,
          name: "default",
          file: fileIdString,
          startLine: declaration.getStartLineNumber(),
          endLine: declaration.getEndLineNumber(),
        };
        graph.addNode(aliasNode);
        graph.addEdge({ kind: "CONTAINS", from: fileIdString, to: aliasNode.id });
      }
    }
  }

  // Register variable declarations whose initializer is an arrow function or function
  // expression (e.g. `const compute = () => ...` or `const compute = function() { ... }`).
  // Only handles simple single-binding declarations; destructured / multi-binding cases are
  // skipped because the name is ambiguous.
  for (const variableStatement of sourceFile.getVariableStatements()) {
    for (const declaration of variableStatement.getDeclarations()) {
      const nameNode = declaration.getNameNode();
      // Skip destructured bindings.
      if (nameNode.getKind() !== ts.SyntaxKind.Identifier) continue;
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      const initKind = initializer.getKind();
      if (
        initKind !== ts.SyntaxKind.ArrowFunction &&
        initKind !== ts.SyntaxKind.FunctionExpression
      ) continue;
      const name = nameNode.getText();
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

    // Register methods on the class. Function ID format: `${fileId}#fn:${className}.${methodName}`
    // to avoid collisions between methods of the same name in different classes.
    for (const method of declaration.getMethods()) {
      const methodName = method.getName();
      if (!methodName) continue;
      const methodNode: FunctionNode = {
        kind: "Function",
        id: `${fileIdString}#fn:${name}.${methodName}`,
        name: `${name}.${methodName}`,
        file: fileIdString,
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
      };
      if (graph.hasNode(methodNode.id)) continue;
      graph.addNode(methodNode);
      graph.addEdge({ kind: "CONTAINS", from: fileIdString, to: methodNode.id });
    }
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

// Maps local identifier name → the imported binding it refers to and the source file path.
// `kind` distinguishes named, default, and namespace imports.
type ImportedBinding =
  | { kind: "named"; exportedName: string; sourceFileId: string }
  | { kind: "default"; exportedName: "default"; sourceFileId: string }
  | { kind: "namespace"; sourceFileId: string };

function addCalls(graph: Graph, project: Project, root: string): void {
  for (const sourceFile of project.getSourceFiles()) {
    const fromRelative = path.relative(root, sourceFile.getFilePath());
    const fromFileId = fileId(fromRelative);

    // Build a map from local name → ImportedBinding for all imports in this file.
    // Use the ts-morph import declarations (already resolved) to avoid redundant work.
    const importedBindings = new Map<string, ImportedBinding>();
    for (const declaration of sourceFile.getImportDeclarations()) {
      const targetSourceFile = declaration.getModuleSpecifierSourceFile();
      if (!targetSourceFile) continue;
      const targetRelative = path.relative(root, targetSourceFile.getFilePath());
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) continue;
      const targetFileId = fileId(targetRelative);

      // Named imports: `import { foo, bar as baz } from "..."`.
      for (const specifier of declaration.getNamedImports()) {
        const localName = specifier.getAliasNode()?.getText() ?? specifier.getName();
        importedBindings.set(localName, {
          kind: "named",
          exportedName: specifier.getName(),
          sourceFileId: targetFileId,
        });
      }

      // Default import: `import foo from "..."`.
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) {
        importedBindings.set(defaultImport.getText(), {
          kind: "default",
          exportedName: "default",
          sourceFileId: targetFileId,
        });
      }

      // Namespace import: `import * as ns from "..."`.
      const namespaceImport = declaration.getNamespaceImport();
      if (namespaceImport) {
        importedBindings.set(namespaceImport.getText(), {
          kind: "namespace",
          sourceFileId: targetFileId,
        });
      }
    }

    // Collect the names of locally-declared functions (top-level function declarations,
    // arrow/function-expression variable declarations) so walkForCalls can distinguish
    // local-only calls from imported calls when names collide.
    const localFunctionNames = new Set<string>();
    for (const declaration of sourceFile.getFunctions()) {
      const name = declaration.getName();
      if (name) localFunctionNames.add(name);
    }
    for (const variableStatement of sourceFile.getVariableStatements()) {
      for (const declaration of variableStatement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (nameNode.getKind() !== ts.SyntaxKind.Identifier) continue;
        const initializer = declaration.getInitializer();
        if (!initializer) continue;
        const initKind = initializer.getKind();
        if (
          initKind !== ts.SyntaxKind.ArrowFunction &&
          initKind !== ts.SyntaxKind.FunctionExpression
        ) continue;
        localFunctionNames.add(nameNode.getText());
      }
    }

    // Walk the raw TypeScript AST directly to avoid ts-morph wrapper allocation overhead.
    const emittedEdges = new Set<string>();
    const rawSourceFile = sourceFile.compilerNode;
    walkForCalls(rawSourceFile, undefined, undefined, fromFileId, graph, importedBindings, localFunctionNames, emittedEdges);
  }
}

// Walk the raw TypeScript AST, tracking the nearest enclosing named function/method.
// Uses ts.forEachChild to avoid allocating ts-morph wrapper nodes for every descendant.
//
// `enclosingFunctionName` is the graph-registered name for the nearest enclosing function,
// i.e. the suffix after `#fn:` in the node ID. For top-level functions and arrow/function-
// expression variables this is just the function name. For class methods it is
// `ClassName.methodName` to avoid collisions between same-named methods in different classes.
function walkForCalls(
  node: ts.Node,
  enclosingFunctionName: string | undefined,
  enclosingClassName: string | undefined,
  fileId: string,
  graph: Graph,
  importedBindings: Map<string, ImportedBinding>,
  localFunctionNames: Set<string>,
  emittedEdges: Set<string>,
): void {
  let currentFunctionName = enclosingFunctionName;
  let currentClassName = enclosingClassName;

  if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
    const named = node as ts.FunctionDeclaration;
    const nameNode = named.name;
    if (nameNode && ts.isIdentifier(nameNode)) {
      currentFunctionName = nameNode.text;
      currentClassName = undefined;
    }
  } else if (node.kind === ts.SyntaxKind.MethodDeclaration) {
    const named = node as ts.MethodDeclaration;
    const nameNode = named.name;
    if (nameNode && ts.isIdentifier(nameNode) && currentClassName !== undefined) {
      currentFunctionName = `${currentClassName}.${nameNode.text}`;
    }
  } else if (node.kind === ts.SyntaxKind.ClassDeclaration) {
    const classDecl = node as ts.ClassDeclaration;
    if (classDecl.name && ts.isIdentifier(classDecl.name)) {
      currentClassName = classDecl.name.text;
    }
  } else if (node.kind === ts.SyntaxKind.VariableDeclaration) {
    // Handle `const name = () => ...` and `const name = function() { ... }`.
    const varDecl = node as ts.VariableDeclaration;
    if (
      varDecl.initializer !== undefined &&
      (varDecl.initializer.kind === ts.SyntaxKind.ArrowFunction ||
        varDecl.initializer.kind === ts.SyntaxKind.FunctionExpression) &&
      ts.isIdentifier(varDecl.name)
    ) {
      currentFunctionName = (varDecl.name as ts.Identifier).text;
      currentClassName = undefined;
    }
  }

  if (node.kind === ts.SyntaxKind.CallExpression && currentFunctionName !== undefined) {
    const callExpr = node as ts.CallExpression;

    if (ts.isIdentifier(callExpr.expression)) {
      const calleeName = callExpr.expression.text;
      const callerFunctionId = `${fileId}#fn:${currentFunctionName}`;
      if (graph.hasNode(callerFunctionId)) {
        // Resolution heuristic for import vs. local:
        // - If the identifier is listed in importedBindings AND the file does not also
        //   declare a local function of the same name, prefer the import (cross-file edge).
        // - If both a local declaration and an import exist with the same name, the situation
        //   is genuinely ambiguous without a type checker. Emit the cross-file CALLS edge
        //   (safer to over-flag than under-flag; the IMPORTS fallback path already covers
        //   the local case via file-level reachability).
        // - If the identifier is only in localFunctionNames (no import), emit a same-file edge.
        const binding = importedBindings.get(calleeName);
        const isLocalOnly = localFunctionNames.has(calleeName) && binding === undefined;

        let targetFunctionId: string | undefined;

        if (isLocalOnly) {
          const sameFileFunctionId = `${fileId}#fn:${calleeName}`;
          if (graph.hasNode(sameFileFunctionId) && sameFileFunctionId !== callerFunctionId) {
            targetFunctionId = sameFileFunctionId;
          }
        } else if (binding !== undefined && binding.kind !== "namespace") {
          // Prefer import when present (with or without a same-name local).
          // Namespace imports are not simple function references — they are handled
          // below via PropertyAccessExpression (e.g. `ns.fn()`).
          const exportedName = binding.kind === "named" ? binding.exportedName : "default";
          const candidate = `${binding.sourceFileId}#fn:${exportedName}`;
          if (graph.hasNode(candidate)) {
            targetFunctionId = candidate;
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
    } else if (ts.isPropertyAccessExpression(callExpr.expression)) {
      // Handle namespace calls: `namespaceName.exportedFn(...)`.
      const propAccess = callExpr.expression as ts.PropertyAccessExpression;
      if (ts.isIdentifier(propAccess.expression)) {
        const namespaceName = (propAccess.expression as ts.Identifier).text;
        const methodName = propAccess.name.text;
        const namespaceBinding = importedBindings.get(namespaceName);
        if (namespaceBinding !== undefined && namespaceBinding.kind === "namespace") {
          const callerFunctionId = `${fileId}#fn:${currentFunctionName}`;
          if (graph.hasNode(callerFunctionId)) {
            const candidate = `${namespaceBinding.sourceFileId}#fn:${methodName}`;
            if (graph.hasNode(candidate)) {
              const edgeKey = `${callerFunctionId}→${candidate}`;
              if (!emittedEdges.has(edgeKey)) {
                emittedEdges.add(edgeKey);
                graph.addEdge({ kind: "CALLS", from: callerFunctionId, to: candidate });
              }
            }
          }
        }
      }
    }
  }

  ts.forEachChild(node, (child) => {
    walkForCalls(child, currentFunctionName, currentClassName, fileId, graph, importedBindings, localFunctionNames, emittedEdges);
  });
}

export function fileId(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}
