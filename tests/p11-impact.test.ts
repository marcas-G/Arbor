import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { evaluateEnvironmentImpact } from "../packages/application/src/environment-impact.js";
import {
  deliverEnvironmentChangedWake,
  type EnvironmentChangedConclusion,
  type EnvironmentWakeDependencies,
} from "../packages/application/src/environment-impact-wake.js";
import {
  type CanonicalResourceRegion,
  CommandId,
  parse,
  type WakeReason,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import type { SchedulerDecision } from "../packages/ports/src/index.js";
import {
  ExecutionScheduler,
  TransactionPort,
  WorkRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  runP7,
} from "./support/p7-app.js";

// -- narrow-side fixtures (pure; resolved canonical regions only) --

const WS_A = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1");
const WS_B = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b1");
const WORK_A1 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const WORK_A2 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2");
const WORK_B1 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b1");

/** Resolved canonical region fixture — resourceSpaceId + normalized
 * region, never a raw ResourceAddress (round-1 fix). */
const region = (
  path: string,
  resourceSpaceId = "space-fs",
): CanonicalResourceRegion =>
  ({
    resourceSpaceId,
    normalizedRegion: { kind: "FileTree", path },
  }) as CanonicalResourceRegion;

describe("p11-impact (P11-006 wake broad / invalidate narrow)", () => {
  it("workspace boundary overlap cascades to its works and claims; disjoint objects stay out (narrow)", () => {
    const report = evaluateEnvironmentImpact({
      changedRegions: [region("/pkg-a")],
      workspaces: [
        // boundary inside the changed region -> overlap
        { workspaceId: WS_A, boundaryRegions: [region("/pkg-a/module-1")] },
        // disjoint boundary
        { workspaceId: WS_B, boundaryRegions: [region("/pkg-z")] },
      ],
      works: [
        // WS_A cascade (own boundary elsewhere)
        {
          workId: WORK_A1,
          workspaceId: WS_A,
          boundaryRegions: [region("/elsewhere")],
        },
        // WS_B work, disjoint
        {
          workId: WORK_B1,
          workspaceId: WS_B,
          boundaryRegions: [region("/pkg-z")],
        },
        // WS_B work whose OWN boundary overlaps the change
        {
          workId: WORK_A2,
          workspaceId: WS_B,
          boundaryRegions: [region("/pkg-a/sub")],
        },
      ],
      activeClaims: [
        // WS_A cascade (own regions elsewhere)
        {
          claimId: "clm_a1",
          workspaceId: WS_A,
          regions: [region("/elsewhere")],
        },
        // WS_B claim whose OWN regions overlap the change
        {
          claimId: "clm_b1",
          workspaceId: WS_B,
          regions: [region("/pkg-a/sub/deep")],
        },
        // WS_B claim, disjoint
        {
          claimId: "clm_b2",
          workspaceId: WS_B,
          regions: [region("/pkg-z")],
        },
      ],
    });
    expect(report.affectedWorkspaceIds).toEqual([WS_A]);
    expect(report.affectedWorkIds).toEqual([WORK_A1, WORK_A2]);
    expect(report.affectedClaimIds).toEqual(["clm_a1", "clm_b1"]);
  });

  it("overlap is computed on resolved canonical regions — same path in a different resource space never matches", () => {
    const report = evaluateEnvironmentImpact({
      changedRegions: [region("/repo/trunk", "space-git")],
      workspaces: [
        {
          workspaceId: WS_A,
          boundaryRegions: [region("/repo/trunk", "space-git")],
        },
        {
          workspaceId: WS_B,
          boundaryRegions: [region("/repo/trunk", "space-fs")],
        },
      ],
      works: [],
      activeClaims: [],
    });
    expect(report.affectedWorkspaceIds).toEqual([WS_A]);
  });

  it("a changed child region impacts the parent-boundary holder (regionContains semantics)", () => {
    const report = evaluateEnvironmentImpact({
      changedRegions: [region("/src/lib")],
      workspaces: [{ workspaceId: WS_A, boundaryRegions: [region("/src")] }],
      works: [
        { workId: WORK_A1, workspaceId: WS_A, boundaryRegions: [] },
        { workId: WORK_B1, workspaceId: WS_B, boundaryRegions: [] },
      ],
      activeClaims: [],
    });
    expect(report.affectedWorkspaceIds).toEqual([WS_A]);
    expect(report.affectedWorkIds).toEqual([WORK_A1]);
  });

  it("empty changedRegions yields an empty report", () => {
    const report = evaluateEnvironmentImpact({
      changedRegions: [],
      workspaces: [{ workspaceId: WS_A, boundaryRegions: [region("/src")] }],
      works: [
        {
          workId: WORK_A1,
          workspaceId: WS_A,
          boundaryRegions: [region("/src")],
        },
      ],
      activeClaims: [
        { claimId: "clm_a1", workspaceId: WS_A, regions: [region("/src")] },
      ],
    });
    expect(report).toEqual({
      affectedWorkspaceIds: [],
      affectedWorkIds: [],
      affectedClaimIds: [],
    });
  });
});

// -- broad-side fixtures (P8 wake-channel harness pattern) --

const WORK_WAITER = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c2");
const WORK_WAITER2 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c3");
const CMD_WAITER = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d2");
const CMD_WAITER2 = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
);

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReason: WakeReason;
}

/** ExecutionScheduler stub (P8 wake-pipeline precedent): reevaluate is
 * recorded and decides Idle. */
const makeSchedulerStub = () => {
  const calls: SchedulerCall[] = [];
  const layer = Layer.succeed(
    ExecutionScheduler,
    ExecutionScheduler.of({
      reevaluate: (workspaceId, wakeReason) =>
        Effect.sync(() => {
          calls.push({ workspaceId, wakeReason });
          return { _tag: "Idle" } as SchedulerDecision;
        }),
      registerWorkWait: () => Effect.void,
      clearWorkWait: () => Effect.void,
      scheduleTimer: () => Effect.void,
      dueTimers: () => Effect.succeed([]),
    }),
  );
  return { calls, layer };
};

const makeWakeApp = () => {
  const scheduler = makeSchedulerStub();
  const base = makeP7App();
  return {
    calls: scheduler.calls,
    app: Layer.mergeAll(
      base,
      Layer.provide(WorkWaitStoreLive, base),
      scheduler.layer,
    ),
  };
};

const makeWakeDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies EnvironmentWakeDependencies;
});

const insertEnvWait = (
  workId: WorkId,
  environmentRef: string,
  observedRevision: string,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
      [
        workId,
        "Any",
        JSON.stringify([
          { _tag: "EnvironmentChanged", environmentRef, observedRevision },
        ]),
        "t",
        "t",
      ],
    );
  });

const waitOf = (workId: WorkId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const waits = yield* WorkWaitStore;
    return yield* tx.transact(waits.findByWork(workId));
  });

const seedFixture = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  for (const [workId, commandId] of [
    [WORK_WAITER, CMD_WAITER],
    [WORK_WAITER2, CMD_WAITER2],
  ] as const) {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  }
}) as Effect.Effect<void, unknown, never>;

/** The EnvironmentChanged event payload (frozen seven fields) plus the
 * environmentRef the waits' conditions carry (recovered from the project
 * row by the caller — the event does not duplicate it). */
const envConclusion = (): EnvironmentChangedConclusion => ({
  _tag: "EnvironmentChanged" as const,
  projectId: p7Project,
  environmentRef: "local",
  fromRevision: "1",
  toRevision: "2",
  previousFingerprint: "fp-1",
  nextFingerprint: "fp-2",
  snapshotBlobRef: "blob:fp-2",
  changedRegions: [region("/changed")],
  cause: "Governance",
});

describe("p11-impact broad wake (EnvironmentChanged, observedRevision < toRevision)", () => {
  it("waits on an older observedRevision are cleared and their workspace reevaluated once per workspace", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertEnvWait(WORK_WAITER, "local", "1");
        yield* insertEnvWait(WORK_WAITER2, "local", "0");
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverEnvironmentChangedWake(
          envConclusion(),
          deps,
        );
        expect(outcome.releasedWaits).toBe(2);
        expect(outcome.wokenWorkspaces).toEqual([p7RootWorkspace]);
        expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
        expect(yield* waitOf(WORK_WAITER2)).toEqual(Option.none());
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReason: { _tag: "EnvironmentChanged" },
          },
        ]);
      }),
      app,
    );
  });

  it("current or newer observedRevision never releases (equality is already-seen)", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertEnvWait(WORK_WAITER, "local", "2");
        yield* insertEnvWait(WORK_WAITER2, "local", "3");
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverEnvironmentChangedWake(
          envConclusion(),
          deps,
        );
        expect(outcome).toEqual({ releasedWaits: 0, wokenWorkspaces: [] });
        expect(Option.isSome(yield* waitOf(WORK_WAITER))).toBe(true);
        expect(Option.isSome(yield* waitOf(WORK_WAITER2))).toBe(true);
        expect(calls).toEqual([]);
      }),
      app,
    );
  });

  it("a wait on a foreign environmentRef never releases", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertEnvWait(WORK_WAITER, "staging", "1");
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverEnvironmentChangedWake(
          envConclusion(),
          deps,
        );
        expect(outcome).toEqual({ releasedWaits: 0, wokenWorkspaces: [] });
        expect(Option.isSome(yield* waitOf(WORK_WAITER))).toBe(true);
        expect(calls).toEqual([]);
      }),
      app,
    );
  });

  it("replay is a full no-op — clear is a DELETE no-op and no further reevaluate fires", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertEnvWait(WORK_WAITER, "local", "1");
        const deps = yield* makeWakeDeps;
        const first = yield* deliverEnvironmentChangedWake(
          envConclusion(),
          deps,
        );
        expect(first.releasedWaits).toBe(1);
        expect(calls.length).toBe(1);
        const replay = yield* deliverEnvironmentChangedWake(
          envConclusion(),
          deps,
        );
        expect(replay).toEqual({ releasedWaits: 0, wokenWorkspaces: [] });
        expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });
});
