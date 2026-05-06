import { add, multiply } from "./math.js";

export class Calculator {
  add(a: number, b: number): number {
    return add(a, b);
  }
  multiply(a: number, b: number): number {
    return multiply(a, b);
  }
}
