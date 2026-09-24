import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("responsive app shell", () => {
  it("stacks the main surface above mobile navigation on narrow screens", () => {
    const css = readFileSync(
      join(process.cwd(), "src/shell/shell.module.css"),
      "utf8",
    );

    expect(css).toMatch(
      /@media \(max-width: 47\.99rem\)[\s\S]*?\.shell\s*\{[\s\S]*?flex-direction:\s*column;/,
    );
  });
});
