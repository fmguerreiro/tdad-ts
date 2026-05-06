import { Graph, type FileNode } from "./graph.js";

export type Strategy = "Direct" | "Transitive" | "Imports";
export type Tier = "high" | "medium" | "low";

export interface StrategyConfig {
  weight: number;
  confidence: number;
}

// TODO: add Coverage strategy once we wire real test coverage data (e.g. v8/istanbul
// coverage maps). Static same-directory heuristic is too coarse and fires on every
// sibling test, swamping real signal.
export const DEFAULT_STRATEGIES: Record<Strategy, StrategyConfig> = {
  Direct: { weight: 0.95, confidence: 1.0 },
  Transitive: { weight: 0.7, confidence: 0.56 },
  Imports: { weight: 0.5, confidence: 0.45 },
};

export const CONFIDENCE_WEIGHT = 0.3;
export const TRANSITIVE_MAX_HOPS = 3;
export const TIER_HIGH = 0.8;
export const TIER_MEDIUM = 0.5;
export const DEFAULT_MAX_TESTS = 50;

export interface ImpactedTest {
  testFile: string;
  strategy: Strategy;
  score: number;
  tier: Tier;
}

export interface ImpactOptions {
  maxTests?: number;
  strategies?: Record<Strategy, StrategyConfig>;
  transitiveMaxHops?: number;
}

export function impactedTests(
  graph: Graph,
  changedFiles: string[],
  options: ImpactOptions = {},
): Map<string, ImpactedTest[]> {
  const strategies = options.strategies ?? DEFAULT_STRATEGIES;
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxHops = options.transitiveMaxHops ?? TRANSITIVE_MAX_HOPS;

  const out = new Map<string, ImpactedTest[]>();
  for (const changed of changedFiles) {
    const file = graph.nodes.get(changed);
    if (!file || file.kind !== "File") {
      out.set(changed, []);
      continue;
    }

    const candidates = new Map<string, ImpactedTest>();
    direct(graph, file, strategies.Direct, candidates);
    transitive(graph, file, strategies.Transitive, maxHops, candidates);
    imports(graph, file, strategies.Imports, candidates);

    const sorted = [...candidates.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.testFile.localeCompare(b.testFile);
      })
      .slice(0, maxTests);
    out.set(changed, sorted);
  }
  return out;
}

function direct(
  graph: Graph,
  file: FileNode,
  config: StrategyConfig,
  acc: Map<string, ImpactedTest>,
): void {
  for (const edge of graph.incoming(file.id, "TESTS")) {
    const test = graph.getNode(edge.from);
    if (test.kind !== "Test" && test.kind !== "File") continue;
    const testFile = test.kind === "File" ? test.path : (graph.getNode(test.file) as FileNode).path;
    record(acc, testFile, "Direct", scoreOf(config));
  }
  for (const node of graph.nodes.values()) {
    if (node.kind !== "File" || !node.isTest) continue;
    for (const edge of graph.outgoing(node.id, "TESTS")) {
      if (edge.to === file.id) {
        record(acc, node.path, "Direct", scoreOf(config));
      } else {
        const target = graph.getNode(edge.to);
        if ((target.kind === "Function" || target.kind === "Class") && target.file === file.id) {
          record(acc, node.path, "Direct", scoreOf(config));
        }
      }
    }
  }
}

function transitive(
  graph: Graph,
  file: FileNode,
  config: StrategyConfig,
  maxHops: number,
  acc: Map<string, ImpactedTest>,
): void {
  // BFS over reverse IMPORTS up to maxHops; tests linking to any reached file count.
  const reached = new Set<string>();
  let frontier = new Set<string>([file.id]);
  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const edge of graph.incoming(id, "IMPORTS")) {
        if (!reached.has(edge.from) && edge.from !== file.id) {
          reached.add(edge.from);
          next.add(edge.from);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  for (const importerId of reached) {
    const importer = graph.getNode(importerId);
    if (importer.kind !== "File") continue;
    addTestsForFile(graph, importer, "Transitive", config, acc);
  }
}

function imports(
  graph: Graph,
  file: FileNode,
  config: StrategyConfig,
  acc: Map<string, ImpactedTest>,
): void {
  for (const edge of graph.incoming(file.id, "IMPORTS")) {
    const importer = graph.getNode(edge.from);
    if (importer.kind !== "File") continue;
    if (importer.isTest) {
      record(acc, importer.path, "Imports", scoreOf(config));
    }
  }
}

function addTestsForFile(
  graph: Graph,
  file: FileNode,
  strategy: Strategy,
  config: StrategyConfig,
  acc: Map<string, ImpactedTest>,
): void {
  for (const node of graph.nodes.values()) {
    if (node.kind !== "File" || !node.isTest) continue;
    for (const edge of graph.outgoing(node.id, "TESTS")) {
      const target = graph.getNode(edge.to);
      const targetFileId = target.kind === "File" ? target.id : "file" in target ? target.file : null;
      if (targetFileId === file.id) {
        record(acc, node.path, strategy, scoreOf(config));
        break;
      }
    }
  }
}

function record(
  acc: Map<string, ImpactedTest>,
  testFile: string,
  strategy: Strategy,
  score: number,
): void {
  const existing = acc.get(testFile);
  if (!existing || score > existing.score) {
    acc.set(testFile, { testFile, strategy, score, tier: tierOf(score) });
  }
}

function scoreOf(config: StrategyConfig): number {
  return (1 - CONFIDENCE_WEIGHT) * config.weight + CONFIDENCE_WEIGHT * config.confidence;
}

function tierOf(score: number): Tier {
  if (score >= TIER_HIGH) return "high";
  if (score >= TIER_MEDIUM) return "medium";
  return "low";
}

