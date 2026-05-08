import * as MathUtils from "./math.js";

export function sum(values: number[]): number {
  return values.reduce((acc, value) => MathUtils.add(acc, value), 0);
}
