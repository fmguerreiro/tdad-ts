import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { linkTests } from "../src/test-linker.js";
import { buildMap } from "../src/map-writer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures/basic");

async function indexed() {
  const graph = await buildGraph({ root: fixtureRoot });
  linkTests(graph);
  return graph;
}

describe("graph indexing", () => {
  it("includes every fixture file as a File node", async () => {
    const graph = await indexed();
    const paths = graph.files().map((file) => file.path).sort();
    expect(paths).toEqual([
      "src/__tests__/report.ts",
      "src/calculator.test.ts",
      "src/calculator.ts",
      "src/math.spec.ts",
      "src/math.ts",
      "src/report.ts",
      "src/unrelated.spec.ts",
      "src/unrelated.ts",
    ]);
  });

  it("flags spec/test/__tests__ files as test files", async () => {
    const graph = await indexed();
    const tests = graph.files().filter((file) => file.isTest).map((file) => file.path).sort();
    expect(tests).toEqual([
      "src/__tests__/report.ts",
      "src/calculator.test.ts",
      "src/math.spec.ts",
      "src/unrelated.spec.ts",
    ]);
  });

  it("links each test to exactly its sibling source", async () => {
    const graph = await indexed();
    const links = new Map<string, string[]>();
    for (const file of graph.files()) {
      if (!file.isTest) continue;
      const targets = graph
        .outgoing(file.id, "TESTS")
        .map((edge) => graph.getNode(edge.to))
        .filter((node) => node.kind === "File")
        .map((node) => (node as { path: string }).path)
        .sort();
      links.set(file.path, targets);
    }
    expect(Object.fromEntries(links)).toEqual({
      "src/math.spec.ts": ["src/math.ts"],
      "src/calculator.test.ts": ["src/calculator.ts"],
      "src/__tests__/report.ts": ["src/report.ts"],
      "src/unrelated.spec.ts": ["src/unrelated.ts"],
    });
  });
});

describe("impact map", () => {
  it("flags only math.spec for changes to math.ts (with transitive reaches)", async () => {
    const graph = await indexed();
    const entries = buildMap(graph);
    const mathEntry = entries.find((entry) => entry.source === "src/math.ts");
    expect(mathEntry).toBeDefined();
    const tests = mathEntry!.tests.map((test) => ({
      file: test.testFile,
      strategy: test.strategy,
      tier: test.tier,
    }));
    const direct = tests.filter((test) => test.strategy === "Direct");
    expect(direct).toEqual([{ file: "src/math.spec.ts", strategy: "Direct", tier: "high" }]);
    const transitive = tests.filter((test) => test.strategy === "Transitive").map((test) => test.file).sort();
    expect(transitive).toEqual(["src/__tests__/report.ts", "src/calculator.test.ts"]);
  });

  it("does not flag unrelated tests for math.ts", async () => {
    const graph = await indexed();
    const entries = buildMap(graph);
    const mathEntry = entries.find((entry) => entry.source === "src/math.ts");
    const flagged = mathEntry!.tests.map((test) => test.testFile);
    expect(flagged).not.toContain("src/unrelated.spec.ts");
  });

  it("flags only unrelated.spec for changes to unrelated.ts", async () => {
    const graph = await indexed();
    const entries = buildMap(graph);
    const unrelated = entries.find((entry) => entry.source === "src/unrelated.ts");
    expect(unrelated).toBeDefined();
    const flagged = unrelated!.tests.map((test) => test.testFile).sort();
    expect(flagged).toEqual(["src/unrelated.spec.ts"]);
  });
});
