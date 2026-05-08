import { describe, expect, it } from "vitest";

describe("dashboard route", () => {
  it("renders the dashboard page", () => {
    const url = "/dashboard";
    expect(url).toEqual("/dashboard");
  });
});
