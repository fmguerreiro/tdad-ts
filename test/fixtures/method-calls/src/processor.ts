import { format } from "./formatter.js";

export class Processor {
  process(input: string): string {
    return format(input);
  }
}
