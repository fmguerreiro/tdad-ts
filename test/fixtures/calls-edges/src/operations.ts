import { compute } from "./helper.js";

// useCompute calls compute() from helper.ts
export function useCompute(value: number): number {
  return compute(value);
}
