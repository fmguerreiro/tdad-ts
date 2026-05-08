import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/parser.js";
import { linkTests } from "../src/test-linker.js";
import { buildMap } from "../src/map-writer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryRoot = path.join(here, "fixtures/registry");
const registriesConfig = path.join(registryRoot, "tdad-registries.json");

function flaggedTests(
  entries: ReturnType<typeof buildMap>,
  source: string,
): { testFile: string; strategy: string }[] {
  const entry = entries.find((current) => current.source === source);
  if (!entry) return [];
  return entry.tests.map((test) => ({ testFile: test.testFile, strategy: test.strategy }));
}

describe("Next.js route-table extraction", () => {
  it("flags a test that references /dashboard against app/(group)/dashboard/page.tsx", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const flagged = flaggedTests(entries, "app/(group)/dashboard/page.tsx");
    expect(flagged).toEqual([
      { testFile: "tests/dashboard.e2e.spec.ts", strategy: "Route" },
    ]);
  });

  it("flags a test that references /api/health against app/api/health/route.ts", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const flagged = flaggedTests(entries, "app/api/health/route.ts");
    expect(flagged).toEqual([
      { testFile: "tests/api-health.e2e.spec.ts", strategy: "Route" },
    ]);
  });

  it("does not flag tests that do not reference the route", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const flagged = flaggedTests(entries, "app/(group)/dashboard/page.tsx");
    const names = flagged.map((current) => current.testFile);
    expect(names).not.toContain("tests/unrelated.spec.ts");
    expect(names).not.toContain("tests/api-health.e2e.spec.ts");
  });

  it("emits Route entries at the high tier", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const dashboardEntry = entries.find((current) => current.source === "app/(group)/dashboard/page.tsx");
    expect(dashboardEntry).toBeDefined();
    const routeTest = dashboardEntry!.tests.find((test) => test.strategy === "Route");
    expect(routeTest).toBeDefined();
    expect(routeTest!.tier).toEqual("high");
  });
});

describe("registry annotation", () => {
  it("flags email-render against src/templates/welcome.ts because the test calls buildEmail('welcome')", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const flagged = flaggedTests(entries, "src/templates/welcome.ts");
    const names = flagged.filter((current) => current.strategy === "Route").map((current) => current.testFile);
    expect(names).toEqual(["tests/email-render.spec.ts"]);
  });

  it("does not flag invoice template when no test references it", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
      registriesConfigPath: registriesConfig,
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const flagged = flaggedTests(entries, "src/templates/invoice.ts");
    const routeFlagged = flagged.filter((current) => current.strategy === "Route");
    expect(routeFlagged).toEqual([]);
  });
});

describe("graph remains usable without registries config", () => {
  it("returns an empty Route flag set when no config is provided", async () => {
    const graph = await buildGraph({
      root: registryRoot,
      tsConfigFilePath: path.join(registryRoot, "tsconfig.json"),
    });
    linkTests(graph);
    const entries = buildMap(graph);
    const dashboardEntry = entries.find((current) => current.source === "app/(group)/dashboard/page.tsx");
    if (!dashboardEntry) return;
    const routeTests = dashboardEntry.tests.filter((test) => test.strategy === "Route");
    expect(routeTests).toEqual([]);
  });
});
