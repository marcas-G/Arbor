import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

const walkSourceFiles = (
  dir: string,
  sink: Array<string> = [],
): ReadonlyArray<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(path, sink);
    } else if (entry.name.endsWith(".ts")) {
      sink.push(path);
    }
  }
  return sink;
};

const importSpecifiersOf = (source: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const importRe = /from\s+"([^"]+)"/g;
  for (const match of source.matchAll(importRe)) {
    out.push(match[1] ?? "");
  }
  return out;
};

const stringLiteralsOf = (source: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const literalRe =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  for (const match of source.matchAll(literalRe)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out;
};

const SQL_WRITE_RE =
  /\b(INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE\s|DROP\s+TABLE|DROP\s+INDEX|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+UNIQUE\s+INDEX|CREATE\s+INDEX|CREATE\s+TRIGGER)\b/;

describe("p10-boundaries", () => {
  it("projection-runtime owns zero SQL write surface — write statements blacklisted in string literals; rebuild's materialized writes ride injected P1 port faces only (the sole whitelist)", () => {
    for (const file of walkSourceFiles(
      join(repoRoot, "packages/projection-runtime/src"),
    )) {
      const source = readFileSync(file, "utf8");
      for (const literal of stringLiteralsOf(source)) {
        expect(
          SQL_WRITE_RE.test(literal),
          `${file}: SQL write statement in string literal: "${literal}"`,
        ).toBe(false);
      }
    }
    const rebuild = readFileSync(
      join(repoRoot, "packages/projection-runtime/src/rebuild.ts"),
      "utf8",
    );
    for (const face of [
      "readonly catchUpView:",
      "readonly forceResetView:",
      "readonly rebuildView:",
    ]) {
      expect(
        rebuild.includes(face),
        `rebuild.ts must declare the P1-port write face "${face}" as an injected dependency`,
      ).toBe(true);
    }
    expect(
      rebuild.includes("readonly prunedFloor:"),
      "rebuild.ts observes the pruned floor read-only (journal horizon stays P1 04)",
    ).toBe(true);
  });

  it("api-contracts declares exactly the domain edge (DID §10.4.1) — deps domain only, source imports domain + relative", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, "packages/api-contracts/package.json"),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@arbor/domain"]);
    for (const file of walkSourceFiles(
      join(repoRoot, "packages/api-contracts/src"),
    )) {
      for (const specifier of importSpecifiersOf(readFileSync(file, "utf8"))) {
        expect(
          /^(\.\/|\.\.\/|@arbor\/domain$)/.test(specifier),
          `${file}: forbidden api-contracts import "${specifier}"`,
        ).toBe(true);
      }
    }
  });

  it("P12 boundary negative: no HTTP/WS/CLI transport anywhere in repo source trees (packages/apps/adapters src + tests) and apps/web stays unbuilt", () => {
    const TRANSPORT_IMPORT =
      /^(node:http|node:https|node:http2|node:ws|node:net|node:readline|node:repl|ws|express|fastify|socket\.io|@fastify\/.*|commander|yargs|clipanion)$/;
    const TRANSPORT_NAME_SEGMENTS = new Set([
      "server",
      "http",
      "https",
      "ws",
      "websocket",
      "cli",
    ]);
    for (const root of ["packages", "apps", "adapters", "tests"]) {
      for (const file of walkSourceFiles(join(repoRoot, root))) {
        for (const specifier of importSpecifiersOf(
          readFileSync(file, "utf8"),
        )) {
          expect(
            TRANSPORT_IMPORT.test(specifier),
            `${file}: transport import "${specifier}" is P12 territory`,
          ).toBe(false);
        }
        const base = file.split("/").pop() ?? "";
        const stem = base.replace(/\.ts$/, "");
        const segments = stem.split(/[-.]/);
        expect(
          segments.filter((segment) => TRANSPORT_NAME_SEGMENTS.has(segment)),
          `${file}: transport-named source file is P12 territory`,
        ).toEqual([]);
      }
    }
    expect(existsSync(join(repoRoot, "apps/web"))).toBe(false);
  });

  it("HumanInterventionApplied emission is application-package-only (P10 06 §2 — grep-limited); the read side may filter the event type but never emits", () => {
    const offenders: Array<string> = [];
    const applicationSrc = join(repoRoot, "packages/application/src");
    for (const root of ["packages", "apps", "adapters"]) {
      for (const file of walkSourceFiles(join(repoRoot, root))) {
        const source = readFileSync(file, "utf8");
        const emits =
          source.includes("emitHumanIntervention(") ||
          source.includes("humanStopInterventionEvent(");
        if (emits && !file.startsWith(applicationSrc)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
    const workspaceDetail = readFileSync(
      join(
        repoRoot,
        "packages/projection-runtime/src/views/workspace-detail.ts",
      ),
      "utf8",
    );
    expect(workspaceDetail.includes("HumanInterventionApplied")).toBe(true);
    expect(workspaceDetail.includes("emitHumanIntervention")).toBe(false);
  });
});
