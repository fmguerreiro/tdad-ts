import path from "node:path";

const TEST_BASENAME = /\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/;
const TEST_DIR_NAMES = new Set(["__tests__", "tests"]);

export function isTestPath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (TEST_BASENAME.test(base)) return true;
  const dirs = filePath.split(path.sep);
  return dirs.some((segment) => TEST_DIR_NAMES.has(segment));
}

export function testStem(filePath: string): string {
  const base = path.basename(filePath);
  const ext = base.match(/\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/);
  if (ext) {
    return base.slice(0, base.length - ext[0].length);
  }
  const lastDot = base.lastIndexOf(".");
  return lastDot === -1 ? base : base.slice(0, lastDot);
}
