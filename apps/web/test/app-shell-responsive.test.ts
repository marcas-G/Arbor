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

  it("provides visible keyboard focus, reduced-motion support, and overflow containment", () => {
    const components = readFileSync(
      join(process.cwd(), "src/components/components.css"),
      "utf8",
    );
    const reset = readFileSync(
      join(process.cwd(), "src/styles/reset.css"),
      "utf8",
    );
    const motion = readFileSync(
      join(process.cwd(), "src/styles/accessibility.css"),
      "utf8",
    );
    expect(components).toMatch(/:focus-visible/);
    expect(reset).toMatch(/overflow-wrap:\s*anywhere/);
    expect(motion).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it("allows the Settings page to shrink to a narrow mobile content area", () => {
    const settings = readFileSync(
      join(process.cwd(), "src/pages/settings/settings.module.css"),
      "utf8",
    );
    expect(settings).toMatch(/\.page\s*\{[^}]*min-width:\s*0;/);
  });
});
