import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { statusTone, TOKENS } from "../src/tokens.js";

/**
 * P13 `04` §5 / `06` EC-10: token single source + no color/font-size
 * literals in component sources. Color and size literals may appear only
 * in `src/tokens.css` and `src/tokens.ts`.
 */

function extractRootBlock(css: string): string {
  const match = css.match(/:root\s*\{([^}]*)\}/);
  if (match === null || match[1] === undefined) {
    throw new Error("src/tokens.css has no :root block");
  }
  return match[1];
}

function extractArborDeclarations(block: string): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const match of block.matchAll(/(--arbor-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declared[match[1] ?? ""] = (match[2] ?? "").trim();
  }
  return declared;
}

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, found);
    } else if (/\.(tsx|css)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const srcRoot = join(process.cwd(), "src");
const tokenFiles = new Set([
  join(srcRoot, "tokens.css"),
  join(srcRoot, "tokens.ts"),
]);

describe("EC-10 design token single source", () => {
  it("tokens.css :root mirrors TOKENS exactly (name and value)", () => {
    const css = readFileSync(join(srcRoot, "tokens.css"), {
      encoding: "utf8",
    });
    expect(extractArborDeclarations(extractRootBlock(css))).toEqual(TOKENS);
  });

  it("component sources contain no hex/rgb/hsl colors and no px font sizes", () => {
    const scanned = collectSourceFiles(srcRoot).filter(
      (path) => !tokenFiles.has(path),
    );
    expect(scanned.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of scanned) {
      const source = readFileSync(path, { encoding: "utf8" });
      if (
        /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/.test(source) ||
        /#[0-9a-fA-F]{3}(?![0-9a-fA-F])/.test(source)
      ) {
        violations.push(`${path}: hex color literal`);
      }
      if (/rgb\(|hsl\(/i.test(source)) {
        violations.push(`${path}: rgb()/hsl() color literal`);
      }
      if (/font-size\s*:\s*\d+px/i.test(source)) {
        violations.push(`${path}: px font-size literal`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("statusTone maps label families per the frozen table", () => {
    expect(statusTone("Pass")).toBe("leaf");
    expect(statusTone("COMPLETED")).toBe("leaf");
    expect(statusTone("waiting-blocked")).toBe("danger");
    expect(statusTone("ActionRequired")).toBe("danger");
    expect(statusTone("pending")).toBe("attention");
    expect(statusTone("Unknown")).toBe("attention");
    expect(statusTone("retired")).toBe("muted");
    expect(statusTone("some-future-label")).toBe("muted");
  });
});
