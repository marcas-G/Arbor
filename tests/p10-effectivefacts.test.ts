import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { QueryResult } from "../packages/domain/dist/index.js";
import { parse, WorkId, WorkspaceId } from "../packages/domain/dist/index.js";
import type { ProjectionStale } from "../packages/ports/src/errors.js";
import {
  deriveEffectiveFacts,
  EFFECTIVE_FACTS_INPUTS,
  enforceFreshnessBarrier,
  lagOf,
  projectionStaleRefusal,
  requiredWatermark,
  resolveBarrier,
  withFreshnessEnvelope,
} from "../packages/projection-runtime/src/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertInboxRow,
  insertProjectRootRow,
  insertVerificationRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Project,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000e1");
const _W_OTHER = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000e2");

const seedFacts = seedCanonical(
  Effect.gen(function* () {
    yield* insertProjectRootRow(p10Root, p10Project);
    yield* insertWorkspaceRow(
      { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_ROOT, workspaceId: p10Root, objective: "effective facts" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    // open (Unsatisfied) + terminal (Satisfied) dependencies
    yield* insertDependencyRow({
      dependencyId: "dep_open_1",
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Child,
      state: "Unsatisfied",
    });
    yield* insertDependencyRow({
      dependencyId: "dep_done_1",
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Child,
      state: "Satisfied",
    });
    // open + concluded verifications for the workspace's work
    yield* insertVerificationRow({
      verificationId: "ver_open_1",
      workId: W_ROOT,
      targetWorkRevision: 0,
      ownerWorkspaceId: p10Root,
      executionIds: [],
      state: "Open",
    });
    yield* insertVerificationRow({
      verificationId: "ver_done_1",
      workId: W_ROOT,
      targetWorkRevision: 0,
      ownerWorkspaceId: p10Root,
      executionIds: [],
      state: "Concluded",
      verdict: "Pass",
    });
    yield* insertInboxRow({
      workspaceId: p10Root,
      entryKey: "msg:msg_live_1",
      kind: "Message",
      summary: "hello",
      admittedAt: "t1",
    });
    yield* insertInboxRow({
      workspaceId: p10Root,
      entryKey: "msg:msg_gone_1",
      kind: "Message",
      summary: "consumed",
      admittedAt: "t0",
      consumedAt: "t2",
    });
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-0000000000a1",
      projectId: p10Project,
      eventType: "WorkspaceCreated",
      payload: {},
      occurredAt: "t1",
    });
  }),
);

describe("P10-005 EffectiveFacts — frozen definition inputs (03 §1)", () => {
  it("the input list is frozen exactly — no more, no less", () => {
    expect([...EFFECTIVE_FACTS_INPUTS]).toEqual([
      "responsibility",
      "boundary",
      "policyCaps",
      "openDependencies",
      "currentWork",
      "openVerifications",
      "unconsumedInboxMarkers",
    ]);
  });

  it("snapshot facts carry exactly the frozen keys; terminal/consumed facts are filtered; watermark = journal sequence", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedFacts;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const snapshot = yield* deriveEffectiveFacts(
          p10Root,
          deps.effectiveFacts,
        );

        expect(snapshot.workspaceId).toBe(p10Root);
        expect(Object.keys(snapshot.facts).sort()).toEqual(
          [...EFFECTIVE_FACTS_INPUTS].sort(),
        );
        // responsibility + boundary + policy caps come from the workspace row
        expect(snapshot.facts.responsibility.definition.purpose).toBe("p10");
        expect(snapshot.facts.responsibility.revision).toBe(0);
        expect(snapshot.facts.boundary.boundary.addresses).toEqual([]);
        expect(snapshot.facts.policyCaps.policy).toEqual({});
        expect(snapshot.facts.policyCaps.revision).toBe(0);
        // only the OPEN dependency survives, state+binding exactly
        expect(snapshot.facts.openDependencies).toEqual([
          {
            dependencyId: "dep_open_1",
            state: "Unsatisfied",
            binding: { _tag: "WorkspaceBound", workspaceId: p10Child },
          },
        ]);
        // current work marker
        expect(snapshot.facts.currentWork).toEqual({
          workId: W_ROOT,
          objective: "effective facts",
          lifecycle: "Open",
        });
        // only the OPEN verification survives
        expect(
          snapshot.facts.openVerifications.map((v) => v.verificationId),
        ).toEqual(["ver_open_1"]);
        // only the UNCONSUMED inbox marker survives
        expect(snapshot.facts.unconsumedInboxMarkers).toEqual([
          {
            entryKey: "msg:msg_live_1",
            kind: "Message",
            summary: "hello",
            admittedAt: "t1",
          },
        ]);
        // watermark: the journal sequence the snapshot reflects (1 event)
        expect(snapshot.watermark).toBe(1);

        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("no current work renders null; unknown workspace is a typed read failure", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedFacts;
        const deps = yield* makeP10Deps();

        const childSnapshot = yield* deriveEffectiveFacts(
          p10Child,
          deps.effectiveFacts,
        );
        expect(childSnapshot.facts.currentWork).toBeNull();
        expect(childSnapshot.facts.openDependencies).toEqual([]);

        const failure = yield* Effect.flip(
          deriveEffectiveFacts(
            parse(WorkspaceId)("ws_00000000-0000-7000-8000-00000000dead"),
            deps.effectiveFacts,
          ),
        );
        expect(failure._tag).toBe("ProjectionReadFailure");
      }),
      makeP10App(),
    );
  });
});

describe("P10-005 GQ2 single source (03 §1)", () => {
  const srcDir = join(
    import.meta.dirname,
    "..",
    "packages",
    "projection-runtime",
    "src",
  );
  const walk = (
    dir: string,
    sink: Array<string> = [],
  ): ReadonlyArray<string> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, sink);
      } else if (entry.name.endsWith(".ts")) {
        sink.push(path);
      }
    }
    return sink;
  };

  it("deriveEffectiveFacts is defined exactly once — no second derivation path remains", () => {
    const files = walk(srcDir);
    const definers = files.filter((path) =>
      /export const deriveEffectiveFacts\b/.test(readFileSync(path, "utf8")),
    );
    expect(definers).toEqual([join(srcDir, "effective-facts.ts")]);
    // the frozen input vocabulary lives only in the single-source module
    const inputDefiners = files.filter((path) =>
      readFileSync(path, "utf8").includes("EFFECTIVE_FACTS_INPUTS"),
    );
    expect(inputDefiners).toEqual([join(srcDir, "effective-facts.ts")]);
  });
});

describe("P10-005 freshness barrier (03 §2; GQ5, no implicit RYW)", () => {
  it("lag = L − w, clamped at zero", () => {
    expect(lagOf(3, 10)).toBe(7);
    expect(lagOf(10, 10)).toBe(0);
    expect(lagOf(12, 10)).toBe(0);
  });

  it("requiredWatermark: minWatermark floor and maxLag-derived floor reduce to the same mechanism", () => {
    expect(requiredWatermark({ minWatermark: 42 }, 100)).toBe(42);
    expect(requiredWatermark({ maxLag: 3 }, 100)).toBe(97);
    expect(requiredWatermark({ minWatermark: 42, maxLag: 3 }, 100)).toBe(97);
    expect(requiredWatermark({ maxLag: 500 }, 100)).toBe(0);
  });

  it("resolveBarrier: absent barrier always satisfied; satisfied vs catch-up for both forms", () => {
    expect(resolveBarrier(undefined, 0, 10)).toEqual({
      _tag: "Satisfied",
      lag: 10,
    });
    expect(resolveBarrier({ minWatermark: 5 }, 5, 10)).toEqual({
      _tag: "Satisfied",
      lag: 5,
    });
    expect(resolveBarrier({ minWatermark: 8 }, 5, 10)).toEqual({
      _tag: "CatchUp",
      fromSequence: 6,
      toSequence: 8,
      lag: 5,
    });
    expect(resolveBarrier({ maxLag: 2 }, 5, 10)).toEqual({
      _tag: "CatchUp",
      fromSequence: 6,
      toSequence: 8,
      lag: 5,
    });
    // minWatermark beyond the frontier: catch-up target is bounded by L
    expect(resolveBarrier({ minWatermark: 99 }, 5, 10)).toEqual({
      _tag: "CatchUp",
      fromSequence: 6,
      toSequence: 10,
      lag: 5,
    });
  });

  it("typed staleness marker carries the Problem vocabulary", () => {
    const stale: ProjectionStale = projectionStaleRefusal({
      barrier: { maxLag: 0 },
      watermark: 4,
      lastSequence: 9,
    });
    expect(stale._tag).toBe("ProjectionStale");
    expect(stale.code).toBe("projection/stale");
    expect(stale.retryDisposition).toBe("retryable");
    expect(stale.safeDetails).toMatchObject({ watermark: 4, lag: 5 });
  });

  it("enforceFreshnessBarrier blocks on a bounded catch-up read, then serves — and refuses with the typed marker when catch-up cannot close the gap", async () => {
    let watermark = 4;
    const value = { rows: [1, 2, 3] };

    const blocked = await Effect.runPromise(
      enforceFreshnessBarrier({
        barrier: { minWatermark: 9 },
        lastSequence: 9,
        readSnapshot: () =>
          Effect.succeed(withFreshnessEnvelope(value, watermark, 9)),
        catchUp: (from, to) =>
          Effect.sync(() => {
            expect(from).toBe(5);
            expect(to).toBe(9);
            watermark = 9;
            return watermark;
          }),
      }),
    );
    expect(blocked.watermark).toBe(9);
    expect(blocked.lag).toBe(0);
    expect(blocked.value).toEqual(value);

    const refused = await Effect.runPromise(
      Effect.flip(
        enforceFreshnessBarrier({
          barrier: { maxLag: 1 },
          lastSequence: 9,
          readSnapshot: () =>
            Effect.succeed(withFreshnessEnvelope(value, 4, 9)),
          catchUp: () => Effect.succeed(4),
        }),
      ),
    );
    expect(refused._tag).toBe("ProjectionStale");
    expect((refused as ProjectionStale).safeDetails.watermark).toBe(4);
  });

  it("no implicit RYW: write-then-immediate-read MAY lag (served, observable); the barrier forces catch-up", async () => {
    // The writer appended up to sequence 10 (canonical L = 10); the
    // projection has only reflected 7. A plain read is served with the
    // observable lag — NOT refused, NOT silently current (no RYW).
    let projectionWatermark = 7;
    const lastSequence = 10;
    const readSnapshot = () =>
      Effect.succeed(
        withFreshnessEnvelope("facts", projectionWatermark, lastSequence),
      );

    const plain: QueryResult<string> = await Effect.runPromise(
      enforceFreshnessBarrier({
        barrier: undefined,
        lastSequence,
        readSnapshot,
        catchUp: () => Effect.succeed(projectionWatermark),
      }),
    );
    expect(plain.watermark).toBe(7);
    expect(plain.lag).toBe(3);
    expect(plain.value).toBe("facts");

    // The reader that needs its own write passes the barrier explicitly.
    const forced = await Effect.runPromise(
      enforceFreshnessBarrier({
        barrier: { minWatermark: 10 },
        lastSequence,
        readSnapshot,
        catchUp: (_from, to) =>
          Effect.sync(() => {
            projectionWatermark = to;
            return to;
          }),
      }),
    );
    expect(forced.watermark).toBe(10);
    expect(forced.lag).toBe(0);
  });
});
