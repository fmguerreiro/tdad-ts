import { Calculator } from "./calculator.js";

export function totalReport(values: Array<[number, number]>): number {
  const calc = new Calculator();
  return values.reduce((acc, [a, b]) => acc + calc.add(a, b), 0);
}
