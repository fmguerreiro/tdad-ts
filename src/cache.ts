import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Graph, type Edge, type GraphNode } from "./graph.js";
import { isTestPath } from "./test-detect.js";

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
  const fingerprint = manifestFingerprint(files);
  const filesByPath = new Map(files.map((file) => [file.path, file.contentHash]));
  return { files, fingerprint, filesByPath };
}

export function loadCache(cachePath: string): CachePayload | undefined {
  if (!fs.existsSync(cachePath)) return undefined;
  const raw = fs.readFileSync(cachePath, "utf8");
  const parsed = JSON.parse(raw) as CachePayload;
  if (parsed.version !== 1) return undefined;
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

function manifestFingerprint(files: CacheFileSnapshot[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contentHash);
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
