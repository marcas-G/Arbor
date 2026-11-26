import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
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
} from "../../adapters/persistence-sqlite/src/index.js";
import { CommandGatewayLive } from "../../packages/application/dist/index.js";
import {
  RemoteWorkerMediationPort,
  RemoteWorkerMediationPortLive,
} from "../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  DecisionId,
  type Execution,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkerId,
  WorkerIncarnationId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
} from "../../packages/execution-runtime/src/index.js";
import {
  type ExecutionOriginMutation,
  ExecutionRepository,
  LeaseService,
  TransactionPort,
  TransactionScope,
} from "../../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { ISSUED_AT, readRepoFile } from "./support.js";

// ---------------------------------------------------------------------------
// story 7 (`06`): remote worker fenced mutation; one transaction; no worker DB
// ---------------------------------------------------------------------------

const rwProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwDecisionId = parse(DecisionId)(
  "dec_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const rwWorkerA = parse(WorkerId)("wkr_018f2b3c-4d5e-7abc-8def-0123456789b1");
const rwInc1 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const rwInc2 = parse(WorkerIncarnationId)(
  "wic_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const rwActor = parse(Actor)("agent:remote-worker");

const rwExecution: Execution = {
  executionId: rwExecutionId,
  projectId: rwProjectId,
  workspaceId: rwWorkspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: rwWorkspaceId,
    episode: {
      _tag: "DecisionEpisode",
      decisionId: rwDecisionId,
      decisionKind: "SelectCurrentWork",
      requestRevision: 0,
    },
  },
  sessionId: rwSessionId,
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
          Effect.mapError((cause) => ({
            _tag: "TransactionOperationalFailure" as const,
            cause,
          })),
        );
      const transact = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          counter.count += 1;
          const existing = yield* Effect.serviceOption(TransactionScope);
          if (Option.isSome(existing)) {
            return yield* Effect.fail({
              _tag: "TransactionOperationalFailure" as const,
              cause: "nested transaction rejected",
            });
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (exit._tag === "Success") {
            yield* run("COMMIT");
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact } as never);
    }),
  );

const rwBuildApp = (dbFile: string, counter: { count: number }) => {
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

const rwSeed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          rwProjectId,
          "p",
          rwWorkspaceId,
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
      yield* ensureLegacyProjectResourceSourceFixture();
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [rwSessionId, "WorkspacePrimary", rwWorkspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          rwWorkspaceId,
          rwProjectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          rwSessionId,
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

const rwMutation = (
  workerId: WorkerId,
  workerIncarnationId: WorkerIncarnationId,
  fencingGeneration: number,
): ExecutionOriginMutation => ({
  workerId,
  workerIncarnationId,
  executionId: rwExecutionId,
  fencingGeneration: fencingGeneration as never,
  envelope: {
    commandType: "SettleExecution",
    commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1"),
    projectId: rwProjectId,
    actor: rwActor,
    issuedAt: ISSUED_AT,
    payload: {
      executionId: rwExecutionId,
      settlement: {
        _tag: "Completed" as const,
        result: {
          _tag: "DecisionSubmitted" as const,
          decisionId: rwDecisionId,
        },
      },
      expectedFencingGeneration: 0,
    },
  },
});

const rwRun = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  body: (counter: { count: number }) => Effect.Effect<A, any, any>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "p12-acceptance-rw-"));
  const counter = { count: 0 };
  const app = rwBuildApp(join(dir, "worker.db"), counter);
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* ensureLegacyProjectResourceSourceFixture();
        yield* rwSeed;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        yield* tx.transact(repo.tryAdmitMainExecution(rwExecution));
        return yield* body(counter);
      }),
      app,
    ) as Effect.Effect<A, unknown, never>,
  );
};

describe("p12-acceptance story 7 — remote worker fenced mediation", () => {
  it("story 7: a fenced mutation commits fence+mutate+event in one transaction; stale incarnations are rejected; no worker DB", async () => {
    // -- committed mutation: fence + mutate + resolve + event in one tx --
    const committed = await rwRun((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(rwExecutionId, rwWorkerA, rwInc1),
        );
        counter.count = 0;
        const receipt = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc1 },
          rwMutation(rwWorkerA, rwInc1, lease.generation),
        );
        const transacts = counter.count;
        const sql = yield* SqlClient;
        const events = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionSettled'",
        );
        const repo = yield* ExecutionRepository;
        const settled = yield* tx.transact(repo.findById(rwExecutionId));
        return {
          receipt,
          events: Number(events[0]?.count ?? 0),
          transacts,
          status: Option.getOrThrow(settled).state.status,
        };
      }),
    );
    expect(committed.receipt.resolution._tag).toBe("Committed");
    expect(committed.events).toBe(1);
    expect(committed.transacts).toBe(1);
    expect(committed.status).toBe("Settled");

    // -- stale incarnation: typed FencingRejected with no journal row --
    const stale = await rwRun((counter) =>
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const mediation = yield* RemoteWorkerMediationPort;
        const lease = yield* tx.transact(
          leases.acquire(rwExecutionId, rwWorkerA, rwInc1),
        );
        counter.count = 0;
        const staleIncarnation = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc2 },
          rwMutation(rwWorkerA, rwInc2, lease.generation),
        );
        const staleGeneration = yield* mediation.submit(
          { workerId: rwWorkerA, workerIncarnationId: rwInc1 },
          rwMutation(rwWorkerA, rwInc1, Number(lease.generation) + 1),
        );
        const sql = yield* SqlClient;
        const events = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionSettled'",
        );
        return {
          staleIncarnation,
          staleGeneration,
          events: Number(events[0]?.count ?? 0),
        };
      }),
    );
    expect(stale.staleIncarnation.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(stale.staleGeneration.resolution).toEqual({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });
    expect(stale.events).toBe(0);

    const source = readRepoFile("adapters/worker-transport/src/index.ts");
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain("@arbor/persistence-sqlite");
    expect(importSpecifiers).not.toContain("effect/unstable/sql/SqlClient");
  });
});
