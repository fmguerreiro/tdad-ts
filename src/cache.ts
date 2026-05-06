// fingerprint already absorbs tsconfig content (see snapshotFilesystem signature):
// when buildGraph passes a tsConfigFilePath, its hash is folded into the manifest
// fingerprint so cache hits invalidate on tsconfig edits as well as source edits.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Graph, type Edge, type GraphNode } from "./graph.js";

interface CacheFileSnapshot {
  path: string;
  contentHash: string;
}

interface CachePayload {
  version: 1;
  fingerprint: string;
  files: CacheFileSnapshot[];
  nodes: GraphNode[];
  edges: Edge[];
}

export interface FilesystemSnapshot {
  files: CacheFileSnapshot[];
  fingerprint: string;
  filesByPath: Map<string, string>;
}

export async function snapshotFilesystem(
  root: string,
  patterns: string[],
  ignore: string[],
  tsConfigHash?: string,
): Promise<FilesystemSnapshot> {
  const absoluteRoot = path.resolve(root);
  const found = await fg(patterns, {
    cwd: absoluteRoot,
    ignore,
    absolute: true,
    dot: false,
  });
  const files: CacheFileSnapshot[] = [];
  for (const absolute of found) {
    const relative = path.relative(absoluteRoot, absolute).split(path.sep).join("/");
    const content = fs.readFileSync(absolute, "utf8");
    files.push({ path: relative, contentHash: hashContent(content) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = manifestFingerprint(files, tsConfigHash);
  const filesByPath = new Map(files.map((file) => [file.path, file.contentHash]));
  return { files, fingerprint, filesByPath };
}

export function loadCache(cachePath: string): CachePayload | undefined {
  if (!fs.existsSync(cachePath)) return undefined;
  const raw = fs.readFileSync(cachePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse cache at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isCachePayload(parsed)) return undefined;
  return parsed;
}

export function saveCache(
  cachePath: string,
  graph: Graph,
  snapshot: FilesystemSnapshot,
): void {
  const payload: CachePayload = {
    version: 1,
    fingerprint: snapshot.fingerprint,
    files: snapshot.files,
    nodes: [...graph.nodes.values()],
    edges: collectEdges(graph),
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(payload), "utf8");
}

export function rehydrate(payload: CachePayload): Graph {
  const graph = new Graph();
  for (const node of payload.nodes) graph.addNode(node);
  for (const edge of payload.edges) graph.addEdge(edge);
  return graph;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function isCachePayload(value: unknown): value is CachePayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.fingerprint === "string" &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

function manifestFingerprint(
  files: CacheFileSnapshot[],
  tsConfigHash: string | undefined,
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contentHash);
    hash.update("\n");
  }
  if (tsConfigHash !== undefined) {
    hash.update("tsconfig\0");
    hash.update(tsConfigHash);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 32);
}

function collectEdges(graph: Graph): Edge[] {
  const edges: Edge[] = [];
  for (const list of graph.edgesOut.values()) {
    for (const edge of list) edges.push(edge);
  }
  return edges;
}
