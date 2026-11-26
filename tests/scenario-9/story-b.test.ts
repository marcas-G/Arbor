import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P12_MIGRATIONS,
  runMigrations,
  SchedulerTimerStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { newUuid7 } from "../../packages/application/src/index.js";
import {
  CommandId,
  type ExecutionId,
  parse,
  startVerification,
  VerificationId,
  WorkId,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { startupRecovery } from "../../packages/execution-runtime/src/index.js";
import {
  ExecutionScheduler,
  LeaseService,
  type SchedulerDecision,
  type SchedulerTimer,
  TransactionPort,
  VerificationRepository,
} from "../../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestPrincipal,
  runP7,
} from "../support/consumer-harness.js";
import { labeled } from "../support/harness-api.js";
import {
  attentionFacts,
  countEventsFor,
  durableFile,
  EXE_SB_CLEAN,
  EXE_SB_FACT,
  EXE_SB_PENDING,
  executionRowOf,
  G_MISSION,
  INSERT_EXECUTION,
  INSERT_INVOCATION,
  invocationRowOf,
  settleInvocation,
  sqlCount,
} from "./support.js";
import { countEvents, WREV } from "./support-fg.js";

// ---------------------------------------------------------------------------
// Story B wiring: makeP7App + durable timer store + scheduler probe
// (p9-timer-refire makeTimerApp construction pattern).
// ---------------------------------------------------------------------------

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReasonTag: string;
}

const makeSchedulerProbe = () => {
  const calls: SchedulerCall[] = [];
  const stub = Layer.succeed(
    ExecutionScheduler,
    ExecutionScheduler.of({
      reevaluate: (workspaceId, wakeReason) =>
        Effect.sync(() => {
          calls.push({ workspaceId, wakeReasonTag: wakeReason._tag });
          return { _tag: "Idle" } as SchedulerDecision;
        }),
      registerWorkWait: () => Effect.void,
      clearWorkWait: () => Effect.void,
      scheduleTimer: () => Effect.void,
      dueTimers: () => Effect.succeed([]),
    }),
  );
  return { calls, stub };
};

const makeStoryBApp = (filename: string) => {
  const base = makeP7App(filename);
  const scheduler = makeSchedulerProbe();
  const timers = Layer.provide(SchedulerTimerStoreLive, base);
  return {
    calls: scheduler.calls,
    app: Layer.mergeAll(base, timers, scheduler.stub),
  };
};

const INSERT_TIMER = (timerId: string, fireAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO scheduler_timers (timer_id, workspace_id, work_id, kind, fire_at, created_at) VALUES (?,?,NULL,'TimeReached',?,'t')",
      [timerId, p7RootWorkspace, fireAt],
    );
  });

const timerIds = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ timer_id: string }>(
      "SELECT timer_id FROM scheduler_timers ORDER BY timer_id",
    );
    return rows.map((row) => row.timer_id);
  });

const INSERT_EXPIRED_LEASE = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,0,'2000-01-01T00:00:00.000Z','t')",
      [executionId, "worker:story-b"],
    );
  });

/** P9-003 B-2 fixture: durable `ExecutionSettled(Completed)` fact for an
 * unsettled row (p9-recovery-driver INSERT_COMPLETION_FACT pattern). */
const INSERT_COMPLETION_FACT = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const settlement = {
      _tag: "Completed",
      result: {
        _tag: "CompletionClaimed",
        workRevision: 3,
        claimRef: `claim-accept-${executionId}`,
      },
    };
    yield* sql.unsafe(
      "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1",
      [p7Project],
    );
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "SELECT last_sequence FROM project_event_sequences WHERE project_id = ?",
      [p7Project],
    );
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    const sequence = Number(rows[0]!.last_sequence);
    yield* sql.unsafe(
      "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        `evt_${executionId}_${sequence}`,
        p7Project,
        sequence,
        "ExecutionSettled",
        1,
        "t",
        executionId,
        "user:gov",
        JSON.stringify({ executionId, settlement }),
      ],
    );
    return settlement;
  });

const WORK_B3 = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b3");
const VER_B1 = parse(VerificationId)(
  "ver_00000000-0000-7000-8000-0000000000b1",
);

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("-acceptance", () => {
  it("Story B-clean (06 §B1) [crash-injected]: dirty restart, all invocations settled — one T1 settles Interrupted(StopRequested) + completion fact → Completed; lease invalidated, timers re-fired, runnable re-driven, repeated T1 idempotent", async () => {
    expect(
      labeled("story-B-clean-dirty-restart", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const { calls, app } = makeStoryBApp(durableFile("b1"));
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION(EXE_SB_CLEAN, "t");
        const fact = yield* INSERT_COMPLETION_FACT(EXE_SB_FACT);
        yield* INSERT_EXECUTION(EXE_SB_FACT, null);
        yield* INSERT_EXPIRED_LEASE(EXE_SB_CLEAN);
        yield* INSERT_TIMER("tmr_sb_due", "2000-01-01T00:00:00.000Z");
        yield* INSERT_TIMER("tmr_sb_future", "2999-01-01T00:00:00.000Z");
        const first = yield* startupRecovery(p7TestPrincipal);
        expect([...first.recovery.settled].sort()).toEqual([
          EXE_SB_CLEAN,
          EXE_SB_FACT,
        ]);
        expect(first.recovery.escalated).toEqual([]);
        expect(first.recovery.invalidated).toBeGreaterThanOrEqual(1);
        const clean = yield* executionRowOf(EXE_SB_CLEAN);
        expect(clean?.settlement_kind).toBe("Interrupted");
        expect(JSON.parse(clean?.settlement_json ?? "null")).toEqual({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        const completed = yield* executionRowOf(EXE_SB_FACT);
        expect(completed?.settlement_kind).toBe("Completed");
        expect(JSON.parse(completed?.settlement_json ?? "null")).toEqual(fact);
        expect(
          first.firedTimers.map((timer: SchedulerTimer) => timer.timerId),
        ).toEqual(["tmr_sb_due"]);
        expect(yield* timerIds()).toEqual(["tmr_sb_future"]);
        expect(calls).toEqual([
          { workspaceId: p7RootWorkspace, wakeReasonTag: "Recovery" },
        ]);
        const recoveryCompletionCommandId = parse(CommandId)(
          `cmd_${newUuid7("recovery", `${EXE_SB_FACT}:completion`)}`,
        );
        const recoveryStopCommandId = parse(CommandId)(
          `cmd_${newUuid7("recovery", `${EXE_SB_CLEAN}:stop`)}`,
        );
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
            [recoveryCompletionCommandId],
          ),
        ).toBe(1);
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
            [recoveryStopCommandId],
          ),
        ).toBe(1);
        expect(yield* countEventsFor(EXE_SB_FACT, "ExecutionSettled")).toBe(2);
        // Crash during/after T1 → restart re-runs T1: idempotent re-entry.
        const commandsAfterFirst = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM commands",
        );
        const second = yield* startupRecovery(p7TestPrincipal);
        expect(second.recovery.settled).toEqual([]);
        expect(second.recovery.escalated).toEqual([]);
        expect(second.firedTimers).toEqual([]);
        expect(yield* timerIds()).toEqual(["tmr_sb_future"]);
        expect(calls).toHaveLength(1);
        expect(yield* countEventsFor(EXE_SB_CLEAN, "ExecutionSettled")).toBe(1);
        expect(yield* sqlCount("SELECT COUNT(*) AS count FROM commands")).toBe(
          commandsAfterFirst,
        );
      }),
      app,
    );
  });

  it("Story B-pending (06 §B2) [crash-injected]: dirty restart with unsettled four-tier invocations + pending wake + open verification + expired lease — four-tier dispositions, NonIdempotent escalates / NEVER Interrupted, facts durable and deduped", async () => {
    expect(
      labeled("story-B-pending-dirty-restart", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const { calls, app } = makeStoryBApp(durableFile("b2"));
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* p7SeedProject;
        const seeded = yield* p7SeedWork(
          WORK_B3,
          parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789b3"),
        );
        expect(seeded.resolution._tag).toBe("Committed");
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER_B1,
              workId: WORK_B3,
              targetWorkRevision: WREV(0),
              missionSnapshot: G_MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* INSERT_EXECUTION(EXE_SB_PENDING, "t");
        yield* INSERT_INVOCATION("tin_sb_ro", EXE_SB_PENDING, "ReadOnly");
        yield* INSERT_INVOCATION("tin_sb_idem", EXE_SB_PENDING, "Idempotent");
        yield* INSERT_INVOCATION("tin_sb_rec", EXE_SB_PENDING, "Reconcilable");
        yield* INSERT_INVOCATION("tin_sb_non", EXE_SB_PENDING, "NonIdempotent");
        yield* INSERT_TIMER("tmr_sbp_due", "2000-01-01T00:00:00.000Z");
        yield* INSERT_TIMER("tmr_sbp_future", "2999-01-01T00:00:00.000Z");
        yield* INSERT_EXPIRED_LEASE(EXE_SB_PENDING);
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?, 'Any', '[]', 't', 't')",
          [WORK_B3],
        );
        // T1 over the full pending-state fixture.
        const first = yield* startupRecovery(p7TestPrincipal);
        expect(first.recovery.settled).toEqual([]);
        expect(first.recovery.escalated).toEqual([EXE_SB_PENDING]);
        expect(first.recovery.invalidated).toBeGreaterThanOrEqual(1);
        expect(
          first.firedTimers.map((timer: SchedulerTimer) => timer.timerId),
        ).toEqual(["tmr_sbp_due"]);
        const pending = yield* executionRowOf(EXE_SB_PENDING);
        expect(pending?.settlement_kind).not.toBe("Interrupted");
        expect(pending?.settlement_kind).toBeNull();
        expect(pending?.stop_requested_at).not.toBeNull();
        expect(yield* attentionFacts(EXE_SB_PENDING)).toBe(1);
        // No tier was auto-replayed: every invocation still exactly one
        // row, none settled by the restart itself.
        for (const tin of [
          "tin_sb_ro",
          "tin_sb_idem",
          "tin_sb_rec",
          "tin_sb_non",
        ]) {
          const row = yield* invocationRowOf(tin);
          expect(row?.settlement_kind).toBeNull();
          expect(
            yield* sqlCount(
              "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
              [tin],
            ),
          ).toBe(1);
        }
        // D4/D5 fixtures survive: WorkWait intact, verification still Open.
        expect(
          yield* sqlCount("SELECT COUNT(*) AS count FROM work_waits"),
        ).toBe(1);
        const verification = yield* tx.transact(verifications.findById(VER_B1));
        expect(Option.isSome(verification)).toBe(true);
        expect(
          Option.isSome(verification)
            ? verification.value.state.status
            : "missing",
        ).toBe("Open");
        expect(yield* countEvents("VerificationConcluded")).toBe(0);
        expect(yield* countEvents("VerificationUnknown")).toBe(0);
        expect(yield* timerIds()).toEqual(["tmr_sbp_future"]);
        expect(calls).toHaveLength(1);
        // Repeated T1: idempotent — deduped fact, no re-fire, no settle.
        const second = yield* startupRecovery(p7TestPrincipal);
        expect(second.recovery.settled).toEqual([]);
        expect(second.recovery.escalated).toEqual([EXE_SB_PENDING]);
        expect(second.firedTimers).toEqual([]);
        expect(yield* attentionFacts(EXE_SB_PENDING)).toBe(1);
        expect(calls).toHaveLength(1);
        // Four-tier disposition: ReadOnly + Idempotent settle safely (the
        // Idempotent settlement write replays as a no-op — still one row),
        // Reconcilable settles after reconcile; NonIdempotent stays
        // escalated — the execution NEVER takes plain Interrupted.
        const leases = yield* LeaseService;
        const settlementWorkerId = "worker:p9-story-b-settlement";
        const settlementIncarnationId = "incarnation:p9-story-b-settlement";
        const settlementLease = yield* tx.transact(
          leases.acquire(
            EXE_SB_PENDING as never as ExecutionId,
            settlementWorkerId,
            settlementIncarnationId,
          ),
        );
        const settlementFence = {
          executionId: EXE_SB_PENDING as never as ExecutionId,
          workerId: settlementWorkerId,
          workerIncarnationId: settlementIncarnationId,
          fencingGeneration: settlementLease.generation,
        };
        yield* settleInvocation("tin_sb_ro", settlementFence);
        yield* settleInvocation("tin_sb_idem", settlementFence);
        const idemRowOnce = yield* invocationRowOf("tin_sb_idem");
        yield* settleInvocation("tin_sb_idem", settlementFence);
        const idemRowTwice = yield* invocationRowOf("tin_sb_idem");
        expect(idemRowTwice).toEqual(idemRowOnce);
        yield* settleInvocation("tin_sb_rec", settlementFence);
        yield* tx.transact(
          leases.release(
            EXE_SB_PENDING as never as ExecutionId,
            settlementWorkerId,
            settlementIncarnationId,
            settlementLease.generation,
          ),
        );
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = 'tin_sb_idem'",
          ),
        ).toBe(1);
        const third = yield* startupRecovery(p7TestPrincipal);
        expect(third.recovery.settled).toEqual([]);
        expect(third.recovery.escalated).toEqual([EXE_SB_PENDING]);
        // The [non]-only fingerprint is new relative to the seeded
        // [non, rec] fact → exactly one additional durable Attention fact.
        expect(yield* attentionFacts(EXE_SB_PENDING)).toBe(2);
        const finalState = yield* executionRowOf(EXE_SB_PENDING);
        expect(finalState?.settlement_kind).not.toBe("Interrupted");
        expect(finalState?.settlement_kind).toBeNull();
        const nonRow = yield* invocationRowOf("tin_sb_non");
        expect(nonRow?.settled_at).toBeNull();
        expect(nonRow?.settlement_kind).toBeNull();
      }),
      app,
    );
  });
});
