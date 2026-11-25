import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("responsive app shell", () => {
  it("provides visible keyboard focus, reduced-motion support, and overflow containment", () => {
    const reset = readFileSync(
      join(process.cwd(), "src/styles/reset.css"),
      "utf8",
    );
    const motion = readFileSync(
      join(process.cwd(), "src/styles/accessibility.css"),
      "utf8",
    );
    expect(reset).toMatch(/:focus-visible/);
    expect(reset).toMatch(/overflow-wrap:\s*anywhere/);
    expect(motion).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});
