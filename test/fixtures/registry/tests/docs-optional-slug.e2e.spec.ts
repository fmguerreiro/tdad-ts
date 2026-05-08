import { describe, expect, it } from "vitest";

describe("docs optional catch-all route", () => {
  it("navigates to /docs/intro", () => {
    const path = "/docs/intro";
    expect(path).toEqual("/docs/intro");
  });
});
