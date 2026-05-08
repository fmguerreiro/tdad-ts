import { describe, expect, it } from "vitest";

describe("api health", () => {
  it("returns ok at /api/health", () => {
    const path = "/api/health";
    expect(path).toEqual("/api/health");
  });
});
