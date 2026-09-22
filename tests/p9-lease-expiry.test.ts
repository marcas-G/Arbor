import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  FenceStopCheck,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  runRecovery,
  type SettleExecutionPayload,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  LeaseService,
  SessionRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ReconciliationSourceLive } from "../packages/tool-runtime/src/index.js";
import { labeled } from "./support/p9-harness-api.js";

/**
 * P9-007 — lease expiry injection (L1–L4, P9 `02` §3) + the T4 proof
 * (P9 `03` §2): the targeted pre-dispatch check is the lease-fence
 * predicate ONLY — a single-predicate read, never the nine-step recovery.
 * Every case is labeled crash-injected (GQ5); TTL passage is approximated
 * by expiring the lease row in place via the production release CAS.
 */

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c2");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c2");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c2");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c2",
) as ExecutionId;
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("runtime:system");

let commandSeq = 0;
const nextCommandId = () => {
  commandSeq += 1;
  return parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${String(commandSeq).padStart(2, "0")}`,
  );
};

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.provide(ToolInvocationStoreLive, infra),
    ),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(FenceStopCheckLive, Layer.merge(infra, execRepo)),
  );
  const all = Layer.mergeAll(
    infra,
    stores,
    Layer.provide(P2CommandHandlerRegistryLive, stores),
  );
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

/** P9-002 seed pattern + pending-state fixture rows (wake, due/future
 * timers, open work) so the T4 read-only proof runs against live state. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p9",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [sessionId, executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Open',0,'t','t')",
        [
          workId,
          projectId,
          workspaceId,
          "p9",
          "seed",
          "[]",
          "green",
          '{"goal":"g","criteria":[],"riskRequirements":[]}',
          '{"predecessorWorkId":null,"reason":"seed"}',
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?, 'Any', '[]', 't', 't')",
        [workId],
      );
      yield* sql.unsafe(
        "INSERT INTO scheduler_timers (timer_id, workspace_id, work_id, kind, fire_at, created_at) VALUES (?, ?, ?, 'TimeReached', '2000-01-01T00:00:00.000Z', 't')",
        ["tmr_p9_l_due", workspaceId, workId],
      );
      yield* sql.unsafe(
        "INSERT INTO scheduler_timers (timer_id, workspace_id, work_id, kind, fire_at, created_at) VALUES (?, ?, ?, 'TimeReached', '2999-01-01T00:00:00.000Z', 't')",
        ["tmr_p9_l_future", workspaceId, workId],
      );
    }),
  );
});

const boot = Effect.gen(function* () {
  yield* runMigrations(P12_MIGRATIONS);
  yield* seed;
});

const clockNow = Effect.gen(function* () {
  const clock = yield* Clock;
  return yield* clock.now();
});

const sqlCount = (text: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  });

const executionState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    settled_at: string | null;
    settlement_kind: string | null;
  }>(
    "SELECT settled_at, settlement_kind FROM executions WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] ?? null;
});

const leaseRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    worker_id: string;
    generation: number;
    expires_at: string;
  }>(
    "SELECT worker_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] ?? null;
});

const acquireLease = (workerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.acquire(executionId, workerId, "inc-a"));
  });

const renewLease = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(
      leases.renew(executionId, workerId, "inc-a", generation),
    );
  });

const expireInPlace = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repo = yield* ExecutionRepository;
    yield* tx.transact(
      repo.releaseLease(executionId, workerId, "inc-a", generation),
    );
  });

const invalidateExpired = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const leases = yield* LeaseService;
  const now = yield* clockNow;
  return yield* tx.transact(leases.invalidateExpired(now));
});

const settleViaGateway = (
  generation: LeaseGeneration,
  settlement: SettleExecutionPayload["settlement"],
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const commandId = nextCommandId();
    const payload: SettleExecutionPayload = {
      executionId,
      settlement,
      expectedFencingGeneration: generation,
    };
    return yield* gw.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId,
        actor,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal,
        executionId,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId,
          actor,
          schemaVersion: "1",
          payload,
        }),
        projectId,
        commandKind: "SettleExecution",
        executionId,
        fencingGeneration: generation,
      },
    );
  });

const completed: SettleExecutionPayload["settlement"] = {
  _tag: "Completed",
  result: { _tag: "CoordinationCompleted" },
};

const executionOriginCtx = (
  generation: LeaseGeneration,
): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: generation,
});

/** Full-database canonical dump: the T4 byte-identical snapshot face. */
const dbSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tables = yield* sql
    .unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pipe(Effect.orDie);
  const parts: string[] = [];
  for (const table of tables) {
    const rows = yield* sql
      .unsafe(`SELECT * FROM "${table.name}" ORDER BY 1, 2`)
      .pipe(Effect.orDie);
    parts.push(`${table.name}=${JSON.stringify(rows)}`);
  }
  return parts.join(";");
});

const run = <A>(program: Effect.Effect<A, any, any>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, makeApp()) as Effect.Effect<A, any, never>,
  );

describe("p9-lease-expiry (L1–L4, 02 §3)", () => {
  it("L1 [crash-injected]: TTL expired — old worker SettleExecution rejected, QuiescenceControlMutation still fenced, Execution not settled", async () => {
    expect(
      labeled("L1-expired-settle-rejected", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* expireInPlace("worker:a", first.generation);
        const receipt = yield* settleViaGateway(first.generation, completed);
        const tx = yield* TransactionPort;
        const fence = yield* FenceStopCheck;
        const quiescence = yield* tx.transact(
          fence.check(executionOriginCtx(first.generation), {
            _tag: "QuiescenceControlMutation",
          }),
        );
        const exec = yield* executionState;
        return { first, receipt, quiescence, exec };
      }),
    );
    expect(Number(r.first.generation)).toBe(0);
    const resolution = (
      r.receipt as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(resolution._tag).toBe("TerminalRejected");
    expect(resolution.error?._tag).toBe("FencingRejected");
    expect(r.quiescence).toBe("FencingRejected");
    expect(r.exec?.settled_at).toBeNull();
    expect(r.exec?.settlement_kind).toBeNull();
  });

  it("L2 [crash-injected]: renewal boundary — renewal CAS succeeds with generation unchanged and the fenced write commits", async () => {
    expect(
      labeled("L2-renewal-boundary-commit", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* Effect.sleep(2);
        const renewed = yield* renewLease("worker:a", first.generation);
        const row = yield* leaseRow;
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const append = yield* tx.transact(
          sessions.appendEntry(
            sessionId,
            { entryKind: "ModelOutput", payload: { text: "owner-writes" } },
            { executionId, fencingGeneration: first.generation },
          ),
        );
        return { first, renewed, row, append };
      }),
    );
    expect(Number(r.renewed.generation)).toBe(Number(r.first.generation));
    expect(r.renewed.expiresAt > r.first.expiresAt).toBe(true);
    expect(r.row?.worker_id).toBe("worker:a");
    expect(Number(r.row?.generation)).toBe(0);
    expect(r.row?.expires_at).toBe(r.renewed.expiresAt);
    expect(r.append.sequence).toBe(0);
  });

  it("L3 [crash-injected]: renewal after takeover — CAS fails typed, worker stops durable mutation, no ordinary retry", async () => {
    expect(
      labeled("L3-post-takeover-renewal-rejected", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* expireInPlace("worker:a", first.generation);
        const next = yield* acquireLease("worker:b");
        const renewRejected = yield* renewLease(
          "worker:a",
          first.generation,
        ).pipe(Effect.flip);
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const writeRejected = yield* tx
          .transact(
            sessions.appendEntry(
              sessionId,
              { entryKind: "ModelOutput", payload: { text: "late" } },
              { executionId, fencingGeneration: first.generation },
            ),
          )
          .pipe(Effect.flip);
        const renewRetry = yield* renewLease("worker:a", first.generation).pipe(
          Effect.flip,
        );
        const row = yield* leaseRow;
        return { first, next, renewRejected, writeRejected, renewRetry, row };
      }),
    );
    expect(Number(r.next.generation)).toBe(1);
    expect((r.renewRejected as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect((r.writeRejected as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect((r.renewRetry as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect(r.row?.worker_id).toBe("worker:b");
    expect(Number(r.row?.generation)).toBe(1);
  });

  it("L4 [crash-injected]: expiry observed, no takeover — invalidation never settles; stays Active until re-dispatch or deterministic recovery", async () => {
    expect(
      labeled("L4-invalidation-never-settles", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* expireInPlace("worker:a", first.generation);
        const invalidated = yield* invalidateExpired;
        const row = yield* leaseRow;
        const exec = yield* executionState;
        const recovery = yield* runRecovery(principal);
        const execAfter = yield* executionState;
        return { invalidated, row, exec, recovery, execAfter };
      }),
    );
    expect(r.invalidated).toBe(1);
    expect(r.row?.worker_id).toBe("worker:a");
    expect(Number(r.row?.generation)).toBe(0);
    expect(r.exec?.settled_at).toBeNull();
    expect(r.recovery.settled).toEqual([]);
    expect(r.recovery.escalated).toEqual([]);
    expect(r.execAfter?.settled_at).toBeNull();
    expect(r.execAfter?.settlement_kind).toBeNull();
  });
});

describe("p9-lease-expiry T4 (03 §2 targeted pre-dispatch check)", () => {
  it("T4 [crash-injected]: pre-dispatch check is the fence predicate read only — DB snapshot byte-identical, nine-step side-effect counters = 0", async () => {
    expect(
      labeled("T4-pre-dispatch-read-only", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const lease = yield* acquireLease("worker:a");
        const before = yield* dbSnapshot;
        const tx = yield* TransactionPort;
        const fence = yield* FenceStopCheck;
        const live = yield* tx.transact(
          fence.check(executionOriginCtx(lease.generation), {
            _tag: "NormalExecutionMutation",
          }),
        );
        const mid = yield* dbSnapshot;
        const countersMid = yield* Effect.gen(function* () {
          return {
            commands: yield* sqlCount("SELECT COUNT(*) AS count FROM commands"),
            events: yield* sqlCount(
              "SELECT COUNT(*) AS count FROM domain_events",
            ),
            workWaits: yield* sqlCount(
              "SELECT COUNT(*) AS count FROM work_waits",
            ),
            timers: yield* sqlCount(
              "SELECT COUNT(*) AS count FROM scheduler_timers",
            ),
            settledExecutions: yield* sqlCount(
              "SELECT COUNT(*) AS count FROM executions WHERE settled_at IS NOT NULL",
            ),
            sessionEntries: yield* sqlCount(
              "SELECT COUNT(*) AS count FROM session_entries",
            ),
          };
        });
        yield* expireInPlace("worker:a", lease.generation);
        const postExpiry = yield* dbSnapshot;
        const expired = yield* tx.transact(
          fence.check(executionOriginCtx(lease.generation), {
            _tag: "NormalExecutionMutation",
          }),
        );
        const final = yield* dbSnapshot;
        const timersAfter = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM scheduler_timers",
        );
        const workWaitsAfter = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM work_waits",
        );
        return {
          before,
          live,
          mid,
          countersMid,
          expired,
          postExpiry,
          final,
          timersAfter,
          workWaitsAfter,
        };
      }),
    );
    expect(r.live).toBe("Pass");
    expect(r.mid).toBe(r.before);
    expect(r.countersMid.commands).toBe(0);
    expect(r.countersMid.events).toBe(0);
    expect(r.countersMid.workWaits).toBe(1);
    expect(r.countersMid.timers).toBe(2);
    expect(r.countersMid.settledExecutions).toBe(0);
    expect(r.countersMid.sessionEntries).toBe(0);
    expect(r.expired).toBe("FencingRejected");
    expect(r.final).toBe(r.postExpiry);
    expect(r.timersAfter).toBe(2);
    expect(r.workWaitsAfter).toBe(1);
  });
});
