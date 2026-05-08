import { describe, expect, it } from "vitest";

describe("unrelated", () => {
  it("does nothing useful", () => {
    expect("just a string").toEqual("just a string");
  });
});
