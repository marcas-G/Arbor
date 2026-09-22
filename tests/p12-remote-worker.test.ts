import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Option } from "effect";
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
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { WorkerTransportLive } from "../adapters/worker-transport/src/index.js";
import {
  CommandGatewayLive,
  type CommandRejection,
  RemoteWorkerMediationPort,
  RemoteWorkerMediationPortLive,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandReceipt,
  type DomainError,
  type Execution,
  ExecutionId,
  isDomainErrorTag,
  ProjectId,
  parse,
  SessionId,
  WorkerId,
  WorkerIncarnationId,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
} from "../packages/execution-runtime/src/index.js";
import {
  type ExecutionOriginMutation,
  ExecutionRepository,
  LeaseService,
  RemoteWorkerTransportPort,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
  type TransportVersionRejected,
  type WorkerCommandRejection,
} from "../packages/ports/src/index.js";

/**
 * P12-006 (`06` §2–§6; EC-7 / blocker B8):
 *  - a mediated mutation is fence-check + mutate + resolve + domain event in
 *    exactly one transaction (the gateway's; the mediation port opens none);
 *  - a stale `(workerId, workerIncarnationId, generation)` triple yields a
 *    typed `FencingRejected` receipt with no journal row;
 *  - the wire DTO carries no authority fact; the control plane constructs it
 *    from authenticated facts;
 *  - the authenticated peer identity binds the wire DTO (identity hijack is
 *    rejected before delegation);
 *  - the worker transport imports no persistence and its `Layer` `R` excludes
 *    `SqlClient`; a protocol-major mismatch is `TransportVersionRejected`.
 */

const repoRoot = join(import.meta.dirname, "..");

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workerA = parse(WorkerId)("wkr_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workerB = parse(WorkerId)("wkr_018f2b3c-4d5e-7abc-8def-0123456789b2");
const inc1 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const inc2 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const actor = parse(Actor)("agent:remote-worker");
const issuedAt = "2026-09-22T00:00:00.000Z";

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const countingTransaction = (counter: {
  count: number;
}): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError(
            (cause): TransactionOperationalFailure => ({
              _tag: "TransactionOperationalFailure",
              cause,
            }),
          ),
        );
      const transact: TransactionPortService["transact"] = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          counter.count += 1;
          const existing = yield* Effect.serviceOption(TransactionScope);
          if (Option.isSome(existing)) {
            return yield* Effect.fail({
              _tag: "TransactionOperationalFailure",
              cause: "nested transaction rejected",
            } satisfies TransactionOperationalFailure);
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isSuccess(exit)) {
            const commitExit = yield* Effect.exit(run("COMMIT"));
            if (Exit.isFailure(commitExit)) {
              yield* run("ROLLBACK").pipe(Effect.ignore, Effect.orDie);
              return yield* Effect.failCause(commitExit.cause).pipe(
                Effect.mapError(
                  (cause): TransactionOperationalFailure => ({
                    _tag: "TransactionOperationalFailure",
                    cause,
                  }),
                ),
              );
            }
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact });
    }),
  );

const buildApp = (dbFile: string, counter: { count: number }) => {
  const base = layer({ filename: dbFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const tx = Layer.provide(countingTransaction(counter), base);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const leases = Layer.provide(LeaseServiceLive, Layer.merge(infra, repo));
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const commandStore = Layer.provide(CommandStoreLive, infra);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const sessions = Layer.provide(SessionRepositoryLive, infra);
  const workWaits = Layer.provide(WorkWaitStoreLive, infra);
  const projects = Layer.provide(ProjectRepositoryLive, infra);
  const workspaces = Layer.provide(WorkspaceRepositoryLive, infra);
  const registry = Layer.provide(
    P2CommandHandlerRegistryLive,
    Layer.mergeAll(projects, workspaces, sessions, repo, workWaits),
  );
  const gateway = Layer.provide(
    CommandGatewayLive,
    Layer.mergeAll(infra, registry, commandStore, journal, tx, fence),
  );
  const mediation = Layer.provide(
    RemoteWorkerMediationPortLive,
    Layer.mergeAll(gateway, registry, infra),
  );
  return Layer.mergeAll(
    base,
    infra,
    tx,
    repo,
    leases,
    fence,
    commandStore,
    journal,
    sessions,
    workWaits,
    projects,
    workspaces,
    registry,
    gateway,
    mediation,
  );
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

const settleEnvelope = () => ({
  commandType: "SettleExecution",
  commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1"),
  projectId,
  actor,
  issuedAt,
  payload: {
    executionId,
    settlement: {
      _tag: "Completed" as const,
      result: { _tag: "CoordinationCompleted" as const },
    },
    expectedFencingGeneration: 0,
  },
});

const mutation = (
  workerId: WorkerId,
  workerIncarnationId: WorkerIncarnationId,
  fencingGeneration: number,
): ExecutionOriginMutation => ({
  workerId,
  workerIncarnationId,
  executionId,
  fencingGeneration: fencingGeneration as never,
  envelope: settleEnvelope(),
});

const journalCount = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.count ?? 0);
  });

const toWorkerRejection = (
  rejection: CommandRejection,
): WorkerCommandRejection => {
  if (isDomainErrorTag(rejection._tag)) {
    return rejection as DomainError;
  }
  if (
    rejection._tag === "FencingRejected" ||
    rejection._tag === "ExecutionStopping" ||
    rejection._tag === "ExecutionNotFound"
  ) {
    return rejection;
  }
  return {
    _tag: "AuthorityDenied",
    reason: `unsupported application rejection ${rejection._tag}`,
  };
};

const toWorkerReceipt = (
  receipt: CommandReceipt<unknown, CommandRejection>,
): CommandReceipt<unknown, WorkerCommandRejection> => ({
  ...receipt,
  resolution:
    receipt.resolution._tag === "Committed"
      ? receipt.resolution
      : {
          _tag: "TerminalRejected",
          error: toWorkerRejection(receipt.resolution.error),
        },
});

const runWithCounter = <A>(
  body: (counter: { count: number }) => Effect.Effect<A, any, any>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-remote-worker-"));
  const counter = { count: 0 };
  const app = buildApp(join(dir, "worker.db"), counter);
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* seed;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        yield* tx.transact(repo.tryAdmitMainExecution(execution));
        return yield* body(counter);
      }),
      app,
    ) as Effect.Effect<A, unknown, never>,
  );
};

describe("P12-006 remote worker mediation", () => {
  it("mediated mutation = fence-check + mutate + resolve + event in exactly one transaction", async () => {
    const result = await runWithCounter((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(executionId, workerA, inc1),
        );
        counter.count = 0;
        const receipt = yield* mediation.submit(
          { workerId: workerA, workerIncarnationId: inc1 },
          mutation(workerA, inc1, lease.generation),
        );
        const transacts = counter.count;
        const events = yield* journalCount("ExecutionSettled");
        const repo = yield* ExecutionRepository;
        const settled = yield* tx.transact(repo.findById(executionId));
        return {
          receipt,
          events,
          counter: transacts,
          status: Option.getOrThrow(settled).state.status,
        };
      }),
    );
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.events).toBe(1);
    expect(result.status).toBe("Settled");
    expect(result.counter).toBe(1);
  });

  it("stale (workerId, workerIncarnationId, generation) → FencingRejected receipt with no journal row", async () => {
    const result = await runWithCounter((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(executionId, workerA, inc1),
        );
        counter.count = 0;
        const staleIncarnation = yield* mediation.submit(
          { workerId: workerA, workerIncarnationId: inc2 },
          mutation(workerA, inc2, lease.generation),
        );
        const staleGeneration = yield* mediation.submit(
          { workerId: workerA, workerIncarnationId: inc1 },
          mutation(workerA, inc1, Number(lease.generation) + 1),
        );
        const events = yield* journalCount("ExecutionSettled");
        return { staleIncarnation, staleGeneration, events };
      }),
    );
    expect(result.staleIncarnation.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(result.staleGeneration.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(result.events).toBe(0);
  });

  it("rejects a wire DTO that asserts another worker's identity before delegation", async () => {
    const result = await runWithCounter((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(executionId, workerA, inc1),
        );
        counter.count = 0;
        const receipt = yield* mediation.submit(
          { workerId: workerA, workerIncarnationId: inc1 },
          mutation(workerB, inc1, lease.generation),
        );
        return { receipt, counter: counter.count };
      }),
    );
    expect(result.receipt.resolution).toEqual({
      _tag: "TerminalRejected",
      error: {
        _tag: "AuthorityDenied",
        reason: "authenticated peer identity mismatch",
      },
    });
    // never delegated: the gateway was never invoked.
    expect(result.counter).toBe(0);
  });

  it("worker transport negotiates the protocol major and submits over the wire", async () => {
    const result = await runWithCounter((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(executionId, workerA, inc1),
        );
        const transport = WorkerTransportLive({
          localVersion: { major: 1, minor: 4 },
          peer: { workerId: workerA, workerIncarnationId: inc1 },
          send: (peer, wireMutation) =>
            mediation
              .submit(peer, wireMutation)
              .pipe(Effect.map(toWorkerReceipt)) as Effect.Effect<
              CommandReceipt<unknown, WorkerCommandRejection>,
              TransportVersionRejected
            >,
        });
        const program = Effect.gen(function* () {
          const port = yield* RemoteWorkerTransportPort;
          const negotiated = yield* port.negotiate({ major: 1, minor: 2 });
          const mismatched = yield* Effect.flip(
            port.negotiate({ major: 2, minor: 0 }),
          );
          counter.count = 0;
          const receipt = yield* port.submit(
            mutation(workerA, inc1, lease.generation),
          );
          return { negotiated, mismatched, receipt, counter: counter.count };
        });
        return yield* Effect.provide(program, transport);
      }),
    );
    expect(result.negotiated).toEqual({ major: 1, minor: 2 });
    expect(result.mismatched).toEqual({
      _tag: "TransportVersionRejected",
      localMajor: 1,
      peerMajor: 2,
    });
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.counter).toBe(1);
  });

  it("worker transport imports no persistence and its Layer R excludes SqlClient", () => {
    const layer: Layer.Layer<RemoteWorkerTransportPort> = WorkerTransportLive({
      localVersion: { major: 1, minor: 0 },
      peer: { workerId: workerA, workerIncarnationId: inc1 },
      send: () => Effect.die("unused"),
    });
    expect(layer).toBeDefined();

    const source = readFileSync(
      join(repoRoot, "adapters/worker-transport/src/index.ts"),
      "utf8",
    );
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain("@arbor/persistence-sqlite");
    expect(importSpecifiers).not.toContain("effect/unstable/sql/SqlClient");
    expect(importSpecifiers).not.toContain("@arbor/application");

    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, "adapters/worker-transport/package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@arbor/domain",
      "@arbor/ports",
    ]);
  });

  it("wire submission carries no authority fact", () => {
    const source = readFileSync(
      join(repoRoot, "packages/ports/src/worker-transport.ts"),
      "utf8",
    );
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain("@arbor/application");

    const sample = mutation(workerA, inc1, 0);
    expect(Object.keys(sample).sort()).toEqual([
      "envelope",
      "executionId",
      "fencingGeneration",
      "workerId",
      "workerIncarnationId",
    ]);
  });
});
