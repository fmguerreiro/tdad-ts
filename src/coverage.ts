import fs from "node:fs";
import path from "node:path";
import { Graph } from "./graph.js";
import { fileId } from "./parser.js";

interface CoverageJson {
  version: 1;
  tests: Record<string, string[]>;
}

function isCoverageJson(value: unknown): value is CoverageJson {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return false;
  if (typeof candidate.tests !== "object" || candidate.tests === null) return false;
  const tests = candidate.tests as Record<string, unknown>;
  for (const sources of Object.values(tests)) {
    if (!Array.isArray(sources)) return false;
    for (const source of sources) {
      if (typeof source !== "string") return false;
    }
  }
  return true;
}

export function loadCoverageJson(coveragePath: string): Map<string, Set<string>> {
  const raw = fs.readFileSync(coveragePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse coverage JSON at ${coveragePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isCoverageJson(parsed)) {
    throw new Error(
      `coverage JSON at ${coveragePath} does not match expected shape { version: 1, tests: Record<string, string[]> }`,
    );
  }
  const result = new Map<string, Set<string>>();
  for (const [testFile, sources] of Object.entries(parsed.tests)) {
    result.set(testFile, new Set(sources));
  }
  return result;
}

export function emitCoverageEdges(
  graph: Graph,
  root: string,
  coverage: Map<string, Set<string>>,
): void {
  for (const [testFile, sources] of coverage) {
    const testId = fileId(path.relative(root, path.resolve(root, testFile)));
    if (!graph.hasNode(testId)) continue;
    for (const source of sources) {
      const sourceId = fileId(path.relative(root, path.resolve(root, source)));
      if (!graph.hasNode(sourceId)) continue;
      graph.addEdge({ kind: "COVERAGE", from: testId, to: sourceId });
    }
  }
}
