# tdad-ts

TypeScript port of TDAD (Test-Driven Agentic Development), a graph-based test
impact analyzer for AI coding agents.

Reference: Alonso, Yovine, Braberman.
"TDAD: Test-Driven Agentic Development - Reducing Code Regressions in AI
Coding Agents via Graph-Based Impact Analysis." arXiv:2603.17973, March 2026.

## What it does

Indexes a TypeScript project into a static `test_map.txt` that maps each
source file to the tests at risk of regressing if that file changes. An AI
agent grep's the map after editing a file, runs the listed tests, and
self-corrects on failure - no MCP server, graph DB, or runtime API.

## Status

Prototype. Single-pass indexer, in-memory graph, file-level test map.

## Usage

```bash
tdad-ts index <project-root> --out test_map.txt
tdad-ts impacted <changed-file> [<changed-file> ...] --map test_map.txt
```

## Algorithm

Same scoring as the paper:

```
score = (1 - c_w) * w_strategy + c_w * confidence
```

with `c_w = 0.3` and per-strategy weights:

| Strategy   | Weight | Confidence |
|------------|--------|------------|
| Direct     | 0.95   | 1.00       |
| Route      | 0.90   | 0.70       |
| Transitive | 0.70   | 0.56       |
| Coverage   | 0.80   | 0.50       |
| Imports    | 0.50   | 0.45       |

Tiers: high (>= 0.8), medium (0.5-0.8), low (< 0.5). Default cap 50 tests
per source file.

## Test linker heuristics

Three-tier strategy from the paper, ported to TS conventions:

1. Naming convention: `foo.spec.ts`, `foo.test.ts`, `__tests__/foo.ts` -> `foo.ts`
2. Prefix matching: progressive truncation of test-file stem
3. Directory proximity: nearest non-test ancestor when a stem matches multiple sources

## Route and registry edges

Static `import` chains miss two recurring patterns in real codebases: Next.js
route resolution (a test reaches the page through a URL, not an import) and
registry-based dispatch (a function looks up its target by name in a table).
Both are exposed via a single JSON config passed with `--registries`:

```json
{
  "routes": { "appDir": "app" },
  "registries": [
    {
      "name": "email-templates",
      "lookup":     { "import": "src/email-builder", "function": "buildEmail", "argIndex": 0 },
      "registered": { "files":  "src/templates/*.ts" }
    }
  ]
}
```

`routes` walks the Next.js app directory, derives URL patterns (stripping
`(group)` segments and replacing `[id]` with wildcards), and emits a `Route`
edge from any test that contains a matching string literal. `registries`
detects calls to a configured lookup function whose key argument matches a
registered file's basename, and emits the same edge type. Both surface as the
`Route` strategy in `test_map.txt` at the high tier.
