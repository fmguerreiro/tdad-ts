import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { buildMap } from "../src/map-writer.js";
import { Graph } from "../src/graph.js";
import { emitCoverageEdges } from "../src/coverage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const coverageRoot = path.join(here, "fixtures/coverage");
const coverageJsonPath = path.join(coverageRoot, "coverage.json");

describe("Coverage strategy", () => {
  it("maps src/used.ts to tests/some.spec.ts at medium tier when coverage JSON is provided", async () => {
    const graph = await buildGraph({
      root: coverageRoot,
      coveragePath: coverageJsonPath,
    });
    const entries = buildMap(graph);
    const usedEntry = entries.find((entry) => entry.source === "src/used.ts");
    expect(usedEntry).toBeDefined();
    const coverageHits = usedEntry!.tests.filter((hit) => hit.strategy === "Coverage");
    expect(coverageHits).toEqual([
      {
        testFile: "tests/some.spec.ts",
        strategy: "Coverage",
        score: 0.71,
        tier: "medium",
      },
    ]);
  });

  it("produces no entry for src/unused.ts when it appears in no coverage test mapping", async () => {
    const graph = await buildGraph({
      root: coverageRoot,
      coveragePath: coverageJsonPath,
    });
    const entries = buildMap(graph);
    const unusedEntry = entries.find((entry) => entry.source === "src/unused.ts");
    expect(unusedEntry).toBeUndefined();
  });

  it("produces no Coverage entries without --coverage flag", async () => {
    const graph = await buildGraph({ root: coverageRoot });
    const entries = buildMap(graph);
    for (const entry of entries) {
      const coverageHits = entry.tests.filter((hit) => hit.strategy === "Coverage");
      expect(coverageHits).toEqual([]);
    }
  });

  it("invalidates cache when coverage JSON changes", async () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tdad-coverage-cache-"));
    const cachePath = path.join(workRoot, "graph.json");

    const firstGraph = await buildGraph({
      root: coverageRoot,
      coveragePath: coverageJsonPath,
      cachePath,
    });
    const firstFingerprint = JSON.parse(fs.readFileSync(cachePath, "utf8")).fingerprint;
    const firstEntries = buildMap(firstGraph);
    const firstUsed = firstEntries.find((entry) => entry.source === "src/used.ts");
    expect(firstUsed?.tests.some((hit) => hit.strategy === "Coverage")).toEqual(true);

    const altCoveragePath = path.join(workRoot, "coverage-alt.json");
    fs.writeFileSync(
      altCoveragePath,
      JSON.stringify({ version: 1, tests: {} }),
      "utf8",
    );

    const secondGraph = await buildGraph({
      root: coverageRoot,
      coveragePath: altCoveragePath,
      cachePath,
    });
    const secondFingerprint = JSON.parse(fs.readFileSync(cachePath, "utf8")).fingerprint;
    expect(secondFingerprint).not.toEqual(firstFingerprint);

    const secondEntries = buildMap(secondGraph);
    const secondUsed = secondEntries.find((entry) => entry.source === "src/used.ts");
    expect(secondUsed).toBeUndefined();
  });
});

describe("emitCoverageEdges path handling", () => {
  it("resolves forward-slash relative paths in coverage JSON to the correct node IDs", () => {
    const graph = new Graph();
    graph.addNode({
      kind: "File",
      id: "tests/some.spec.ts",
      path: "tests/some.spec.ts",
      contentHash: "h1",
      isTest: true,
    });
    graph.addNode({
      kind: "File",
      id: "src/used.ts",
      path: "src/used.ts",
      contentHash: "h2",
      isTest: false,
    });

    const coverage = new Map<string, Set<string>>();
    coverage.set("tests/some.spec.ts", new Set(["src/used.ts"]));

    emitCoverageEdges(graph, coverage, "/fake/coverage.json");

    expect(graph.outgoing("tests/some.spec.ts", "COVERAGE")).toEqual([
      { kind: "COVERAGE", from: "tests/some.spec.ts", to: "src/used.ts" },
    ]);
  });

  it("throws when coverage JSON references a test path not present in the graph", () => {
    const graph = new Graph();
    graph.addNode({
      kind: "File",
      id: "src/used.ts",
      path: "src/used.ts",
      contentHash: "h2",
      isTest: false,
    });

    const coverage = new Map<string, Set<string>>();
    coverage.set("tests/missing.spec.ts", new Set(["src/used.ts"]));

    expect(() => emitCoverageEdges(graph, coverage, "/fake/coverage.json")).toThrow(
      "coverage references unknown test 'tests/missing.spec.ts' (from /fake/coverage.json)",
    );
  });

  it("throws when coverage JSON references a source path not present in the graph", () => {
    const graph = new Graph();
    graph.addNode({
      kind: "File",
      id: "tests/some.spec.ts",
      path: "tests/some.spec.ts",
      contentHash: "h1",
      isTest: true,
    });

    const coverage = new Map<string, Set<string>>();
    coverage.set("tests/some.spec.ts", new Set(["src/missing.ts"]));

    expect(() => emitCoverageEdges(graph, coverage, "/fake/coverage.json")).toThrow(
      "coverage references unknown source 'src/missing.ts' (from /fake/coverage.json)",
    );
  });
});
