// This test intentionally imports neither used.ts nor unused.ts.
// Coverage edges must come from the coverage JSON, not from static imports.
export function placeholder(): boolean {
  return true;
}
