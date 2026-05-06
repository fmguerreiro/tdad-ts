import path from "node:path";
import { Graph, push, type FileNode } from "./graph.js";
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
    const matches = resolveTargets(test, sources, sourcesByStem, graph);
    for (const match of matches) {
      graph.addEdge({ kind: "TESTS", from: test.id, to: match.id });
    }
  }
}

function indexByStem(sources: Map<string, FileNode>): Map<string, FileNode[]> {
  const exact = new Map<string, FileNode[]>();
  for (const file of sources.values()) {
    const stem = baseStem(file.path);
    push(exact, stem, file);
  }
  return exact;
}

function resolveTargets(
  test: FileNode,
  sources: Map<string, FileNode>,
  sourcesByStem: Map<string, FileNode[]>,
  graph: Graph,
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

  // Tier 1c: exact stem match anywhere, but only if the test directly imports
  // the source. Catches projects with a separate tests/ directory that mirrors
  // source names (e.g. tests/unit/foo.test.ts paired with components/foo.ts).
  const stemMatches = sourcesByStem.get(stem);
  if (stemMatches && stemMatches.length > 0) {
    const importedTargets: FileNode[] = [];
    for (const candidate of stemMatches) {
      if (testImportsSource(graph, test.id, candidate.id)) {
        importedTargets.push(candidate);
      }
    }
    if (importedTargets.length > 0) return importedTargets;
  }

  // Tier 2: progressive prefix truncation, filtered by directory proximity.
  let candidate = stem;
  while (candidate.length > 0) {
    const matches = sourcesByStem.get(candidate);
    if (matches && matches.length > 0) {
      return tier3DirectoryProximity(test, matches);
    }
    const next = candidate.replace(/[._-][^._-]+$/, "");
    if (next === candidate) break;
    candidate = next;
  }

  return [];
}

// Tier 1c walks only direct IMPORTS edges, so a test that imports through a
// `src/index.ts` barrel (e.g. `import { renderWidget } from '../../src'`)
// will miss the actual source module. Barrel-walking is deferred.
function testImportsSource(graph: Graph, testId: string, sourceId: string): boolean {
  for (const edge of graph.outgoing(testId, "IMPORTS")) {
    if (edge.to === sourceId) return true;
  }
  return false;
}

export function tier3DirectoryProximity(test: FileNode, candidates: FileNode[]): FileNode[] {
  // Reject candidates that share no directory ancestry with the test - prevents
  // prefix truncation from pinning unrelated files across the tree.
  const close = candidates.filter(
    (candidate) => sharedPrefixDepth(test.path, candidate.path) >= 1,
  );
  if (close.length === 0) return [];
  if (close.length === 1) return close;
  let bestScore = -1;
  let bestGroup: FileNode[] = [];
  for (const candidate of close) {
    const score = sharedPrefixDepth(test.path, candidate.path);
    if (score > bestScore) {
      bestScore = score;
      bestGroup = [candidate];
    } else if (score === bestScore) {
      bestGroup.push(candidate);
    }
  }
  bestGroup.sort((a, b) => a.path.localeCompare(b.path));
  const winner = bestGroup[0];
  if (!winner) throw new Error("tier3DirectoryProximity: empty bestGroup despite non-empty close");
  return [winner];
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
