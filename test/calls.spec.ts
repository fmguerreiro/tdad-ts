import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { linkTests } from "../src/test-linker.js";
import { impactedTests } from "../src/impact.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures/calls-edges");

// Fixture layout:
//   src/helper.ts       - exports compute()
//   src/operations.ts   - imports and CALLS compute()
//   src/standalone.ts   - imports compute but never calls it (passes it as a value)
//   src/operations.spec.ts - tests operations.ts
//   src/standalone.spec.ts - tests standalone.ts

async function indexed() {
  const graph = await buildGraph({ root: fixtureRoot });
  linkTests(graph);
  return graph;
}

describe("CALLS edge construction", () => {
  it("emits a CALLS edge from useCompute to compute across files", async () => {
    const graph = await indexed();
    const callerFunction = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "useCompute",
    );
    const calleeFunction = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "compute",
    );
    expect(callerFunction).toBeDefined();
    expect(calleeFunction).toBeDefined();

    const callsEdges = graph.outgoing(callerFunction!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toContain(calleeFunction!.id);
  });

  it("does not emit a CALLS edge from double to compute (double only passes compute as a value, never calls it)", async () => {
    const graph = await indexed();
    const bystander = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "double",
    );
    const calleeFunction = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "compute",
    );
    expect(bystander).toBeDefined();
    expect(calleeFunction).toBeDefined();

    const callsEdges = graph.outgoing(bystander!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).not.toContain(calleeFunction!.id);
  });
});

describe("transitive impact with CALLS edges", () => {
  it("flags operations.spec when helper changes, via function-level CALLS", async () => {
    const graph = await indexed();
    const helperFile = graph.files().find((file) => file.path === "src/helper.ts");
    expect(helperFile).toBeDefined();

    const impact = impactedTests(graph, [helperFile!.id]);
    const flagged = impact.get(helperFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toContain("src/operations.spec.ts");
  });

  it("does not flag standalone.spec when helper changes (standalone never calls compute)", async () => {
    const graph = await indexed();
    const helperFile = graph.files().find((file) => file.path === "src/helper.ts");
    expect(helperFile).toBeDefined();

    const impact = impactedTests(graph, [helperFile!.id]);
    const flagged = impact.get(helperFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).not.toContain("src/standalone.spec.ts");
  });
});
