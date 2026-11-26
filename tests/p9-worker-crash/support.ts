import { Cause, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  P36_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  makeSelectCurrentWorkHandler,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  Revision,
  SessionId,
  ToolInvocationId,
  WorkId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  makeP2CommandHandlers,
  type SettleExecutionPayload,
} from "../../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  type LeaseFencingRejected,
  LeaseService,
  ProjectRepository,
  ProviderTurnStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import { ReconciliationSourceLive } from "../../packages/tool-runtime/src/index.js";
import { yieldedSettlement } from "../support/execution-episode-fixtures.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { makeP41OptionalTestServices } from "../support/p41-optional-test-services.js";

/**
 * P9-006 — worker crash (W1–W5) + old-worker resurrection (R1–R6) injection
 * matrix (P9 `02` §1/§2). Crash = worker-level die at the named point
 * (P9-001 harness convention: mechanism empirical, the point and the
 * assertion are contract). Every case is labeled crash-injected (GQ5).
 */

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
export const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b1");
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
) as ExecutionId;
export const actor = parse(Actor)("user:test");
export const principal = parse(Principal)("runtime:system");
export const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
export const toolInvocationId = (n: number) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-0123456789${String(n).padStart(2, "0")}`,
  );

let commandSeq = 0;
export const nextCommandId = () => {
  commandSeq += 1;
  return parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${String(commandSeq).padStart(2, "0")}`,
  );
};

export const P9CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | ExecutionRepository
  | WorkWaitStore
  | WorkRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP2CommandHandlers({
        projects: yield* ProjectRepository,
        workspaces: yield* WorkspaceRepository,
        sessions: yield* SessionRepository,
        executions: yield* ExecutionRepository,
        readmissionGate: NoHoldWorkReadmissionGateStoreService,
        workWaits: yield* WorkWaitStore,
      }),
      makeSelectCurrentWorkHandler({
        workspaces: yield* WorkspaceRepository,
        works: yield* WorkRepository,
        executions: yield* ExecutionRepository,
      }) as unknown as CommandHandler<unknown, unknown>,
    ];
    return CommandHandlerRegistry.of({
      lookup: (commandType) => {
        const handler = handlers.find(
          (candidate) => candidate.commandType === commandType,
        );
        return handler === undefined ? Option.none() : Option.some(handler);
      },
    });
  }),
);

export const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    journal,
    makeP41OptionalTestServices(Layer.merge(infra, journal)),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
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
    Layer.provide(P9CommandHandlerRegistryLive, stores),
  );
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

/** P9-002 seed pattern: raw durable state (project/session/workspace/work +
 * admitted Active execution), lease rows driven only by the production
 * LeaseService / ExecutionRepository faces. */
export const seed = Effect.gen(function* () {
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
      yield* ensureLegacyProjectResourceSourceFixture();
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
    }),
  );
});

export const clockNow = Effect.gen(function* () {
  const clock = yield* Clock;
  return yield* clock.now();
});

export const sqlCount = (text: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  });

export const executionState = Effect.gen(function* () {
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

export const leaseRow = Effect.gen(function* () {
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

export const workOpen = sqlCount(
  "SELECT COUNT(*) AS count FROM works WHERE work_id = ? AND lifecycle = 'Open'",
  [workId],
);

export const eventsOf = (type: string) =>
  sqlCount("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?", [
    type,
  ]);

export const acquireLease = (workerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.acquire(executionId, workerId, "inc-a"));
  });

/** Expire the live lease in place via the production release CAS (sets
 * expires_at = now): the CI approximation of TTL passage. */
export const expireInPlace = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repo = yield* ExecutionRepository;
    yield* tx.transact(
      repo.releaseLease(executionId, workerId, "inc-a", generation),
    );
  });

export const settleViaGateway = (
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

export const selectCurrentWorkViaGateway = (
  commandId: CommandId,
  generation: LeaseGeneration,
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const payload = {
      workspaceId,
      workId,
      expectedWorkspaceRevision: parse(Revision)(0),
    };
    const authority: VerifiedCommandAuthority = {
      _tag: "SelectCurrentWorkAuthority",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SelectCurrentWork",
        projectId,
        actor,
        schemaVersion: "1",
        payload,
      }),
      projectId,
      targetWorkspaceId: workspaceId,
    };
    return yield* gw.execute(
      {
        commandType: "SelectCurrentWork",
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
      authority,
    );
  });

export const openProviderTurn = (turnId: ProviderTurnId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    yield* tx.transact(
      turns.startTurn(
        {
          providerTurnId: turnId,
          executionId,
          sessionId,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId: "mf",
        },
        "t",
      ),
    );
  });

export const toolExecutionFence = (
  workerId: string,
  generation: LeaseGeneration,
) => ({
  executionId,
  workerId,
  workerIncarnationId: "inc-a",
  fencingGeneration: generation,
});

export const recordToolIntent = (
  invocationId: ToolInvocationId,
  fence: ReturnType<typeof toolExecutionFence>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const tools = yield* ToolInvocationStore;
    const clock = yield* Clock;
    const now = yield* clock.now();
    yield* tx.transact(
      tools.recordIntent(
        {
          invocationId,
          executionId,
          workspaceId,
          toolName: "shell",
          toolVersion: "1",
          sideEffectSemantics: "NonIdempotent",
          argumentsJson: "{}",
          resolvedRegions: [],
          approvalId: null,
          intentAt: now,
        },
        fence,
        now,
      ),
    );
  });

/** P2 `03` §3 fence predicate — identical read face to the fenced Session
 * append; composed with the write in ONE transaction (02 §2 note). */
export const leaseFenceHolds = (generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const now = yield* clockNow;
    const rows = yield* sql
      .unsafe<{ ok: number }>(
        "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
        [executionId, generation, now],
      )
      .pipe(Effect.orDie);
    return rows.length > 0;
  });

export const leaseFencingRejected = (
  generation: LeaseGeneration,
): LeaseFencingRejected => ({
  _tag: "LeaseFencingRejected",
  executionId,
  generation,
});

export const withLeaseFence = <A, E, R>(
  generation: LeaseGeneration,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LeaseFencingRejected, R | Clock | SqlClient> =>
  Effect.gen(function* () {
    const holds = yield* leaseFenceHolds(generation);
    if (!holds) {
      return yield* Effect.fail(leaseFencingRejected(generation));
    }
    return yield* write;
  });

export const completed: SettleExecutionPayload["settlement"] = {
  ...yieldedSettlement,
};

/** Worker lifecycle mirroring `runExecution`'s durable sequence with a
 * harness kill point at each W-row position (P9-001 convention:
 * `harness-kill:<point>` defect = worker loss, CI approximation). */
export const workerRun = (
  workerId: string,
  point: string | null,
  turnId: ProviderTurnId,
  invocationId: ToolInvocationId,
) => {
  const kill = (at: string): Effect.Effect<void> =>
    point !== null && at === point
      ? Effect.die(new Error(`harness-kill:${at}`))
      : Effect.void;
  return Effect.gen(function* () {
    // dispatch accepted (ticket in memory only)
    yield* kill("W1");
    const lease = yield* acquireLease(workerId);
    yield* kill("W2");
    yield* openProviderTurn(turnId);
    yield* recordToolIntent(
      invocationId,
      toolExecutionFence(workerId, lease.generation),
    );
    yield* kill("W3");
    yield* kill("W5");
    const settlement = completed;
    yield* kill("W4");
    return yield* settleViaGateway(lease.generation, settlement);
  });
};

export const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

// biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
export const run = <A>(program: Effect.Effect<A, any, any>): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.provide(program, makeApp()) as Effect.Effect<A, any, never>,
  );

export const boot = Effect.gen(function* () {
  // Preserve the historical P12 fixture start, then upgrade before the
  // current P4 ToolInvocation store reads/writes its P36 admission state.
  yield* runMigrations(P12_MIGRATIONS);
  yield* runMigrations(P36_MIGRATIONS);
  yield* seed;
});

/** Fixture: new worker re-acquired at generation g+1; the old worker (g)
 * resurrects and writes across the fencing surface (02 §2). */
export const takeover = Effect.gen(function* () {
  const old = yield* acquireLease("worker:a");
  yield* expireInPlace("worker:a", old.generation);
  const next = yield* acquireLease("worker:b");
  return { old: old.generation, current: next.generation };
});
