import path from "node:path";
import { Graph, type FileNode } from "./graph.js";
import { isTestPath, testStem } from "./test-detect.js";

export function linkTests(graph: Graph): void {
  const sources = new Map<string, FileNode>();
  const tests: FileNode[] = [];
  for (const file of graph.files()) {
    if (file.isTest) tests.push(file);
    else sources.set(file.path, file);
  }

  const sourcesByStem = indexByStem(sources);

  for (const test of tests) {
    const matches = resolveTargets(test, sources, sourcesByStem);
    for (const match of matches) {
      graph.addEdge({ kind: "TESTS", from: test.id, to: match.id });
    }
  }
}

interface StemIndex {
  exact: Map<string, FileNode[]>;
}

function indexByStem(sources: Map<string, FileNode>): StemIndex {
  const exact = new Map<string, FileNode[]>();
  for (const file of sources.values()) {
    const stem = baseStem(file.path);
    push(exact, stem, file);
  }
  return { exact };
}

function resolveTargets(
  test: FileNode,
  sources: Map<string, FileNode>,
  index: StemIndex,
): FileNode[] {
  const stem = testStem(test.path);
  const dir = path.posix.dirname(test.path);

  // Tier 1: naming convention - same directory, exact stem.
  const sameDir = sources.get(path.posix.join(dir, stem) + ".ts")
    ?? sources.get(path.posix.join(dir, stem) + ".tsx");
  if (sameDir) return [sameDir];

  // Tier 1b: __tests__/foo.spec.ts -> ../foo.ts
  if (path.posix.basename(dir) === "__tests__" || path.posix.basename(dir) === "tests") {
    const parent = path.posix.dirname(dir);
    const parentMatch = sources.get(path.posix.join(parent, stem) + ".ts")
      ?? sources.get(path.posix.join(parent, stem) + ".tsx");
    if (parentMatch) return [parentMatch];
  }

  // Tier 2: progressive prefix truncation across whole tree.
  let candidate = stem;
  while (candidate.length > 0) {
    const matches = index.exact.get(candidate);
    if (matches && matches.length > 0) {
      return tier3DirectoryProximity(test, matches);
    }
    const next = candidate.replace(/[._-][^._-]+$/, "");
    if (next === candidate) break;
    candidate = next;
  }

  return [];
}

function tier3DirectoryProximity(test: FileNode, candidates: FileNode[]): FileNode[] {
  if (candidates.length === 1) return candidates;
  let best: FileNode | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = sharedPrefixDepth(test.path, candidate.path);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best ? [best] : [];
}

function sharedPrefixDepth(a: string, b: string): number {
  const segmentsA = a.split("/").slice(0, -1);
  const segmentsB = b.split("/").slice(0, -1);
  let depth = 0;
  while (
    depth < segmentsA.length &&
    depth < segmentsB.length &&
    segmentsA[depth] === segmentsB[depth]
  ) {
    depth += 1;
  }
  return depth;
}

function baseStem(filePath: string): string {
  if (isTestPath(filePath)) return testStem(filePath);
  const base = path.posix.basename(filePath);
  const lastDot = base.lastIndexOf(".");
  return lastDot === -1 ? base : base.slice(0, lastDot);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
