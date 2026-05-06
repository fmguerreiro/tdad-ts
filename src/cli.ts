#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { buildGraph } from "./parser.js";
import { linkTests } from "./test-linker.js";
import { buildMap, renderMap, writeMap } from "./map-writer.js";
import { fileId } from "./parser.js";

const program = new Command();
program.name("tdad-ts").description("Graph-based test impact analyzer for TypeScript");

program
  .command("index")
  .description("Index a project and emit test_map.txt")
  .argument("<root>", "project root directory")
  .option("-o, --out <file>", "output file", "test_map.txt")
  .option("--max-tests <n>", "max tests per source file", (value) => Number(value), 50)
  .action(async (root: string, options: { out: string; maxTests: number }) => {
    const graph = await buildGraph({ root });
    linkTests(graph);
    const entries = buildMap(graph, { maxTests: options.maxTests });
    writeMap(options.out, entries);
    process.stdout.write(
      `indexed ${graph.nodes.size} nodes, ${countEdges(graph)} edges, ${entries.length} mapped sources -> ${options.out}\n`,
    );
  });

program
  .command("impacted")
  .description("Print at-risk tests for changed files")
  .argument("<root>", "project root directory")
  .argument("<files...>", "changed files (relative to root)")
  .option("--max-tests <n>", "max tests per source file", (value) => Number(value), 50)
  .action(async (root: string, files: string[], options: { maxTests: number }) => {
    const graph = await buildGraph({ root });
    linkTests(graph);
    const ids = files.map((file) => fileId(path.relative(root, path.resolve(root, file))));
    const entries = buildMap(graph, { maxTests: options.maxTests }).filter((entry) =>
      ids.includes(fileId(entry.source)),
    );
    process.stdout.write(renderMap(entries));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`tdad-ts error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

function countEdges(graph: ReturnType<typeof buildGraph> extends Promise<infer T> ? T : never): number {
  let total = 0;
  for (const list of graph.edgesOut.values()) total += list.length;
  return total;
}
