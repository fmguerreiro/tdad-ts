import { multiply } from "./helper.js";

// Arrow function that calls an imported function.
export const triple = (value: number): number => {
  return multiply(value);
};

// Function expression that calls an imported function.
export const tripleExpr = function (value: number): number {
  return multiply(value);
};
