import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEdges, type PackageManifest } from "./package-dag.js";

// P11-012 architecture closure: source-level summaries of the five closure
// invariants (P11 `00` §Five closure invariants), the P12 `05` §5.1 (TR-1)
// narrowing of the advanceAnchor residual exposure (the P11 result record
// `planning/results/P11.result.md:55` is the provenance; P12 narrows the
// public surface — not a silent deletion), and the dependency-key freeze
// (no new edges beyond the two declared P11 whitelist adapters).

const repoRoot = join(import.meta.dirname, "..", "..");

const sourceOf = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

/** The observation-only sources of CI-1: the real resolver adapter, the
 * drift probe + startup seam, and the worktree sandbox adapter. None of
 * them may carry any anchor-advancement capability. */
const CI1_OBSERVATION_ONLY_SOURCES: ReadonlyArray<string> = [
  "adapters/environment-resolver-local/src/index.ts",
  "packages/application/src/environment-drift.ts",
  "packages/application/src/environment-drift-startup.ts",
  "adapters/sandbox-worktree/src/index.ts",
];

/** Advancement capability tokens (the store's write faces and their
 * adapters). The startup seam's `rec.record(` is the GOVERNED
 * RecordEnvironmentChange submission face — a different, legal surface —
 * and is therefore not on this list. */
const CI1_ADVANCEMENT_TOKENS: ReadonlyArray<string> = [
  "advanceAnchor",
  "lazyInitAnchor",
  "EnvironmentRevisionStoreLive",
  "EnvironmentRevisionStore.",
  "store.record(",
];

const readManifests = (dirName: string): ReadonlyArray<PackageManifest> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, entry, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(allDeps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const readPackages = (): ReadonlyArray<PackageManifest> => [
  ...readManifests("packages"),
  ...readManifests("adapters"),
];

const internalDependencyKeysOf = (name: string): ReadonlyArray<string> =>
  (readPackages().find((pkg) => pkg.name === name)?.internalDependencies ??
    []) as ReadonlyArray<string>;

describe("p11-closure", () => {
  it("CI-1 summary — resolver / drift / startup-probe / sandbox-worktree sources carry no anchor-advancement capability (advanceAnchor / lazy-init record / EnvironmentRevisionStore.record absent)", () => {
    for (const relative of CI1_OBSERVATION_ONLY_SOURCES) {
      const source = sourceOf(relative);
      for (const token of CI1_ADVANCEMENT_TOKENS) {
        expect(
          source.includes(token),
          `${relative}: advancement token "${token}"`,
        ).toBe(false);
      }
    }
    // The sole advancement authority adapter is RecordEnvironmentChangeLive
    // (persistence-sqlite), which advances via the store's CAS face only.
    const recAdapter = sourceOf(
      "adapters/persistence-sqlite/src/environment-change.ts",
    );
    expect(recAdapter.includes("RecordEnvironmentChange")).toBe(true);
    const ownershipAdapter = sourceOf(
      "adapters/persistence-sqlite/src/ownership.ts",
    );
    expect(ownershipAdapter.includes("lazyInitAnchor")).toBe(true); // P1-DG-08 exempt path
  });

  it("CI-3 summary — retire preconditions are enforced in source: worktree-lifecycle refuses ActiveClaims; ownership-wiring exposes the enforce face and release paths", () => {
    const lifecycle = sourceOf(
      "packages/application/src/commands/worktree-lifecycle.ts",
    );
    expect(lifecycle.includes("ActiveClaimsExist")).toBe(true);
    expect(lifecycle.includes("enforced")).toBe(true);

    const wiring = sourceOf("packages/application/src/ownership-wiring.ts");
    expect(wiring.includes("enforceRetirePreconditions")).toBe(true);
    expect(wiring.includes("ActiveOwnershipClaimsExist")).toBe(true);
    expect(wiring.includes("releasePaths")).toBe(true);
    expect(wiring.includes("releaseClaimsInRegions")).toBe(true);
    expect(wiring.includes("releaseShrunkRegions")).toBe(true);
  });

  it("CI-5 summary — environment-staleness is a pure derivation: no verdict literals, no write/runtime surface of any kind", () => {
    const source = sourceOf(
      "packages/application/src/environment-staleness.ts",
    );
    // No path produces or rewrites a verdict value.
    for (const literal of ['"Pass"', '"Fail"', '"Unknown"']) {
      expect(source.includes(literal), literal).toBe(false);
    }
    // No command/store/journal/transaction surface — the module cannot
    // write anything, so no auto-re-verify-and-accept.
    for (const forbidden of [
      "Effect",
      "Gateway",
      "Repository",
      "Store",
      "Journal",
      "PendingDomainEvent",
      ".transact",
      ".insert",
      ".update",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("TR-1 (P12 05 §5.1): advanceAnchor is ABSENT from the ports public surface — advancement is the internal, non-exported capability (P11 result record :55 provenance)", () => {
    // P12 narrows the P11 residual exposure: the public store port no longer
    // declares advanceAnchor (this is the recorded P12 reconciliation, not a
    // silent deletion).
    const environmentPort = sourceOf("packages/ports/src/environment.ts");
    expect(environmentPort.includes("advanceAnchor")).toBe(false);
    // The two legal lazy/ownership write faces remain on the public port.
    expect(environmentPort.includes("lazyInitAnchor")).toBe(true);
    expect(environmentPort.includes("readonly record")).toBe(true);
    // The ports public barrel exposes no advancement token.
    const portsIndex = sourceOf("packages/ports/src/index.ts");
    expect(portsIndex.includes("advanceAnchor")).toBe(false);
  });

  it("dependency keys — no new edges beyond the declared whitelist (P12 `01` §7 reconciled sandbox-worktree / environment-resolver-local to domain+ports only)", () => {
    // The full DAG stays legal (this re-runs the package-dag checker over
    // the live manifests — any undeclared new key fails here).
    expect(checkEdges(readPackages())).toEqual([]);

    // G8/DF-16: the two P11 whitelist adapters were reconciled to the DID
    // §10.4.1 edge set (domain + ports only; no `application` edge).
    for (const adapter of ["sandbox-worktree", "environment-resolver-local"]) {
      expect([...internalDependencyKeysOf(adapter)].sort()).toEqual([
        "domain",
        "ports",
      ]);
    }

    // Every other adapter still declares the plain domain+ports edge —
    // no additional key sneaked in anywhere.
    for (const adapter of [
      "persistence-sqlite",
      "environment-local",
      "worker-local",
      "provider-fake",
      "sandbox-local",
      "blob-local",
    ]) {
      expect([...internalDependencyKeysOf(adapter)].sort()).toEqual([
        "domain",
        "ports",
      ]);
    }
  });
});
