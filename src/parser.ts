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
import { emitCoverageEdges, loadCoverageJson } from "./coverage.js";

export interface IndexOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  tsConfigFilePath?: string;
  cachePath?: string;
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
