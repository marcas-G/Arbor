import { describe, expect, it } from "vitest";
import {
  buildSnapshotWitness,
  type canonicalSnapshotBytes,
  type EnvironmentFingerprint,
  fingerprintInputBytes,
  parseSnapshotBlob,
  SnapshotBlobFormatError,
  type SnapshotProbe,
  type SnapshotRegionEntry,
  snapshotBlobContent,
} from "../packages/domain/src/index.js";
import { fingerprintOf } from "../packages/ports/src/snapshot-fingerprint.js";

const WS = "space-1" as never;
const region = (
  norm: string,
): { resourceSpaceId: never; normalizedRegion: never } => ({
  resourceSpaceId: WS,
  normalizedRegion: norm as never,
});

const file = (path: string): { _tag: "FileTree"; path: string } => ({
  _tag: "FileTree",
  path,
});
const worktree = (path: string): { _tag: "GitWorktree"; path: string } => ({
  _tag: "GitWorktree",
  path,
});

const entry = (
  norm: string,
  address: Parameters<typeof canonicalSnapshotBytes>[1][number]["address"],
  probe: SnapshotProbe,
): SnapshotRegionEntry => ({ address, resolved: region(norm), probe });

const fProbe = (mtime = "2026-01-01T00:00:00Z"): SnapshotProbe => ({
  kind: "FileTree",
  exists: true,
  mtime,
});
const gProbe = (head = "abc123", dirty = false): SnapshotProbe => ({
  kind: "GitWorktree",
  exists: true,
  head,
  dirty,
});

const PROJ = "prj-A";

describe("P11-002 snapshot identity (canonical semantic state only)", () => {
  it("identical semantic snapshot -> identical fingerprint", () => {
    const a = fingerprintOf(PROJ, [
      entry("/a", file("/repo/a"), fProbe()),
      entry("/b", worktree("/repo/w"), gProbe()),
    ]);
    const b = fingerprintOf(PROJ, [
      entry("/a", file("/repo/a"), fProbe()),
      entry("/b", worktree("/repo/w"), gProbe()),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it("semantic content change -> fingerprint change", () => {
    const a = fingerprintOf(PROJ, [entry("/a", file("/repo/a"), fProbe("t1"))]);
    const b = fingerprintOf(PROJ, [entry("/a", file("/repo/a"), fProbe("t2"))]);
    expect(a.equals(b)).toBe(false);
    const c = fingerprintOf(PROJ, [
      entry("/a", file("/repo/a"), fProbe()),
      entry("/extra", file("/repo/e"), fProbe()),
    ]);
    const d = fingerprintOf(PROJ, [entry("/a", file("/repo/a"), fProbe())]);
    expect(c.equals(d)).toBe(false); // region-set change is semantic
  });

  it("region ordering permutation -> fingerprint unchanged", () => {
    const e1 = entry("/a", file("/x"), fProbe());
    const e2 = entry("/b", worktree("/w"), gProbe());
    const e3 = entry("/c", file("/y"), fProbe("t3"));
    const orders: ReadonlyArray<SnapshotRegionEntry[]> = [
      [e1, e2, e3],
      [e3, e1, e2],
      [e2, e3, e1],
      [e3, e2, e1],
    ];
    const prints = orders.map((regions) => fingerprintOf(PROJ, regions));
    for (const p of prints.slice(1)) {
      expect(p.equals(prints[0] as EnvironmentFingerprint)).toBe(true);
    }
  });

  it("file/worktree entry ordering permutation (same set) -> unchanged", () => {
    const mk = () => [
      entry(`/f${Math.floor(Math.random() * 1000)}`, file("/same"), fProbe()),
      entry(`/w1`, worktree("/wt"), gProbe("h")),
    ];
    // same set, different array order
    const set = [
      entry("/f9", file("/same"), fProbe()),
      entry("/w1", worktree("/wt"), gProbe("h")),
    ];
    const a = fingerprintOf(PROJ, set);
    const b = fingerprintOf(PROJ, [set[1]!, set[0]!]);
    expect(a.equals(b)).toBe(true);
    void mk;
  });

  it("metadata-only change -> fingerprint unchanged (capturedAt/revision never hashed)", () => {
    const regions = [entry("/a", file("/a"), fProbe())];
    const w1 = buildSnapshotWitness(
      (fingerprintOf(PROJ, regions) as unknown as { digest: string }).digest,
      PROJ,
      regions,
      "1",
      "2026-01-01T00:00:00Z",
    );
    const w2 = buildSnapshotWitness(
      (fingerprintOf(PROJ, regions) as unknown as { digest: string }).digest,
      PROJ,
      regions,
      "999",
      "2030-12-31T23:59:59Z",
    );
    expect(w1.fingerprint.equals(w2.fingerprint)).toBe(true);
    expect(w1.blobContent).toBe(w2.blobContent);
    expect(w1.snapshot.revision).toBe("1");
    expect(w2.snapshot.revision).toBe("999"); // orthogonality preserved
  });

  it("serialization/persistence round-trip -> fingerprint stable (no A/B representation split)", () => {
    const regions = [
      entry("/a", file("/repo/a"), fProbe("mtime-1")),
      entry("/w", worktree("/repo/w"), gProbe("head-1", true)),
    ];
    const original = fingerprintOf(PROJ, regions);
    const blob = snapshotBlobContent(PROJ, regions);
    const parsed = parseSnapshotBlob(blob);
    const roundTripped = fingerprintOf(parsed.projectId, parsed.regions);
    expect(roundTripped.equals(original)).toBe(true);
    // blob re-serialization is byte-identical (canonicalization is internal)
    expect(snapshotBlobContent(parsed.projectId, parsed.regions)).toBe(blob);
  });

  it("same fingerprint legally appears at different revisions; A->B->A keeps A's fingerprint", () => {
    const stateA = [entry("/a", file("/x"), fProbe("stable"))];
    const stateB = [entry("/a", file("/x"), fProbe("changed"))];
    const fpA1 = fingerprintOf(PROJ, stateA);
    const fpB = fingerprintOf(PROJ, stateB);
    const fpA2 = fingerprintOf(PROJ, stateA);
    expect(fpA1.equals(fpA2)).toBe(true); // A -> B -> A: content identity returns
    expect(fpA1.equals(fpB)).toBe(false);
    // revision identity is the counter's business (P11-001) — snapshots merely
    // carry both fields orthogonally:
    const w = buildSnapshotWitness(
      (fpA1 as unknown as { digest: string }).digest,
      PROJ,
      stateA,
      "7",
      "t",
    );
    expect(w.snapshot.revision).toBe("7");
    expect(w.fingerprint.equals(fpA2)).toBe(true);
  });

  it("different projects with identical content produce different fingerprints (project scoping)", () => {
    const regions = [entry("/a", file("/x"), fProbe())];
    expect(
      fingerprintOf("prj-A", regions).equals(fingerprintOf("prj-B", regions)),
    ).toBe(false);
  });

  it("fingerprint input bytes are exposed for audit; canonical ordering is internal", () => {
    const e1 = entry("/a", file("/a"), fProbe());
    const e2 = entry("/b", file("/b"), fProbe());
    expect(fingerprintInputBytes(PROJ, [e1, e2])).toBe(
      fingerprintInputBytes(PROJ, [e2, e1]),
    );
  });
});

describe("P11-002 malformed blob handling (typed failure, no silent re-meaning)", () => {
  it("garbage blob -> SnapshotBlobFormatError", () => {
    expect(() => parseSnapshotBlob("not-a-blob")).toThrow(
      SnapshotBlobFormatError,
    );
    expect(() => parseSnapshotBlob("")).toThrow(SnapshotBlobFormatError);
    expect(() => parseSnapshotBlob("p11-snapshot-v1\nnotjson\nrest")).toThrow(
      SnapshotBlobFormatError,
    );
  });

  it("truncated region line -> SnapshotBlobFormatError", () => {
    const blob = `p11-snapshot-v1\n"prj"\nbroken-line-without-pipes`;
    expect(() => parseSnapshotBlob(blob)).toThrow(SnapshotBlobFormatError);
  });
});

describe("P11-002 fingerprint purity audit", () => {
  it("fingerprint API surface still exposes only equals (no ordering regression from P11-001)", () => {
    const fp = fingerprintOf(PROJ, [entry("/a", file("/a"), fProbe())]);
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(fp)).filter(
      (k) => k !== "constructor",
    );
    expect(keys).toEqual(["equals"]);
  });
});
