import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { linkTests } from "../src/test-linker.js";
import { impactedTests } from "../src/impact.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Fixture: calls-edges
//   src/helper.ts       - exports compute()
//   src/operations.ts   - imports and CALLS compute()
//   src/standalone.ts   - imports compute but never calls it (passes it as a value)
//   src/operations.spec.ts - tests operations.ts
//   src/standalone.spec.ts - tests standalone.ts
const callsEdgesRoot = path.join(here, "fixtures/calls-edges");

async function indexed() {
  const graph = await buildGraph({ root: callsEdgesRoot });
  linkTests(graph);
  return graph;
}

// Fixture: method-calls
//   src/formatter.ts    - exports format()
//   src/processor.ts    - Processor class with process() method that calls format()
//   src/processor.spec.ts - tests processor.ts
const methodCallsRoot = path.join(here, "fixtures/method-calls");

async function indexedMethods() {
  const graph = await buildGraph({ root: methodCallsRoot });
  linkTests(graph);
  return graph;
}

// Fixture: arrow-calls
//   src/helper.ts        - exports multiply()
//   src/transforms.ts    - exports triple (arrow fn) and tripleExpr (fn expr) that call multiply()
//   src/transforms.spec.ts - tests transforms.ts
const arrowCallsRoot = path.join(here, "fixtures/arrow-calls");

async function indexedArrows() {
  const graph = await buildGraph({ root: arrowCallsRoot });
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
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeFunction!.id]);
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
    expect(callsEdges.map((edge) => edge.to)).toEqual([]);
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

    expect(flaggedFiles).toEqual(["src/operations.spec.ts"]);
  });

  it("does not flag standalone.spec when helper changes (standalone never calls compute)", async () => {
    const graph = await indexed();
    const helperFile = graph.files().find((file) => file.path === "src/helper.ts");
    expect(helperFile).toBeDefined();

    const impact = impactedTests(graph, [helperFile!.id]);
    const flagged = impact.get(helperFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toEqual(["src/operations.spec.ts"]);
  });
});

describe("CALLS edges from class methods", () => {
  it("emits a CALLS edge from Processor.process to format across files", async () => {
    const graph = await indexedMethods();
    const methodNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "Processor.process",
    );
    const calleeNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "format",
    );
    expect(methodNode).toBeDefined();
    expect(calleeNode).toBeDefined();

    const callsEdges = graph.outgoing(methodNode!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeNode!.id]);
  });

  it("flags processor.spec as Transitive when formatter changes, via method CALLS edge", async () => {
    const graph = await indexedMethods();
    const formatterFile = graph.files().find((file) => file.path === "src/formatter.ts");
    expect(formatterFile).toBeDefined();

    const impact = impactedTests(graph, [formatterFile!.id]);
    const flagged = impact.get(formatterFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toEqual(["src/processor.spec.ts"]);
  });
});

describe("CALLS edges from arrow and function-expression variables", () => {
  it("emits a CALLS edge from triple (arrow fn) to multiply across files", async () => {
    const graph = await indexedArrows();
    const arrowNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "triple",
    );
    const calleeNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "multiply",
    );
    expect(arrowNode).toBeDefined();
    expect(calleeNode).toBeDefined();

    const callsEdges = graph.outgoing(arrowNode!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeNode!.id]);
  });

  it("emits a CALLS edge from tripleExpr (function expression) to multiply across files", async () => {
    const graph = await indexedArrows();
    const fnExprNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "tripleExpr",
    );
    const calleeNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "multiply",
    );
    expect(fnExprNode).toBeDefined();
    expect(calleeNode).toBeDefined();

    const callsEdges = graph.outgoing(fnExprNode!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeNode!.id]);
  });

  it("flags transforms.spec as Transitive when helper changes, via arrow function CALLS edge", async () => {
    const graph = await indexedArrows();
    const helperFile = graph.files().find((file) => file.path === "src/helper.ts");
    expect(helperFile).toBeDefined();

    const impact = impactedTests(graph, [helperFile!.id]);
    const flagged = impact.get(helperFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toEqual(["src/transforms.spec.ts"]);
  });
});

// Fixture: default-import-calls
//   src/formatter.ts  - exports default function format()
//   src/runner.ts     - imports format as default, calls format()
//   src/runner.spec.ts - tests runner.ts
const defaultImportRoot = path.join(here, "fixtures/default-import-calls");

async function indexedDefaultImport() {
  const graph = await buildGraph({ root: defaultImportRoot });
  linkTests(graph);
  return graph;
}

describe("CALLS edges from default imports", () => {
  it("emits a CALLS edge from run to the default-exported format function", async () => {
    const graph = await indexedDefaultImport();
    const callerNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "run",
    );
    const calleeNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "default",
    );
    expect(callerNode).toBeDefined();
    expect(calleeNode).toBeDefined();

    const callsEdges = graph.outgoing(callerNode!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeNode!.id]);
  });

  it("flags runner.spec as Transitive when formatter changes, via default-import CALLS edge", async () => {
    const graph = await indexedDefaultImport();
    const formatterFile = graph.files().find((file) => file.path === "src/formatter.ts");
    expect(formatterFile).toBeDefined();

    const impact = impactedTests(graph, [formatterFile!.id]);
    const flagged = impact.get(formatterFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toEqual(["src/runner.spec.ts"]);
  });
});

// Fixture: namespace-import-calls
//   src/math.ts       - exports add()
//   src/calculator.ts - imports * as MathUtils, calls MathUtils.add()
//   src/calculator.spec.ts - tests calculator.ts
const namespaceImportRoot = path.join(here, "fixtures/namespace-import-calls");

async function indexedNamespaceImport() {
  const graph = await buildGraph({ root: namespaceImportRoot });
  linkTests(graph);
  return graph;
}

describe("CALLS edges from namespace imports", () => {
  it("emits a CALLS edge from sum to add via namespace import MathUtils.add()", async () => {
    const graph = await indexedNamespaceImport();
    const callerNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "sum",
    );
    const calleeNode = [...graph.nodes.values()].find(
      (node) => node.kind === "Function" && node.name === "add",
    );
    expect(callerNode).toBeDefined();
    expect(calleeNode).toBeDefined();

    const callsEdges = graph.outgoing(callerNode!.id, "CALLS");
    expect(callsEdges.map((edge) => edge.to)).toEqual([calleeNode!.id]);
  });

  it("flags calculator.spec as Transitive when math changes, via namespace CALLS edge", async () => {
    const graph = await indexedNamespaceImport();
    const mathFile = graph.files().find((file) => file.path === "src/math.ts");
    expect(mathFile).toBeDefined();

    const impact = impactedTests(graph, [mathFile!.id]);
    const flagged = impact.get(mathFile!.id) ?? [];
    const flaggedFiles = flagged.map((entry) => entry.testFile).sort();

    expect(flaggedFiles).toEqual(["src/calculator.spec.ts"]);
  });
});
