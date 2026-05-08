// standalone.ts imports compute from helper.ts but never calls it.
// It only references compute as a value (e.g. passes it as a callback).
import { compute } from "./helper.js";

export function double(value: number): number {
  return value * 2;
}

export function getComputeFn(): (value: number) => number {
  return compute;
}
