import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type DriftError,
  type EnvironmentDriftDeps,
  probeDrift,
} from "../packages/application/src/environment-drift.js";
import {
  type DriftSubmissionFace,
  startupDriftProbe,
} from "../packages/application/src/environment-drift-startup.js";
import { fingerprintOf } from "../packages/application/src/snapshot-fingerprint.js";
import {
  type EnvironmentFingerprint,
  type ProjectId,
  type ResourceAddress,
  type SnapshotRegionEntry,
  snapshotBlobContent,
} from "../packages/domain/src/index.js";
import type {
  EnvironmentChangeRecord,
  EnvironmentObservation,
  EnvironmentResolverError,
  EnvironmentResolverService,
  RecordEnvironmentChangeOutcome,
  ResolverObservation,
} from "../packages/ports/src/index.js";

const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789dd" as never as ProjectId;

const ADDRESSES: ReadonlyArray<ResourceAddress> = [
  { _tag: "FileTree", path: "/a" },
  { _tag: "FileTree", path: "/b" },
];

const ftEntry = (path: string, mtime: string): SnapshotRegionEntry => ({
  address: { _tag: "FileTree", path },
  resolved: {
    resourceSpaceId: "fs",
    normalizedRegion: path,
  } as SnapshotRegionEntry["resolved"],
  probe: { kind: "FileTree", exists: true, mtime },
});

// colon-free probe values: parseSnapshotBlob's v1 line format cannot
// round-trip ISO-8601 colons (conservative fallback would mask the diff)
const ANCHORED_ENTRIES = [ftEntry("/a", "mtime-a1"), ftEntry("/b", "mtime-b1")];
const CANDIDATE_ENTRIES = [
  ftEntry("/a", "mtime-a2"),
  ftEntry("/b", "mtime-b1"),
];
const CANDIDATE_REMOVED_ENTRIES = [ANCHORED_ENTRIES[0] as SnapshotRegionEntry];

const anchoredFp = fingerprintOf(PROJECT, ANCHORED_ENTRIES);
const candidateFp = fingerprintOf(PROJECT, CANDIDATE_ENTRIES);
const removedCandidateFp = fingerprintOf(PROJECT, CANDIDATE_REMOVED_ENTRIES);

const observationOf = (
  entries: ReadonlyArray<SnapshotRegionEntry>,
  observedRevision = "1",
): ResolverObservation => ({
  projectId: PROJECT,
  observedRevision,
  fingerprint: fingerprintOf(PROJECT, entries),
  snapshotBlobRef: `blob:${fingerprintOf(PROJECT, entries).digest}`,
  changedRegions: entries.map((entry) => entry.resolved),
  entries,
});

const anchoredChange = (
  next: EnvironmentFingerprint,
  blobRef: string,
): EnvironmentChangeRecord => ({
  changeId: "ch-anchored",
  projectId: PROJECT,
  fromRevision: "0",
  toRevision: "1",
  previousFingerprint: "",
  nextFingerprint: next.digest,
  snapshotBlobRef: blobRef,
  changedRegions: [],
  cause: "Governance",
  recordedAt: "2026-01-01T00:00:00.000Z",
});

// -- fakes (controllable fingerprint/regions; observation-only by hand) --

const makeResolver = (
  behavior:
    | { readonly observe: ResolverObservation }
    | { readonly fail: EnvironmentResolverError },
) => {
  const calls: Array<{ projectId: ProjectId; addresses: unknown }> = [];
  const service: EnvironmentResolverService = {
    observe: (projectId, addresses) =>
      Effect.suspend(() => {
        calls.push({ projectId, addresses });
        if ("fail" in behavior) {
          return Effect.fail(behavior.fail);
        }
        return Effect.succeed(behavior.observe);
      }),
  };
  return { service, calls };
};

const makeChanges = (
  behavior:
    | { readonly latest: Option.Option<EnvironmentChangeRecord> }
    | {
        readonly fail: {
          readonly _tag: "ChangeReadFailure";
          readonly cause: unknown;
        };
      },
) => ({
  latestChange: (_projectId: ProjectId) =>
    "fail" in behavior
      ? Effect.fail(behavior.fail)
      : Effect.succeed(behavior.latest),
});

const makeRevisions = (
  behavior:
    | { readonly current: Option.Option<string> }
    | {
        readonly fail: {
          readonly _tag: "RevisionReadFailure";
          readonly cause: unknown;
        };
      },
) => ({
  current: (_projectId: ProjectId) =>
    "fail" in behavior
      ? Effect.fail(behavior.fail)
      : Effect.succeed(behavior.current),
});

const blobReaderOf = (content: string | undefined) => ({
  readBlob: (_blobRef: string) => Effect.succeed(content),
});

const makeRec = (
  outcome: RecordEnvironmentChangeOutcome = {
    _tag: "Advanced",
    fromRevision: "1",
    toRevision: "2",
  },
) => {
  const calls: Array<{
    observation: EnvironmentObservation;
    cause: string;
  }> = [];
  const face: DriftSubmissionFace = {
    record: (observation, cause) =>
      Effect.suspend(() => {
        calls.push({ observation, cause });
        return Effect.succeed(outcome);
      }),
  };
  return { face, calls };
};

const noDriftDeps = (
  deps: Partial<EnvironmentDriftDeps> = {},
): EnvironmentDriftDeps => ({
  resolver: makeResolver({ observe: observationOf(ANCHORED_ENTRIES) }).service,
  changes: makeChanges({
    latest: Option.some(
      anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
    ),
  }),
  revisions: makeRevisions({ current: Option.some("1") }),
  anchoredSnapshot: blobReaderOf(
    snapshotBlobContent(PROJECT, ANCHORED_ENTRIES),
  ),
  ...deps,
});

describe("p11-drift explicit snapshot-diff drift detection", () => {
  it("NoDrift: anchored fingerprint == candidate fingerprint -> report at revision, no change side effects", async () => {
    const resolver = makeResolver({
      observe: observationOf(ANCHORED_ENTRIES),
    });
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        ...noDriftDeps(),
        resolver: resolver.service,
      }),
    );

    expect(report).toEqual({ _tag: "NoDrift", atRevision: "1" });
    expect(resolver.calls).toEqual([
      { projectId: PROJECT, addresses: ADDRESSES },
    ]);
  });

  it("Drift: report carries anchored/candidate fingerprints, changedRegions (region diff), candidateRevision", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({
          latest: Option.some(
            anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
          ),
        }),
        revisions: makeRevisions({ current: Option.some("1") }),
        anchoredSnapshot: blobReaderOf(
          snapshotBlobContent(PROJECT, ANCHORED_ENTRIES),
        ),
      }),
    );

    expect(report._tag).toBe("Drift");
    if (report._tag !== "Drift") {
      return;
    }
    expect(report.anchoredFingerprint.digest).toBe(anchoredFp.digest);
    expect(report.candidateFingerprint.digest).toBe(candidateFp.digest);
    expect(report.candidateSnapshotBlobRef).toBe(`blob:${candidateFp.digest}`);
    expect(report.candidateRevision).toBe("1");
    expect(report.regionDiffMode).toBe("RegionDiff");
    expect(report.changedRegions).toEqual([
      (ANCHORED_ENTRIES[0] as SnapshotRegionEntry).resolved,
    ]);
  });

  it("Drift: region removed from candidate -> removed region reported as changed", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_REMOVED_ENTRIES),
        }).service,
        changes: makeChanges({
          latest: Option.some(
            anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
          ),
        }),
        revisions: makeRevisions({ current: Option.some("1") }),
        anchoredSnapshot: blobReaderOf(
          snapshotBlobContent(PROJECT, ANCHORED_ENTRIES),
        ),
      }),
    );

    expect(report._tag).toBe("Drift");
    if (report._tag !== "Drift") {
      return;
    }
    expect(report.candidateFingerprint.digest).toBe(removedCandidateFp.digest);
    expect(report.changedRegions).toEqual([
      (ANCHORED_ENTRIES[1] as SnapshotRegionEntry).resolved,
    ]);
  });

  it("Drift: anchored snapshot not parseable -> conservative: all candidate regions changed, mode noted", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({
          latest: Option.some(
            anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
          ),
        }),
        revisions: makeRevisions({ current: Option.some("1") }),
      }),
    );

    expect(report._tag).toBe("Drift");
    if (report._tag !== "Drift") {
      return;
    }
    expect(report.regionDiffMode).toBe("Conservative");
    expect(report.changedRegions).toEqual(
      CANDIDATE_ENTRIES.map((entry) => entry.resolved),
    );
  });

  it("Drift: malformed anchored blob content -> conservative", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({
          latest: Option.some(
            anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
          ),
        }),
        revisions: makeRevisions({ current: Option.some("1") }),
        anchoredSnapshot: blobReaderOf("not-a-snapshot-blob"),
      }),
    );

    expect(report._tag).toBe("Drift");
    if (report._tag !== "Drift") {
      return;
    }
    expect(report.regionDiffMode).toBe("Conservative");
  });

  it("probe failure -> typed DriftError, never swallowed", async () => {
    const failure: EnvironmentResolverError = {
      _tag: "ProbeFailed",
      cause: new Error("stat EACCES"),
    };
    const error = await Effect.runPromise(
      Effect.flip(
        probeDrift(PROJECT, ADDRESSES, {
          resolver: makeResolver({ fail: failure }).service,
          changes: makeChanges({
            latest: Option.some(
              anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
            ),
          }),
          revisions: makeRevisions({ current: Option.some("1") }),
        }),
      ),
    );
    expect(error).toEqual(failure);

    const readError: DriftError = {
      _tag: "ChangeReadFailure",
      cause: new Error("sqlite"),
    };
    const changeReadFailure = await Effect.runPromise(
      Effect.flip(
        probeDrift(PROJECT, ADDRESSES, {
          resolver: makeResolver({
            observe: observationOf(CANDIDATE_ENTRIES),
          }).service,
          changes: makeChanges({ fail: readError }),
          revisions: makeRevisions({ current: Option.some("1") }),
        }),
      ),
    );
    expect(changeReadFailure).toEqual(readError);

    const revisionReadFailure = await Effect.runPromise(
      Effect.flip(
        probeDrift(PROJECT, ADDRESSES, {
          resolver: makeResolver({
            observe: observationOf(CANDIDATE_ENTRIES),
          }).service,
          changes: makeChanges({ latest: Option.none() }),
          revisions: makeRevisions({
            fail: { _tag: "RevisionReadFailure", cause: "down" },
          }),
        }),
      ),
    );
    expect(revisionReadFailure).toEqual({
      _tag: "RevisionReadFailure",
      cause: "down",
    });
  });

  it("anchor missing (no change record) -> BasisUninitialized report: all candidate regions changed", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({ latest: Option.none() }),
        revisions: makeRevisions({ current: Option.some("1") }),
      }),
    );

    expect(report._tag).toBe("BasisUninitialized");
    if (report._tag !== "BasisUninitialized") {
      return;
    }
    expect(report.candidateFingerprint.digest).toBe(candidateFp.digest);
    expect(report.candidateSnapshotBlobRef).toBe(`blob:${candidateFp.digest}`);
    expect(report.candidateRevision).toBe("1");
    expect(report.storeRevision).toBe("1");
    expect(report.changedRegions).toEqual(
      CANDIDATE_ENTRIES.map((entry) => entry.resolved),
    );
  });

  it("anchor missing and store empty -> storeRevision undefined", async () => {
    const report = await Effect.runPromise(
      probeDrift(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({ latest: Option.none() }),
        revisions: makeRevisions({ current: Option.none() }),
      }),
    );

    expect(report._tag).toBe("BasisUninitialized");
    if (report._tag === "BasisUninitialized") {
      expect(report.storeRevision).toBeUndefined();
    }
  });
});

describe("p11-drift startup seam (autoSubmit default off)", () => {
  it("default: Drift report returned, REC never called (proposal only)", async () => {
    const rec = makeRec();
    const outcome = await Effect.runPromise(
      startupDriftProbe(PROJECT, ADDRESSES, {
        resolver: makeResolver({
          observe: observationOf(CANDIDATE_ENTRIES),
        }).service,
        changes: makeChanges({
          latest: Option.some(
            anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
          ),
        }),
        revisions: makeRevisions({ current: Option.some("1") }),
        rec: rec.face,
      }),
    );

    expect(outcome.report._tag).toBe("Drift");
    expect(outcome.submission).toEqual({ _tag: "NotRequired" });
    expect(rec.calls).toHaveLength(0);
  });

  it("autoSubmit=false explicit: REC never called", async () => {
    const rec = makeRec();
    const outcome = await Effect.runPromise(
      startupDriftProbe(
        PROJECT,
        ADDRESSES,
        {
          ...noDriftDeps({
            resolver: makeResolver({
              observe: observationOf(CANDIDATE_ENTRIES),
            }).service,
          }),
          rec: rec.face,
        },
        { autoSubmit: false },
      ),
    );

    expect(outcome.report._tag).toBe("Drift");
    expect(outcome.submission).toEqual({ _tag: "NotRequired" });
    expect(rec.calls).toHaveLength(0);
  });

  it("autoSubmit=true: REC called with cause ExternalDrift and expectedRevision = candidateRevision", async () => {
    const rec = makeRec();
    const outcome = await Effect.runPromise(
      startupDriftProbe(
        PROJECT,
        ADDRESSES,
        {
          resolver: makeResolver({
            observe: observationOf(CANDIDATE_ENTRIES),
          }).service,
          changes: makeChanges({
            latest: Option.some(
              anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
            ),
          }),
          revisions: makeRevisions({ current: Option.some("1") }),
          rec: rec.face,
        },
        { autoSubmit: true },
      ),
    );

    expect(outcome.report._tag).toBe("Drift");
    expect(outcome.submission).toEqual({
      _tag: "Submitted",
      outcome: { _tag: "Advanced", fromRevision: "1", toRevision: "2" },
    });
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    if (call === undefined) {
      throw new Error("REC not called");
    }
    expect(call.cause).toBe("ExternalDrift");
    expect(call.observation).toEqual({
      projectId: PROJECT,
      observedRevision: "1",
      fingerprint: candidateFp,
      snapshotBlobRef: `blob:${candidateFp.digest}`,
      changedRegions: CANDIDATE_ENTRIES.map((entry) => entry.resolved),
    });
  });

  it("autoSubmit=true without REC service -> report surfaced, submission skipped (no failure)", async () => {
    const outcome = await Effect.runPromise(
      startupDriftProbe(
        PROJECT,
        ADDRESSES,
        {
          resolver: makeResolver({
            observe: observationOf(CANDIDATE_ENTRIES),
          }).service,
          changes: makeChanges({
            latest: Option.some(
              anchoredChange(anchoredFp, `blob:${anchoredFp.digest}`),
            ),
          }),
          revisions: makeRevisions({ current: Option.some("1") }),
        },
        { autoSubmit: true },
      ),
    );

    expect(outcome.report._tag).toBe("Drift");
    expect(outcome.submission).toEqual({ _tag: "SkippedNoSubmissionService" });
  });

  it("autoSubmit=true on NoDrift / BasisUninitialized -> REC never called", async () => {
    const rec = makeRec();
    const noDrift = await Effect.runPromise(
      startupDriftProbe(
        PROJECT,
        ADDRESSES,
        { ...noDriftDeps(), rec: rec.face },
        { autoSubmit: true },
      ),
    );
    expect(noDrift.report._tag).toBe("NoDrift");
    expect(noDrift.submission).toEqual({ _tag: "NotRequired" });

    const uninit = await Effect.runPromise(
      startupDriftProbe(
        PROJECT,
        ADDRESSES,
        {
          resolver: makeResolver({
            observe: observationOf(CANDIDATE_ENTRIES),
          }).service,
          changes: makeChanges({ latest: Option.none() }),
          revisions: makeRevisions({ current: Option.some("1") }),
          rec: rec.face,
        },
        { autoSubmit: true },
      ),
    );
    expect(uninit.report._tag).toBe("BasisUninitialized");
    expect(uninit.submission).toEqual({ _tag: "NotRequired" });
    expect(rec.calls).toHaveLength(0);
  });
});
