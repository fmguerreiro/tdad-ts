import { describe, expect, it } from "vitest";
import { buildEmail } from "../src/email-builder.js";

describe("email rendering", () => {
  it("builds the welcome template by name", () => {
    const html = buildEmail("welcome", { name: "Ada" });
    expect(html).toContain("welcome");
  });
});
