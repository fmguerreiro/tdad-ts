import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { linkTests, tier3DirectoryProximity } from "../src/test-linker.js";
import { buildMap, renderMap } from "../src/map-writer.js";
import { Graph } from "../src/graph.js";
import type { FileNode } from "../src/graph.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, "fixtures");

function importsEdge(graph: Awaited<ReturnType<typeof buildGraph>>, from: string, to: string): boolean {
  const fromNode = graph.files().find((file) => file.path === from);
  const toNode = graph.files().find((file) => file.path === to);
  if (!fromNode || !toNode) return false;
  return graph.outgoing(fromNode.id, "IMPORTS").some((edge) => edge.to === toNode.id);
}

function testsEdgeTargets(graph: Awaited<ReturnType<typeof buildGraph>>, testPath: string): string[] {
  const node = graph.files().find((file) => file.path === testPath);
  if (!node) return [];
  return graph
    .outgoing(node.id, "TESTS")
    .map((edge) => graph.getNode(edge.to))
    .filter((target) => target.kind === "File")
    .map((target) => (target as { path: string }).path)
    .sort();
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

describe("tsconfig path alias resolution", () => {
  const aliasedRoot = path.join(fixturesRoot, "aliased");

  it("links @/lib/util import to src/lib/util.ts when tsconfig is provided", async () => {
    const graph = await buildGraph({
      root: aliasedRoot,
      tsConfigFilePath: path.join(aliasedRoot, "tsconfig.json"),
    });
    expect(importsEdge(graph, "src/app/page.ts", "src/lib/util.ts")).toEqual(true);
  });

  it("does not link the alias import without tsconfig", async () => {
    const graph = await buildGraph({ root: aliasedRoot });
    expect(importsEdge(graph, "src/app/page.ts", "src/lib/util.ts")).toEqual(false);
  });
});

describe("tier 1c stem match across directories", () => {
  const tier1cRoot = path.join(fixturesRoot, "tier1c");

  it("links a test that imports a same-stem source in a different directory tree", async () => {
    const graph = await buildGraph({ root: tier1cRoot });
    linkTests(graph);
    expect(testsEdgeTargets(graph, "tests/unit/widget.test.ts")).toEqual([
      "src/components/widget.ts",
    ]);
  });

  it("does not link a non-importing test even if its stem could prefix-truncate to a source", async () => {
    const graph = await buildGraph({ root: tier1cRoot });
    linkTests(graph);
    expect(testsEdgeTargets(graph, "tests/unit/unrelated-widget.test.ts")).toEqual([]);
  });
});

describe("tier 3 directory proximity tie-break", () => {
  const tiebreakRoot = path.join(fixturesRoot, "tiebreak");

  it("picks the lexicographically smallest source when proximity scores tie", async () => {
    const graph = await buildGraph({ root: tiebreakRoot });
    linkTests(graph);
    expect(testsEdgeTargets(graph, "a/b/foo-bar.spec.ts")).toEqual(["a/aaa/foo.ts"]);
  });

  it("returns the same target regardless of candidate input order", () => {
    const test: FileNode = {
      kind: "File",
      id: "a/b/foo-bar.spec.ts",
      path: "a/b/foo-bar.spec.ts",
      contentHash: "h",
      isTest: true,
    };
    const aaaFoo: FileNode = {
      kind: "File",
      id: "a/aaa/foo.ts",
      path: "a/aaa/foo.ts",
      contentHash: "h",
      isTest: false,
    };
    const zzzFoo: FileNode = {
      kind: "File",
      id: "a/zzz/foo.ts",
      path: "a/zzz/foo.ts",
      contentHash: "h",
      isTest: false,
    };
    const forward = tier3DirectoryProximity(test, [aaaFoo, zzzFoo]);
    const reversed = tier3DirectoryProximity(test, [zzzFoo, aaaFoo]);
    expect(forward).toEqual([aaaFoo]);
    expect(reversed).toEqual([aaaFoo]);
  });
});

describe("cache reuse", () => {
  const basicRoot = path.join(fixturesRoot, "basic");

  it("returns a byte-identical map on cache hit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdad-cache-hit-"));
    const cachePath = path.join(tmpDir, "graph.json");

    const firstGraph = await buildGraph({ root: basicRoot, cachePath });
    linkTests(firstGraph);
    const firstMap = renderMap(buildMap(firstGraph));

    expect(fs.existsSync(cachePath)).toEqual(true);

    const secondGraph = await buildGraph({ root: basicRoot, cachePath });
    linkTests(secondGraph);
    const secondMap = renderMap(buildMap(secondGraph));

    expect(secondMap).toEqual(firstMap);
  });

  it("invalidates the cache when a source file changes", async () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tdad-cache-invalidate-"));
    copyDirectory(basicRoot, workRoot);
    const cachePath = path.join(workRoot, "..", "graph.json");

    const firstGraph = await buildGraph({ root: workRoot, cachePath });
    linkTests(firstGraph);
    const firstMap = renderMap(buildMap(firstGraph));
    const firstFunctionNames = [...firstGraph.nodes.values()]
      .filter((node) => node.kind === "Function" && node.file === "src/math.ts")
      .map((node) => (node as { name: string }).name)
      .sort();
    expect(firstFunctionNames).toEqual(["add", "multiply"]);
    expect(firstFunctionNames).not.toContain("subtract");

    const mathPath = path.join(workRoot, "src", "math.ts");
    const updated = `${fs.readFileSync(mathPath, "utf8")}
export function subtract(a: number, b: number): number {
  return a - b;
}
`;
    fs.writeFileSync(mathPath, updated, "utf8");

    const newSpec = `import { subtract } from "./math.js";
export function check(): number {
  return subtract(2, 1);
}
`;
    fs.writeFileSync(path.join(workRoot, "src", "math-subtract.spec.ts"), newSpec, "utf8");

    const secondGraph = await buildGraph({ root: workRoot, cachePath });
    linkTests(secondGraph);
    const secondMap = renderMap(buildMap(secondGraph));
    const secondFunctionNames = [...secondGraph.nodes.values()]
      .filter((node) => node.kind === "Function" && node.file === "src/math.ts")
      .map((node) => (node as { name: string }).name)
      .sort();
    expect(secondFunctionNames).toEqual(["add", "multiply", "subtract"]);
    expect(secondMap).not.toEqual(firstMap);
  });

  it("invalidates the cache when tsconfig changes even if sources do not", async () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tdad-cache-tsconfig-"));
    copyDirectory(path.join(fixturesRoot, "aliased"), workRoot);
    const cachePath = path.join(workRoot, "..", "graph.json");
    const tsConfigFilePath = path.join(workRoot, "tsconfig.json");

    const firstGraph = await buildGraph({ root: workRoot, tsConfigFilePath, cachePath });
    expect(importsEdge(firstGraph, "src/app/page.ts", "src/lib/util.ts")).toEqual(true);
    const firstFingerprint = JSON.parse(fs.readFileSync(cachePath, "utf8")).fingerprint;

    const tsConfigWithoutPaths = {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        baseUrl: ".",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*"],
    };
    fs.writeFileSync(tsConfigFilePath, JSON.stringify(tsConfigWithoutPaths, null, 2), "utf8");

    const secondGraph = await buildGraph({ root: workRoot, tsConfigFilePath, cachePath });
    expect(importsEdge(secondGraph, "src/app/page.ts", "src/lib/util.ts")).toEqual(false);
    const secondFingerprint = JSON.parse(fs.readFileSync(cachePath, "utf8")).fingerprint;
    expect(secondFingerprint).not.toEqual(firstFingerprint);
  });
});

describe("Graph.addEdge deduplication", () => {
  it("records only one edge when the same (kind, from, to) triple is added twice", () => {
    const graph = new Graph();
    graph.addNode({ kind: "File", id: "a.ts", path: "a.ts", contentHash: "h1", isTest: false });
    graph.addNode({ kind: "File", id: "b.ts", path: "b.ts", contentHash: "h2", isTest: false });

    graph.addEdge({ kind: "IMPORTS", from: "a.ts", to: "b.ts" });
    graph.addEdge({ kind: "IMPORTS", from: "a.ts", to: "b.ts" });

    expect(graph.outgoing("a.ts", "IMPORTS")).toEqual([
      { kind: "IMPORTS", from: "a.ts", to: "b.ts" },
    ]);
    expect(graph.incoming("b.ts", "IMPORTS")).toEqual([
      { kind: "IMPORTS", from: "a.ts", to: "b.ts" },
    ]);
  });
});
