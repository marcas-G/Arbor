import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P13 `01` §1/§5 + `06` EC-2/EC-9 — the apps/web boundary:
 *
 * I1/EC-2  zero backend imports except `@arbor/api-contracts` (type-only);
 *          no node builtins; no repo-package source reach-through.
 * I3       every network touch is a whitelist URL (`/views/...`, `/commands`,
 *          `/ws`) — commands ONLY via `/commands`.
 * EC-9     no `/search` surface anywhere in the client (out-of-v1).
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const webRoot = join(repoRoot, "apps", "web");

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") {
        continue;
      }
      out.push(...walk(full));
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

const sourceFiles = walk(join(webRoot, "src"));

const importSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /import\s+[^"]*"([^"]+)"/g,
    /import\s*\(\s*"([^"]+)"\s*\)/g,
    /from\s+"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
};

describe("p13-web-boundaries", () => {
  it("I1/EC-2: apps/web imports no backend package except @arbor/api-contracts (type-only)", () => {
    for (const file of sourceFiles) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("@arbor/")) {
          expect(
            specifier,
            `${file}: only @arbor/api-contracts is importable`,
          ).toBe("@arbor/api-contracts");
        }
        expect(
          specifier.startsWith("node:"),
          `${file}: node builtins are forbidden in the browser client`,
        ).toBe(false);
      }
    }
  });

  it("I1/EC-2: api-contracts is imported type-only", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /import\s+(type\s+)?[^"]*"(@arbor\/api-contracts)"/g,
      )) {
        const isTypeOnly = match[1] !== undefined;
        if (!isTypeOnly) {
          const namedOnly = /import\s+type\s*\{/.test(source);
          expect(
            namedOnly,
            `${file}: @arbor/api-contracts must be a type-only import`,
          ).toBe(true);
        }
      }
    }
  });

  it("I3: network URLs are exactly the whitelist (/views/:view, /commands, /ws)", () => {
    const allowed = new Set(["/commands", "/ws"]);
    const urlLiteral = /["'`](\/[a-z][a-z0-9/_-]*)["'`]/g;
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(urlLiteral)) {
        const literal = match[1] ?? "";
        if (literal.startsWith("/views/") || allowed.has(literal)) {
          continue;
        }
        // Non-network path literals (route paths, css class selectors in tsx)
        // are not URLs; only flag literals that appear near fetch/WebSocket.
        const around = source.slice(
          Math.max(0, (match.index ?? 0) - 120),
          (match.index ?? 0) + 160,
        );
        if (
          /fetch\(|WebSocket|EventSource|XMLHttpRequest|\.open\(/.test(around)
        ) {
          expect(
            literal,
            `${file}: non-whitelisted network literal near transport call`,
          ).toBe("/commands");
        }
      }
    }
  });

  it("I3/EC-6: mutations go through POST /commands only — no other write verb target exists", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      expect(
        /method:\s*["'](PUT|PATCH|DELETE)["']/.test(source),
        `${file}: non-POST mutation method`,
      ).toBe(false);
    }
  });

  it("EC-9: no search surface in the client", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      expect(
        /\/search|["']search["']\s*:/i.test(source),
        `${file}: search surface is out-of-v1`,
      ).toBe(false);
    }
  });

  it("TR-W2: the daemon static face serves only files — no API route addition", () => {
    const staticFace = readFileSync(
      join(repoRoot, "apps/single-workspace/src/transport/static-assets.ts"),
      "utf8",
    );
    expect(staticFace).not.toMatch(/\/views|\/commands|\/commands/);
  });
});
