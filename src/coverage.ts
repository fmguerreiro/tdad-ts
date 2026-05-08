import fs from "node:fs";
import { Graph } from "./graph.js";
import { fileId } from "./parser.js";

interface CoverageJson {
  version: 1;
  tests: Record<string, string[]>;
}

function isCoverageJson(value: unknown): value is CoverageJson {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || !("tests" in value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.tests !== "object" || value.tests === null) return false;
  return Object.values(value.tests).every(
    (sources) => Array.isArray(sources) && sources.every((source) => typeof source === "string"),
  );
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
  coverage: Map<string, Set<string>>,
  coveragePath: string,
): void {
  for (const [testFile, sources] of coverage) {
    const testId = fileId(testFile);
    if (!graph.hasNode(testId)) {
      throw new Error(
        `coverage references unknown test '${testFile}' (from ${coveragePath}); regenerate coverage data or update the project glob`,
      );
    }
    for (const source of sources) {
      const sourceId = fileId(source);
      if (!graph.hasNode(sourceId)) {
        throw new Error(
          `coverage references unknown source '${source}' (from ${coveragePath}); regenerate coverage data or update the project glob`,
        );
      }
      graph.addEdge({ kind: "COVERAGE", from: testId, to: sourceId });
    }
  }
}
