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
tdad-ts index <project-root> --out test_map.txt --coverage coverage.json
tdad-ts impacted <project-root> <changed-file> [<changed-file> ...]
tdad-ts impacted <project-root> <changed-file> --coverage coverage.json
```

### Coverage strategy

Pass a JSON file via `--coverage <path>` to enable the Coverage strategy. The
file maps each test file to the source files it covered at runtime:

```json
{
  "version": 1,
  "tests": {
    "tests/foo.spec.ts": ["src/used.ts", "src/lib/helper.ts"],
    "tests/bar.spec.ts": ["src/lib/helper.ts"]
  }
}
```

Paths are project-relative, forward-slash. Generating this file from a test
runner's raw output (e.g. vitest's v8 coverage report) is a downstream concern
left to the caller.

## Algorithm

Same scoring as the paper:

```
score = (1 - c_w) * w_strategy + c_w * confidence
```

with `c_w = 0.3` and per-strategy weights:

| Strategy   | Weight | Confidence |
|------------|--------|------------|
| Direct     | 0.95   | 1.00       |
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
