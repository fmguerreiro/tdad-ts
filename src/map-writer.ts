import fs from "node:fs";
import { Graph } from "./graph.js";
import { impactedTests, type ImpactOptions, type ImpactedTest } from "./impact.js";

export interface MapEntry {
  source: string;
  tests: ImpactedTest[];
}

export function buildMap(graph: Graph, options: ImpactOptions = {}): MapEntry[] {
  const sources = graph.files().filter((file) => !file.isTest);
  const sourceIds = sources.map((file) => file.id);
  const impact = impactedTests(graph, sourceIds, options);

  const entries: MapEntry[] = [];
  for (const file of sources) {
    const tests = impact.get(file.id) ?? [];
    if (tests.length === 0) continue;
    entries.push({ source: file.path, tests });
  }
  entries.sort((a, b) => a.source.localeCompare(b.source));
  return entries;
}

export function renderMap(entries: MapEntry[]): string {
  const lines: string[] = [];
  lines.push("# tdad-ts test_map.txt");
  lines.push("# format: <source> -> <test> [<strategy>:<score>:<tier>]");
  lines.push("");
  for (const entry of entries) {
    for (const test of entry.tests) {
      lines.push(
        `${entry.source} -> ${test.testFile} [${test.strategy}:${test.score.toFixed(2)}:${test.tier}]`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function writeMap(filePath: string, entries: MapEntry[]): void {
  fs.writeFileSync(filePath, renderMap(entries), "utf8");
}
