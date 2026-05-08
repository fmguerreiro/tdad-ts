import { Graph, type FileNode } from "./graph.js";

export type Strategy = "Direct" | "Route" | "Transitive" | "Imports";
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
  Route: { weight: 0.9, confidence: 0.7 },
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
    route(graph, file, strategies.Route, candidates);
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

function route(
  graph: Graph,
  file: FileNode,
  config: StrategyConfig,
  acc: Map<string, ImpactedTest>,
): void {
  for (const edge of graph.incoming(file.id, "ROUTE")) {
    const caller = graph.getNode(edge.from);
    if (caller.kind !== "File" || !caller.isTest) continue;
    record(acc, caller.path, "Route", scoreOf(config));
  }
}

function transitive(
  graph: Graph,
  file: FileNode,
  config: StrategyConfig,
  maxHops: number,
  acc: Map<string, ImpactedTest>,
): void {
  // BFS over reverse IMPORTS (file level) and reverse CALLS (function level) up to maxHops.
  // CALLS edges narrow the blast radius: only files containing functions that actually call
  // into the changed file's functions are included, rather than every file that imports it.
  const reached = new Set<string>();

  // Collect the IDs of all function nodes in the changed file.
  const changedFileFunctionIds = new Set<string>(
    graph.outgoing(file.id, "CONTAINS")
      .filter((edge) => {
        const node = graph.getNode(edge.to);
        return node.kind === "Function";
      })
      .map((edge) => edge.to),
  );

  // Dual-frontier BFS: CALLS edges (function-level) and IMPORTS edges (file-level).
  //
  // CALLS BFS identifies files whose functions directly call into the changed file's functions.
  // This is the primary, narrow signal.
  //
  // IMPORTS BFS propagates from CALLS-reached files, not from the changed file itself.
  // This ensures that files which only import the changed file but never call it are NOT
  // included (they are direct importers with no call coverage). Files that import a
  // CALLS-reached file are included because they transitively depend on a caller.
  //
  // The IMPORTS BFS also serves as a per-caller fallback: if a CALLS-reached file has
  // importers that themselves have no Function nodes (i.e. were never indexed for calls),
  // those importers are included via the IMPORTS path.

  // Dual-frontier BFS: CALLS edges (function-level) and IMPORTS edges (file-level).
  //
  // The IMPORTS BFS is seeded from CALLS-reached files, not from the changed file itself.
  // This ensures that files which only import the changed file but never call it are NOT
  // included (they are direct importers with no call coverage). Files that import a
  // CALLS-reached file are included because they transitively depend on a caller.
  //
  // New CALLS-reached files are added to the NEXT hop's IMPORTS frontier so their importers
  // are explored one hop later.
  let importsFrontier = new Set<string>();
  // For CALLS: start from the functions in the changed file.
  let callsFrontier = new Set<string>(changedFileFunctionIds);

  for (let hop = 0; hop < maxHops; hop += 1) {
    // File-level IMPORTS BFS: propagate from files reached via CALLS in the previous hop.
    // This intentionally excludes direct importers of the changed file that were not
    // reached via CALLS (they have no call dependency on the changed file's functions).
    const nextImportsFrontier = new Set<string>();
    for (const id of importsFrontier) {
      for (const edge of graph.incoming(id, "IMPORTS")) {
        if (reached.has(edge.from) || edge.from === file.id) continue;
        reached.add(edge.from);
        nextImportsFrontier.add(edge.from);
      }
    }

    // Function-level CALLS BFS.
    const nextCallsFrontier = new Set<string>();
    // Collect newly-reached caller files to seed the IMPORTS frontier for the next hop.
    const newlyCallsReached = new Set<string>();
    for (const functionId of callsFrontier) {
      for (const edge of graph.incoming(functionId, "CALLS")) {
        const callerNode = graph.getNode(edge.from);
        if (callerNode.kind !== "Function") continue;
        const callerFileId = callerNode.file;
        if (callerFileId === file.id) continue;
        if (!reached.has(callerFileId)) {
          reached.add(callerFileId);
          newlyCallsReached.add(callerFileId);
        }
        // Continue BFS: the caller function's file may have its own callers.
        // Add the caller function to the next frontier for the next hop.
        if (!nextCallsFrontier.has(edge.from)) {
          nextCallsFrontier.add(edge.from);
        }
      }
    }

    // Merge newly CALLS-reached files into the next IMPORTS frontier.
    for (const id of newlyCallsReached) {
      nextImportsFrontier.add(id);
    }

    if (nextImportsFrontier.size === 0 && nextCallsFrontier.size === 0) break;
    importsFrontier = nextImportsFrontier;
    callsFrontier = nextCallsFrontier;
  }

  for (const reachedFileId of reached) {
    const reachedFile = graph.getNode(reachedFileId);
    if (reachedFile.kind !== "File") continue;
    addTestsForFile(graph, reachedFile, "Transitive", config, acc);
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

