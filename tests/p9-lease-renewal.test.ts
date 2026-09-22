import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P8_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { WorkerDispatchPortLive } from "../adapters/worker-local/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  FenceStopCheck,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import type {
  ExecutionSettlement,
  LeaseGeneration,
} from "../packages/domain/dist/index.js";
import {
  Actor,
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type AdmitExecutionPayload,
  FenceStopCheckLive,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  P2CommandHandlerRegistryLive,
  RuntimeSafetyGateLive,
  renewLeaseOnce,
  runExecution,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionDriverPort,
  ExecutionRepository,
  LeaseService,
  TransactionPort,
} from "../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("worker:a");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

const COMPLETED: ExecutionSettlement = {
  _tag: "Completed",
  result: { _tag: "CoordinationCompleted" },
};

/** L2 probe: the drive reads the live lease mid-drive so the test observes
 * renewal effects (extended expiry, unchanged generation) while drive runs. */
interface DriveTrace {
  readonly expiresMid: string | null;
  readonly generationMid: number | null;
}

const slowDriver = (
  ms: number,
  trace: { v: DriveTrace | null },
): Layer.Layer<
  ExecutionDriverPort,
  never,
  ExecutionRepository | TransactionPort
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const repository = yield* ExecutionRepository;
      const tx = yield* TransactionPort;
      return ExecutionDriverPort.of({
        drive: () =>
          Effect.gen(function* () {
            yield* Effect.sleep(ms);
            const lease = yield* tx.transact(
              repository.currentLease(executionId),
            );
            trace.v = Option.isSome(lease)
              ? {
                  expiresMid: lease.value.expiresAt,
                  generationMid: lease.value.generation,
                }
              : { expiresMid: null, generationMid: null };
            return COMPLETED;
          }).pipe(
            Effect.mapError(
              (
                cause,
              ): import("../packages/ports/src/index.js").ExecutionDriverError => ({
                _tag: "ExecutionDriverError",
                cause,
              }),
            ),
          ),
      });
    }),
  );

/** L3 fixture: mid-drive the lease expires and another worker takes over
 * (generation bump) — the next renewal tick must report LeaseLost. */
const stealingDriver = (
  ms: number,
): Layer.Layer<
  ExecutionDriverPort,
  never,
  ExecutionRepository | TransactionPort | LeaseService | SqlClient
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const repository = yield* ExecutionRepository;
      const tx = yield* TransactionPort;
      const leases = yield* LeaseService;
      const sql = yield* SqlClient;
      return ExecutionDriverPort.of({
        drive: () =>
          Effect.gen(function* () {
            yield* Effect.sleep(5);
            yield* sql.unsafe(
              "UPDATE execution_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE execution_id = ?",
              [executionId],
            );
            const takeover = yield* tx.transact(
              leases.acquire(executionId, "worker:other"),
            );
            yield* Effect.sleep(ms);
            void takeover;
            void repository;
            return COMPLETED;
          }).pipe(
            Effect.mapError(
              (
                cause,
              ): import("../packages/ports/src/index.js").ExecutionDriverError => ({
                _tag: "ExecutionDriverError",
                cause,
              }),
            ),
          ),
      });
    }),
  );

const makeApp = (
  driver: Layer.Layer<
    ExecutionDriverPort,
    never,
    ExecutionRepository | TransactionPort | LeaseService | SqlClient
  >,
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const tx = Layer.provide(TransactionPortLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const repos = Layer.mergeAll(
    tx,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
  );
  const driverLayer = Layer.provide(driver, Layer.mergeAll(infra, repos));
  const all = Layer.mergeAll(
    infra,
    repos,
    fence,
    WorkerDispatchPortLive,
    driverLayer,
    RuntimeSafetyGateLive(),
    Layer.provide(P2CommandHandlerRegistryLive, repos),
  );
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
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
    }),
  );
});

const admitPayload: AdmitExecutionPayload = {
  _tag: "WorkspaceMain",
  executionId,
  workspaceId,
  focus: { _tag: "Coordination" },
};

const admit = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const commandId = parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
  );
  const authority: VerifiedRuntimeCommandAuthority = {
    _tag: "AdmitExecutionAuthority",
    submissionOrigin: "System",
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "AdmitExecution",
      projectId,
      actor,
      schemaVersion: "1",
      payload: admitPayload,
    }),
    projectId,
    commandKind: "AdmitExecution",
    workspaceId,
    bindingKind: "WorkspaceMain",
  };
  const envelope: GatewayEnvelope<AdmitExecutionPayload> = {
    commandType: "AdmitExecution",
    commandId,
    projectId,
    actor,
    issuedAt: "t",
    payload: admitPayload,
  };
  yield* gateway.execute(
    envelope,
    { _tag: "System", principal, causationRef: "c" },
    authority,
  );
});

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

const leaseRow = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      worker_id: string;
      generation: number;
      expires_at: string;
    }>(
      "SELECT worker_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
      [executionId],
    );
    return rows[0]
      ? {
          workerId: rows[0].worker_id,
          generation: Number(rows[0].generation),
          expiresAt: rows[0].expires_at,
        }
      : null;
  });

const settleCommands = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM commands WHERE command_id LIKE 'cmd_settle_%'",
    );
    return Number(rows[0]!.count);
  });

describe("P9-004 lease renewal loop (L2/L3) + soft release", () => {
  it("exports the TTL/3 cadence convention with empirical TTL value (P9 `03` §1; P2 `03` §8)", () => {
    expect(LEASE_TTL_MS).toBe(30_000);
    expect(LEASE_RENEW_INTERVAL_MS).toBe(LEASE_TTL_MS / 3);
  });

  it("L2: renewal CAS extends expires_at with generation UNCHANGED; fenced write still commits", async () => {
    const trace = { v: null as DriveTrace | null };
    const app = makeApp(slowDriver(25, trace));
    const program = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* seed;
      yield* admit;
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const t0 = yield* clock.now();
      // Renewal loop ticks during the drive (interval 5ms, drive 25ms);
      // runExecution acquires its own lease (generation 0).
      const settlement = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
        5,
      );
      expect(settlement._tag).toBe("Completed");
      const mid = trace.v;
      expect(mid?.generationMid).toBe(0);
      expect(mid?.expiresMid).not.toBeNull();
      // Renewal extended expiry beyond the initial acquire horizon.
      expect(Date.parse(mid!.expiresMid!)).toBeGreaterThan(
        Date.parse(t0) + LEASE_TTL_MS - 1_000,
      );
      // Fenced write committed (L2): the settle landed.
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
        "SELECT settlement_kind FROM executions WHERE execution_id = ?",
        [executionId],
      );
      expect(rows[0]?.settlement_kind).toBe("Completed");
      // Soft release (P9 `03` §1): CAS deletes live-lease liveness — the row
      // collapses to immediate expiry; generation still unchanged.
      const released = yield* leaseRow();
      expect(released?.generation).toBe(0);
      expect(Date.parse(released!.expiresAt)).toBeLessThan(
        Date.parse(mid!.expiresMid!),
      );
    });
    await run(program, app);
  });

  it("L2 (direct): renewLeaseOnce extends expiry, keeps generation, and a stale worker/owner fails with LeaseLost", async () => {
    const app = makeApp(slowDriver(1, { v: null }));
    const program = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* seed;
      yield* admit;
      const tx = yield* TransactionPort;
      const leases = yield* LeaseService;
      const acquired = yield* tx.transact(
        leases.acquire(executionId, "worker:a"),
      );
      yield* Effect.sleep(5);
      const renewed = yield* renewLeaseOnce(
        executionId,
        "worker:a",
        acquired.generation,
      );
      expect(renewed.generation).toBe(acquired.generation);
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(
        Date.parse(acquired.expiresAt),
      );
      const stale = yield* Effect.flip(
        renewLeaseOnce(executionId, "worker:zzz", acquired.generation),
      );
      expect(stale._tag).toBe("LeaseLost");
    });
    await run(program, app);
  });

  it("L3: renewal failure after takeover → LeaseLost, durable mutation stops (no settle command), no ordinary retry; stale fence write is FencingRejected", async () => {
    const app = makeApp(stealingDriver(60));
    const program = Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* seed;
      yield* admit;
      const tx = yield* TransactionPort;
      const error = yield* Effect.flip(
        runExecution(executionId, { _tag: "Recovery" }, principal, 10),
      );
      expect(error._tag).toBe("LeaseLost");
      // Durable mutation stopped: no SettleExecution ever submitted, the
      // execution stays unsettled, and there was no ordinary retry.
      expect(yield* settleCommands()).toBe(0);
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settled_at: string | null }>(
        "SELECT settled_at FROM executions WHERE execution_id = ?",
        [executionId],
      );
      expect(rows[0]?.settled_at).toBeNull();
      const takeover = yield* leaseRow();
      expect(takeover?.workerId).toBe("worker:other");
      expect(takeover?.generation).toBe(1);
      // Authoritative rejection if a stale write is nonetheless attempted
      // (P2 fence pattern): the old generation no longer validates.
      const fence = yield* FenceStopCheck;
      const outcome = yield* tx.transact(
        fence.check(
          {
            _tag: "ExecutionOrigin",
            principal,
            executionId,
            fencingGeneration: 0 as LeaseGeneration,
          },
          { _tag: "NormalExecutionMutation" },
        ),
      );
      expect(outcome).toBe("FencingRejected");
    });
    await run(program, app);
  });
});
