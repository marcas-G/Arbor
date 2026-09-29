import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P16 `02` E1/E2 — mechanical architecture gates for the provider extension
// architecture. INV-P16-1/2/3/6/7 and the WL data-file discipline (risk R1).

const repoRoot = join(import.meta.dirname, "..", "..");

const CORE_PACKAGES = [
  "domain",
  "ports",
  "application",
  "model-context",
  "agent-runtime",
  "execution-runtime",
  "provider-runtime",
  "projection-runtime",
  "tool-runtime",
] as const;

interface Pkg {
  readonly name: string;
  readonly dir: string;
  readonly internalDependencies: ReadonlyArray<string>;
}

const internalDeps = (pkgJson: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): ReadonlyArray<string> =>
  [
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
  ].filter((specifier) => specifier.startsWith("@arbor/"));

const listPackages = (dir: string): ReadonlyArray<Pkg> =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, dir, entry.name, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      return {
        name: String(manifest.name).replace("@arbor/", ""),
        dir: `${dir}/${entry.name}`,
        internalDependencies: internalDeps(manifest as never),
      };
    });

const allPackages: ReadonlyArray<Pkg> = [
  ...listPackages("packages"),
  ...listPackages("adapters"),
];

const providerPackages = allPackages.filter((pkg) =>
  pkg.name.startsWith("provider-"),
);

describe("P16 E1 — dependency direction (INV-P16-1)", () => {
  it("every provider-* package depends only on domain and ports", () => {
    expect(providerPackages.length).toBeGreaterThanOrEqual(2);
    const violations: string[] = [];
    for (const pkg of providerPackages) {
      for (const dependency of pkg.internalDependencies) {
        const short = dependency.replace("@arbor/", "");
        if (short !== "domain" && short !== "ports") {
          violations.push(`forbidden edge: ${pkg.name} -> ${short}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no core package depends on any provider-* adapter (dynamic, new families included)", () => {
    const violations: string[] = [];
    for (const pkg of allPackages) {
      if (!CORE_PACKAGES.includes(pkg.name as never)) {
        continue;
      }
      for (const dependency of pkg.internalDependencies) {
        if (dependency.replace("@arbor/", "").startsWith("provider-")) {
          violations.push(`forbidden edge: ${pkg.name} -> ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("agent-runtime never imports the P16 extension contract (INV-P16-6 import face)", () => {
    const violations: string[] = [];
    for (const pkg of allPackages.filter((p) => p.name === "agent-runtime")) {
      for (const dependency of pkg.internalDependencies) {
        if (dependency.includes("provider-extension")) {
          violations.push(`${pkg.dir} imports provider-extension`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("P16 E2 — single-site ProviderPort construction (INV-P16-2/3)", () => {
  const CONSTRUCTION_TOKENS = [
    "Layer.succeed(ProviderPort",
    "Layer.effect(ProviderPort",
    "ProviderPort.of(",
  ] as const;

  const ALLOWED_PREFIXES = [
    "adapters/provider-", // adapter families own construction
    "apps/single-workspace/src/provider-registry.table.ts", // registry table (WL)
    "apps/single-workspace/src/composition.ts", // composition assembly point
    "packages/testkit/", // test doubles
    "packages/ports/src/", // the port definition itself (ProviderPort.of typing)
    "tests/",
  ] as const;

  it("ProviderPort Layer construction is closed over the allowed set", () => {
    const violations: string[] = [];
    for (const pkg of [
      ...providerPackages,
      ...allPackages.filter(
        (p) =>
          CORE_PACKAGES.includes(p.name as never) || p.dir.startsWith("apps/"),
      ),
    ]) {
      const srcDir = join(repoRoot, pkg.dir, "src");
      let entries: ReadonlyArray<string> = [];
      try {
        entries = readdirSync(srcDir);
      } catch {
        continue;
      }
      for (const file of entries.filter((name) => name.endsWith(".ts"))) {
        const path = `${pkg.dir}/src/${file}`;
        const source = readFileSync(join(repoRoot, path), "utf8");
        for (const token of CONSTRUCTION_TOKENS) {
          if (source.includes(token)) {
            const allowed = ALLOWED_PREFIXES.some((prefix) =>
              path.startsWith(prefix),
            );
            if (!allowed) {
              violations.push(`${path}: ${token}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("registry table (WL) is declaration-only: imports + one array export (risk R1)", () => {
    const source = readFileSync(
      join(repoRoot, "apps/single-workspace/src/provider-registry.table.ts"),
      "utf8",
    );
    // No control flow, no function declarations, no Layer construction.
    for (const forbidden of [
      "Layer.succeed",
      "Layer.effect",
      "function ",
      "=>",
      "if (",
      "for (",
      "while (",
      "readFileSync",
      "readdirSync",
      "import(",
      "require(",
    ]) {
      expect(
        source.includes(forbidden),
        `registry table contains "${forbidden}"`,
      ).toBe(false);
    }
    expect(source).toContain("PROVIDER_REGISTRY_TABLE");
  });

  it("model catalog data (WL) is declaration-only (risk R1)", () => {
    const source = readFileSync(
      join(repoRoot, "packages/model-context/src/model-catalog.data.ts"),
      "utf8",
    );
    for (const forbidden of [
      "function ",
      "=>",
      "if (",
      "for (",
      "while (",
      "readFileSync",
      "readdirSync",
      "import(",
      "require(",
    ]) {
      expect(
        source.includes(forbidden),
        `catalog data contains "${forbidden}"`,
      ).toBe(false);
    }
    expect(source).toContain("DEFAULT_MODEL_CATALOG");
  });
});
