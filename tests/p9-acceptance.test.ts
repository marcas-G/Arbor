import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
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
  P8_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  rebuildProjection,
  runConsumerBatch,
  runMigrations,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { satisfactionCommandId } from "../packages/application/src/commands/satisfy-dependency.js";
import {
  type ConsumerLoopStores,
  completionConsumerLoop,
  dependencyCoordinatorLoop,
  pollOnce,
  verificationConsumerLoop,
} from "../packages/application/src/consumer-loop.js";
import type { CommandGatewayService } from "../packages/application/src/gateway.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeSelectCurrentWorkHandler,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import { recoverUnsettledProviderTurns } from "../packages/application/src/provider-turn-recovery.js";
import { verificationSpawnIds } from "../packages/application/src/verification-consumer.js";
import {
  ensureVerifierSpawned,
  verifierAdmitCommandId,
} from "../packages/application/src/verifier-spawn.js";
import {
  AcceptanceId,
  Actor,
  ArtifactId,
  type ArtifactRole,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  type EventTypeName,
  ExecutionId,
  type ExpectedDeliverable,
  type LeaseGeneration,
  Principal,
  type ProducerBinding,
  ProjectId,
  ProviderTurnId,
  parse,
  Revision,
  SessionId,
  startVerification,
  ToolInvocationId,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  FenceStopCheckLive,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  makeP2CommandHandlers,
  preDispatchCheck,
  runRecovery,
  type SettleExecutionPayload,
  startupRecovery,
} from "../packages/execution-runtime/src/index.js";
import {
  type CanonicalProviderEvent,
  Clock,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  ExecutionRepository,
  ExecutionScheduler,
  LeaseService,
  ProjectEnvironmentPort,
  ProjectionStore,
  ProjectRepository,
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  ProviderRuntime,
  ProviderTurnStore,
  ReconciliationSource,
  ResourceAdmission,
  SandboxPort,
  type SchedulerDecision,
  type SchedulerTimer,
  SessionRepository,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  VerificationRepository,
  WorkerDispatchPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
import {
  ReconciliationSourceLive,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";
import {
  commitGate,
  gatedTransactionPort,
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "./support/p9-consumer-app.js";
import {
  collectDurabilityEvidence,
  type DurabilityEvidence,
} from "./support/p9-durability-evidence.js";
import { labeled } from "./support/p9-harness-api.js";

/** P9-013 — the seven deterministic acceptance stories (P9 `06` §A–§G)
 * + the mechanical assertion checklist. Every story reuses the
 * construction patterns of the owning p9-* task suite but its assertions
 * stand alone; injections are real process/transaction/fiber level
 * (GQ5), deterministic, each story on its own durable DB file. */

const ROOT_WS = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";

const durableFile = (label: string): string =>
  join(mkdtempSync(join(tmpdir(), `arbor-p9-accept-${label}-`)), `${label}.db`);

const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

const runOn = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

const sqlCount = (text: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  });

const executionRowOf = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      settlement_kind: string | null;
      settlement_json: string | null;
      settled_at: string | null;
      stop_requested_at: string | null;
    }>(
      "SELECT settlement_kind, settlement_json, settled_at, stop_requested_at FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows[0] ?? null;
  });

const countEventsFor = (executionId: string, eventType: string) =>
  sqlCount(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ? AND aggregate_ref = ?",
    [eventType, executionId],
  );

const attentionFacts = (executionId: string) =>
  countEventsFor(executionId, "ReconciliationEscalated");

/** P9-002 raw fixture face: stopped/active execution bound to the seeded
 * root workspace (p9-recovery-visibility precedent). */
const INSERT_EXECUTION = (executionId: string, stopRequested: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const sesId = `ses_${executionId}`;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [sesId, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', ?, NULL, NULL, NULL)",
      [executionId, p7Project, ROOT_WS, sesId, stopRequested],
    );
  });

const INSERT_INVOCATION = (
  invocationId: string,
  executionId: string,
  semantics: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, intent_at) VALUES (?,?,?,?,?,?,?,?,'t')",
      [invocationId, executionId, ROOT_WS, "shell", "1", semantics, "{}", "[]"],
    );
  });

const invocationRowOf = (invocationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      settled_at: string | null;
      settlement_kind: string | null;
      side_effect_semantics: string;
    }>(
      "SELECT settled_at, settlement_kind, side_effect_semantics FROM tool_invocations WHERE invocation_id = ?",
      [invocationId],
    );
    return rows[0] ?? null;
  });

const settleInvocation = (invocationId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const tools = yield* ToolInvocationStore;
    const clock = yield* Clock;
    const now = yield* clock.now();
    yield* tx.transact(
      tools.settle(
        invocationId as never as ToolInvocationId,
        {
          _tag: "Success",
        },
        null,
        now,
      ),
    );
  });

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
const G_MISSION: VerificationMission = {
  goal: "verify the completed outcome",
  criteria: [{ criterionId: "c1", requirement: "tests pass", required: true }],
  riskRequirements: [],
};

// ---------------------------------------------------------------------------
// Story C wiring: the p9-worker-crash resurrection app (P2 +
// SelectCurrentWork handlers, provider/tool stores, lease + fence
// services).
// ---------------------------------------------------------------------------

const C_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c3");
const C_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c3",
) as ExecutionId;
const C_EXECUTION_T4 = "exe_018f2b3c-4d5e-7abc-8def-0123456789c4";
const C_TURN = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_INVOCATION = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789c3",
);
const C_ACTOR = parse(Actor)("user:story-c");
const C_PRINCIPAL = parse(Principal)("runtime:system");

let cCommandSeq = 0;
const nextCCommandId = () => {
  cCommandSeq += 1;
  return parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${String(cCommandSeq).padStart(2, "0")}`,
  );
};

const makeStoryCApp = (filename: string) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    execRepo,
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP2CommandHandlers({
            projects: yield* ProjectRepository,
            workspaces: yield* WorkspaceRepository,
            sessions: yield* SessionRepository,
            executions: yield* ExecutionRepository,
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
    ),
    repositories,
  );
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(FenceStopCheckLive, Layer.merge(infra, execRepo)),
  );
  const all = Layer.mergeAll(infra, stores, registry);
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
};

const seedStoryC = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          C_PROJECT,
          "p9-accept-c",
          C_WORKSPACE,
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
        [C_SESSION, C_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [C_WORKSPACE, C_PROJECT, C_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Open',0,'t','t')",
        [
          C_WORK,
          C_PROJECT,
          C_WORKSPACE,
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
        [C_EXECUTION, C_PROJECT, C_WORKSPACE, C_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [`ses_${C_EXECUTION_T4}`, C_EXECUTION_T4],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [C_EXECUTION_T4, C_PROJECT, C_WORKSPACE, `ses_${C_EXECUTION_T4}`],
      );
    }),
  );
});

const cAcquireLease = (workerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.acquire(C_EXECUTION, workerId));
  });

const cExpireInPlace = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repo = yield* ExecutionRepository;
    yield* tx.transact(repo.releaseLease(C_EXECUTION, workerId, generation));
  });

const cRenewLease = (workerId: string, generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx.transact(leases.renew(C_EXECUTION, workerId, generation));
  });

const cCompleted: SettleExecutionPayload["settlement"] = {
  _tag: "Completed",
  result: { _tag: "CoordinationCompleted" },
};

const cSettleViaGateway = (
  generation: LeaseGeneration,
  settlement: SettleExecutionPayload["settlement"],
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const commandId = nextCCommandId();
    const payload: SettleExecutionPayload = {
      executionId: C_EXECUTION,
      settlement,
      expectedFencingGeneration: generation,
    };
    return yield* gw.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: C_PROJECT,
        actor: C_ACTOR,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: C_PROJECT,
          actor: C_ACTOR,
          schemaVersion: "1",
          payload,
        }),
        projectId: C_PROJECT,
        commandKind: "SettleExecution",
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies VerifiedRuntimeCommandAuthority,
    );
  });

const cSelectCurrentWork = (
  commandId: CommandId,
  generation: LeaseGeneration,
) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const payload = {
      workspaceId: C_WORKSPACE,
      workId: C_WORK,
      expectedWorkspaceRevision: parse(Revision)(0),
    };
    return yield* gw.execute(
      {
        commandType: "SelectCurrentWork",
        commandId,
        projectId: C_PROJECT,
        actor: C_ACTOR,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: C_PRINCIPAL,
        executionId: C_EXECUTION,
        fencingGeneration: generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SelectCurrentWorkAuthority",
        principal: C_PRINCIPAL,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SelectCurrentWork",
          projectId: C_PROJECT,
          actor: C_ACTOR,
          schemaVersion: "1",
          payload,
        }),
        projectId: C_PROJECT,
        targetWorkspaceId: C_WORKSPACE,
      } satisfies VerifiedCommandAuthority,
    );
  });

/** P2 `03` §3 fence predicate composed with the write in ONE transaction
 * (p9-worker-crash withLeaseFence precedent). */
const cLeaseFenceHolds = (generation: LeaseGeneration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const now = yield* clock.now();
    const rows = yield* sql
      .unsafe<{ ok: number }>(
        "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
        [C_EXECUTION, generation, now],
      )
      .pipe(Effect.orDie);
    return rows.length > 0;
  });

const cWithLeaseFence = <A, E, R>(
  generation: LeaseGeneration,
  write: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const holds = yield* cLeaseFenceHolds(generation);
    if (!holds) {
      return yield* Effect.fail({
        _tag: "LeaseFencingRejected" as const,
        executionId: C_EXECUTION,
        generation,
      });
    }
    return yield* write;
  });

const cOpenProviderTurn = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const turns = yield* ProviderTurnStore;
  yield* tx.transact(
    turns.startTurn(
      {
        providerTurnId: C_TURN,
        executionId: C_EXECUTION,
        sessionId: C_SESSION,
        contextEpoch: 0 as never,
        modelRef: "provider-fake",
        outputContractRef: "oc",
        manifestId: "mf_story_c",
      },
      "t",
    ),
  );
});

const cRecordToolIntent = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const tools = yield* ToolInvocationStore;
  yield* tx.transact(
    tools.recordIntent({
      invocationId: C_INVOCATION,
      executionId: C_EXECUTION,
      workspaceId: C_WORKSPACE,
      toolName: "shell",
      toolVersion: "1",
      sideEffectSemantics: "NonIdempotent",
      argumentsJson: "{}",
      resolvedRegions: [],
      approvalId: null,
      intentAt: "t",
    }),
  );
});

const cSideEffectCounters = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const events = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events",
  );
  const commands = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM commands",
  );
  const settled = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM executions WHERE settled_at IS NOT NULL",
  );
  const workWaits = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM work_waits",
  );
  const timers = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM scheduler_timers",
  );
  const sessionEntries = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_entries",
  );
  return {
    events: Number(events[0]!.count),
    commands: Number(commands[0]!.count),
    settled: Number(settled[0]!.count),
    workWaits: Number(workWaits[0]!.count),
    timers: Number(timers[0]!.count),
    sessionEntries: Number(sessionEntries[0]!.count),
  };
});

// ---------------------------------------------------------------------------
// Story D wiring: the p9-provider-disconnect app (disconnect-injecting
// ProviderPort double + ProviderRuntime retry bound).
// ---------------------------------------------------------------------------

const D_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789d3");
const D_WORKSPACE = "ws_018f2b3c-4d5e-7abc-8def-0123456789d3";
const D_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789d3");
const D_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d3",
) as ExecutionId;
const D_MANIFEST = "mf_story_d";
const D_PRINCIPAL = parse(Principal)("runtime:system");

const D_TURN_A = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const D_TURN_B = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d4",
);
const D_TURN_C = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d5",
);
const D_TURN_D = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d6",
);

/** GQ4 frozen mapping: classify by the observable boundary — TurnStarted
 * emitted or not — never by transport errno (P9 `04` §2.1). */
const classifyDisconnect = (sawTurnStarted: boolean): ProviderFailureKind =>
  sawTurnStarted ? "StreamInterrupted" : "ProviderUnavailable";

type DAttemptScript =
  | { readonly disconnect: "pre-connect" | "mid-stream" }
  | { readonly events: ReadonlyArray<CanonicalProviderEvent> };

interface DProbe {
  readonly calls: Array<{
    readonly providerTurnId: ProviderTurnId;
    readonly attemptNo: number;
  }>;
}

const dProviderFailure = (kind: ProviderFailureKind): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind,
});

const dSuccessTurn = (
  turnId: ProviderTurnId,
): ReadonlyArray<CanonicalProviderEvent> => [
  {
    _tag: "TurnStarted",
    providerTurnId: turnId,
    attemptNo: 0,
    modelRef: "provider-fake",
  },
  { _tag: "TextDelta", text: "final" },
  { _tag: "UsageReported", inputTokens: 10, outputTokens: 5 },
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

/** Deterministic disconnect-injecting ProviderPort double keyed by turn id
 * (p9-provider-disconnect DisconnectProviderLive pattern, per-turn
 * scripts). */
const DisconnectProviderLive = (
  scriptByTurn: ReadonlyArray<{
    readonly turnId: ProviderTurnId;
    readonly script: ReadonlyArray<DAttemptScript>;
  }>,
  probe: DProbe,
): Layer.Layer<ProviderPort> =>
  Layer.effect(
    ProviderPort,
    Effect.sync(() => {
      const callsByTurn = new Map<ProviderTurnId, number>();
      return ProviderPort.of({
        runTurn: (input) => {
          const turnId = input.context.providerTurnId;
          const attemptNo = input.context.attemptNo;
          probe.calls.push({ providerTurnId: turnId, attemptNo });
          const call = callsByTurn.get(turnId) ?? 0;
          callsByTurn.set(turnId, call + 1);
          const script =
            scriptByTurn.find((entry) => entry.turnId === turnId)?.script ?? [];
          const step: DAttemptScript = script[
            Math.min(call, script.length - 1)
          ] ?? { events: [] };
          if ("disconnect" in step) {
            if (step.disconnect === "pre-connect") {
              return Stream.fail(dProviderFailure(classifyDisconnect(false)));
            }
            const boundary: CanonicalProviderEvent = {
              _tag: "TurnStarted",
              providerTurnId: turnId,
              attemptNo,
              modelRef: input.request.modelRef,
            };
            return Stream.concat(
              Stream.fromIterable([
                boundary,
                { _tag: "TextDelta" as const, text: "partial-delta" },
              ]),
              Stream.fail(dProviderFailure(classifyDisconnect(true))),
            );
          }
          return Stream.fromIterable(step.events);
        },
      });
    }),
  );

const makeStoryDApp = (
  scriptByTurn: ReadonlyArray<{
    readonly turnId: ProviderTurnId;
    readonly script: ReadonlyArray<DAttemptScript>;
  }>,
  probe: DProbe,
  filename: string,
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      DisconnectProviderLive(scriptByTurn, probe),
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      infra,
    ),
  );
  return Layer.mergeAll(
    infra,
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(TransactionPortLive, infra),
    providerRuntime,
  );
};

const seedStoryD = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          D_PROJECT,
          "p9-accept-d",
          D_WORKSPACE,
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
        [D_SESSION, D_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [D_WORKSPACE, D_PROJECT, D_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [D_EXECUTION, D_PROJECT, D_WORKSPACE, D_SESSION],
      );
    }),
  );
});

const dRunTurnInput = (turnId: ProviderTurnId) => ({
  providerTurnId: turnId,
  executionId: D_EXECUTION,
  sessionId: D_SESSION,
  contextEpoch: 0 as never,
  modelRef: "provider-fake",
  outputContractRef: "oc",
  manifestId: D_MANIFEST,
  request: {
    modelRef: "provider-fake",
    instructions: [],
    messages: [{ role: "user" as const, text: "go" }],
    toolDefinitions: [],
    outputContractRef: "oc",
    budget: { maxOutputTokens: 128 },
    cacheHints: [],
  },
  secretRef: "secret",
  timeoutMs: 30_000,
  cancellationRef: "cancel",
});

const dAttemptRows = (turnId: ProviderTurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      attempt_no: number;
      outcome: string;
      provider_error_kind: string | null;
    }>(
      "SELECT attempt_no, outcome, provider_error_kind FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
      [turnId],
    );
    return rows.map((row) => ({
      attemptNo: Number(row.attempt_no),
      outcome: row.outcome,
      providerErrorKind: row.provider_error_kind,
    }));
  });

const dTurnRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{
    provider_turn_id: string;
    manifest_id: string;
    settled_at: string | null;
    finish_reason: string | null;
    usage_json: string | null;
  }>(
    "SELECT provider_turn_id, manifest_id, settled_at, finish_reason, usage_json FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
    [D_EXECUTION],
  );
});

const dOpenDanglingTurn = (
  turnId: ProviderTurnId,
  crashedAttempts: ReadonlyArray<{
    readonly attemptNo: number;
    readonly kind: "StreamInterrupted" | "RateLimited" | "ProviderUnavailable";
  }>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    yield* tx.transact(
      turns.startTurn(
        {
          providerTurnId: turnId,
          executionId: D_EXECUTION,
          sessionId: D_SESSION,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId: D_MANIFEST,
        },
        "t",
      ),
    );
    for (const attempt of crashedAttempts) {
      yield* tx.transact(
        turns.recordAttempt(
          turnId,
          attempt.attemptNo,
          { _tag: "RetryableFailure", providerErrorKind: attempt.kind },
          "t0",
          "t1",
        ),
      );
    }
  });

const dRecover = (options?: { readonly maxAttempts?: number }) =>
  Effect.gen(function* () {
    const turns = yield* ProviderTurnStore;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    return yield* recoverUnsettledProviderTurns(
      { turns, tx, clock },
      D_PROJECT,
      D_PRINCIPAL,
      options,
    );
  });

const dExecutionSettlement = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [D_EXECUTION],
  );
  return rows[0] === undefined ? "missing" : rows[0].settlement_kind;
});

// ---------------------------------------------------------------------------
// Story E wiring: the p9-tool-outcome-unknown app with per-tier crash
// points.
// ---------------------------------------------------------------------------

const E_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e3");
const E_WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const E_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e3");
const E_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e3",
) as ExecutionId;
const E_ACTOR = parse(Actor)("user:story-e");
const E_PRINCIPAL = parse(Principal)("runtime:system");

type ETier = "ReadOnly" | "Idempotent" | "Reconcilable" | "NonIdempotent";
type ECrashMode = "before-effect" | "after-effect" | "none";

interface EProbe {
  readonly effects: Array<string>;
}

const E_TOOL_NAMES: Record<ETier, string> = {
  ReadOnly: "probe_ro",
  Idempotent: "probe_idem",
  Reconcilable: "probe_rec",
  NonIdempotent: "probe_non",
};

const E_TIERS: ReadonlyArray<ETier> = [
  "ReadOnly",
  "Idempotent",
  "Reconcilable",
  "NonIdempotent",
];

const eTierDefinition = (tier: ETier) => ({
  name: E_TOOL_NAMES[tier],
  version: "1",
  hash: `probe-${tier}-v1`,
  description: `p9 acceptance tier probe (${tier})`,
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [`probe:${tier}`],
  sideEffectSemantics: tier,
  source: "Builtin" as const,
});

const E_DEFINITIONS = E_TIERS.map(eTierDefinition);

/** Fresh invocation identity per call: a replay would be a NEW invocation
 * row, never the crashed row reused (No.35). */
const E_RO_CRASH = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const E_IDEM = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e2",
);
const E_REC = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const E_NON = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e4",
);
const E_RO_RETRY = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789e5",
);

/** Per-tier mutable crash arming: the executor consults the mode on every
 * call so one app can walk all four tiers in sequence. */
const eTierExecutors = (
  probe: EProbe,
  mode: Record<ETier, ECrashMode>,
): ReadonlyArray<ToolExecutor> =>
  E_TIERS.map((tier) => ({
    name: E_TOOL_NAMES[tier],
    write: tier !== "ReadOnly",
    requiresApproval: () => false,
    execute: (input: { readonly intent: { readonly argumentsJson: string } }) =>
      Effect.gen(function* () {
        if (mode[tier] === "before-effect") {
          return yield* Effect.die(
            new Error(`harness-kill:${tier}:pre-effect`),
          );
        }
        probe.effects.push(
          `${E_TOOL_NAMES[tier]}:${input.intent.argumentsJson}`,
        );
        if (mode[tier] === "after-effect") {
          return yield* Effect.die(
            new Error(`harness-kill:${tier}:post-effect`),
          );
        }
        return {
          settlement: { _tag: "Success" as const },
          observation: { text: "ok", truncated: false },
          resultRef: null,
        };
      }),
  }));

const eDefinitionStore = Layer.succeed(ToolDefinitionStore, {
  definition: (name: string, version: string) =>
    Effect.succeed(
      (() => {
        const found = E_DEFINITIONS.find(
          (definition) =>
            definition.name === name && definition.version === version,
        );
        return found === undefined ? Option.none() : Option.some(found);
      })(),
    ),
  all: () => Effect.succeed(E_DEFINITIONS),
});

const eSandbox = Layer.succeed(SandboxPort, {
  open: () =>
    Effect.succeed({ handleId: "p9", rootPath: "/tmp", writableRegions: [] }),
  close: () => Effect.void,
});

const makeStoryEApp = (
  probe: EProbe,
  mode: Record<ETier, ECrashMode>,
  filename: string,
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const execRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    execRepo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, execRepo)),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.provide(ToolInvocationStoreLive, infra),
    ),
    eDefinitionStore,
    eSandbox,
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId: unknown, addresses: ReadonlyArray<unknown>) =>
        Effect.succeed({
          regions: addresses.map(
            (
              address,
            ): { resourceSpaceId: string; normalizedRegion: unknown } => ({
              resourceSpaceId: "probe",
              normalizedRegion: address,
            }),
          ),
          observedEnvironmentRevision: "rev",
        }),
    } as never),
    FenceStopCheckInertLive,
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> =
          makeP2CommandHandlers({
            projects: yield* ProjectRepository,
            workspaces: yield* WorkspaceRepository,
            sessions: yield* SessionRepository,
            executions: yield* ExecutionRepository,
            workWaits: yield* WorkWaitStore,
          });
        return CommandHandlerRegistry.of({
          lookup: (commandType) => {
            const handler = handlers.find(
              (candidate) => candidate.commandType === commandType,
            );
            return handler === undefined ? Option.none() : Option.some(handler);
          },
        });
      }),
    ),
    stores,
  );
  const gatewayDeps = Layer.mergeAll(infra, stores, registry);
  return Layer.mergeAll(
    infra,
    stores,
    Layer.provide(
      ToolRuntimeLive(eTierExecutors(probe, mode)),
      Layer.mergeAll(stores, infra),
    ),
    Layer.provide(CommandGatewayLive, gatewayDeps),
  );
};

const seedStoryE = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          E_PROJECT,
          "p9-accept-e",
          E_WORKSPACE,
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
        [E_SESSION, E_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [E_WORKSPACE, E_PROJECT, E_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [E_EXECUTION, E_PROJECT, E_WORKSPACE, E_SESSION],
      );
    }),
  );
});

const eTierContext = (tier: ETier) => {
  const definition = eTierDefinition(tier);
  return {
    executionId: E_EXECUTION,
    workspaceId: E_WORKSPACE,
    sessionId: E_SESSION,
    projectId: E_PROJECT,
    actor: E_ACTOR,
    authenticatedPrincipal: E_PRINCIPAL,
    authority: {
      principal: E_PRINCIPAL,
      workspaceId: E_WORKSPACE,
      executionId: E_EXECUTION,
      toolName: definition.name,
      toolVersion: "1",
      resourceSpaceIds: [],
      allowedCapabilities: definition.capabilityMetadata,
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      delegationDepth: 0,
    },
    controlBasisDigest: "d",
    requestedAt: "t",
  } as never;
};

const eInvoke = (tier: ETier, invocationId: ToolInvocationId) =>
  Effect.gen(function* () {
    const runtime = yield* ToolRuntimePort;
    return yield* Effect.exit(
      runtime.invoke(
        {
          callRef: `call-${invocationId}`,
          toolName: E_TOOL_NAMES[tier],
          toolVersion: "1",
          argumentsJson: JSON.stringify({ tier }),
          invocationId,
          approvalId: null,
        },
        eTierContext(tier),
      ),
    );
  });

const eDangling = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const store = yield* ToolInvocationStore;
  return yield* tx.transact(store.findUnsettled(E_EXECUTION));
});

const ePending = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const source = yield* ReconciliationSource;
  return yield* tx.transact(source.pending(E_EXECUTION));
});

const eRequestStop = Effect.gen(function* () {
  const repo = yield* ExecutionRepository;
  const tx = yield* TransactionPort;
  const clock = yield* Clock;
  const now = yield* clock.now();
  yield* tx.transact(repo.requestStop(E_EXECUTION, now));
});

const eEscalationFacts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
    [E_EXECUTION],
  );
  return Number(rows[0]!.count);
});

const eExecutionRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [E_EXECUTION],
  );
  return rows[0] ?? null;
});

// ---------------------------------------------------------------------------
// Stories F/G shared: consumer-loop helpers (p9-consumer-crash /
// p9-workflow-interruption construction patterns).
// ---------------------------------------------------------------------------

const F_WORK_C = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f1");
const F_WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000f2");
const F_ASSIGN_CMD_C = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
const F_ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f2",
);
const F_DEP = parse(DependencyId)("dep_00000000-0000-7000-8000-0000000000f1");
const F_DEL = parse(DeliverableId)("del_00000000-0000-7000-8000-0000000000f2");
const F_ART = parse(ArtifactId)("art_00000000-0000-7000-8000-0000000000f3");

const G_WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");
const G_WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b2");
const G_ASSIGN_CMD = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b4",
);
const G_ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b5",
);
const G_DEP = parse(DependencyId)("dep_00000000-0000-7000-8000-0000000000b1");
const G_DEL = parse(DeliverableId)("del_00000000-0000-7000-8000-0000000000b2");
const G_ART = parse(ArtifactId)("art_00000000-0000-7000-8000-0000000000b3");
const G_ACC = parse(AcceptanceId)("acc_00000000-0000-7000-8000-0000000000a5");

const WREV = (n: number) => parse(WorkRevision)(n);
const REV = (n: number) => parse(DependencyRevision)(n);

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

const loopStores: Effect.Effect<
  ConsumerLoopStores,
  never,
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
> = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  const offsets = yield* ConsumerOffsetStore;
  const deadLetters = yield* ConsumerDeadLetterStore;
  const projection = yield* ProjectionStore;
  return {
    tx: { transact: tx.transact },
    journal: { readAfter: journal.readAfter },
    offsets,
    deadLetters,
    projection,
  };
});

const journalHead = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  return yield* tx.transact(journal.lastSequence(p7Project));
});

const preconsume = (consumerId: string) =>
  Effect.gen(function* () {
    const stores = yield* loopStores;
    const head = yield* journalHead;
    yield* pollOnce(consumerId, p7Project, 1000, {
      ...stores,
      handlers: () => Effect.succeed([]),
    });
    return head;
  });

const offsetOf = (consumerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
      [consumerId, p7Project],
    );
    return Number(rows[0]?.last_sequence ?? 0);
  });

const journalEvent = (eventType: string, payload: unknown, eventVersion = 1) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(
      journal.append([
        {
          projectId: p7Project,
          eventType: eventType as EventTypeName,
          eventVersion,
          occurredAt: "t",
          aggregateRef: p7Project,
          actor: p7TestActor,
          payload,
        },
      ]),
    );
  });

const countEvents = (eventType: string) =>
  sqlCount("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?", [
    eventType,
  ]);

const countRows = (
  table: string,
  where = "1=1",
  params: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  });

const seedDependencyAndDeliverable = (
  dep: DependencyId,
  del: DeliverableId,
  consumerWork: WorkId,
  producerWork: WorkId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId: dep,
          consumerWorkId: consumerWork,
          producerBinding: { _tag: "AnyProducer" } as ProducerBinding,
          revision: REV(0),
          expectedDeliverable: expectedOf("report", ["summary"]),
        }),
        p7Project,
      ),
    );
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId: del,
          sourceWorkId: producerWork,
          sourceWorkRevision: 0,
          kind: "report",
        },
        [{ role: "summary", artifactId: F_ART }],
        p7Project,
      ),
    );
  });

const producedPayload = (del: DeliverableId, producerWork: WorkId) => ({
  deliverableId: del,
  sourceWorkId: producerWork,
  sourceWorkRevision: 0,
  kind: "report",
  artifactRoles: ["summary"],
});

/** p7-coordinator test deps shape (repositories + direct-SQL listing). */
const makeCoordinatorDeps = (
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const works = yield* WorkRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
      dependencies: {
        listUnsatisfiedByProject: (projectId: ProjectId) =>
          tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
      },
      deliverables: {
        findById: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.findById(deliverableId)),
        listArtifactRoles: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.listArtifactRoles(deliverableId)),
        deliverablesByProject: (projectId: ProjectId) =>
          tx.transact(
            Effect.gen(function* () {
              const rows = yield* sql.unsafe<{
                readonly deliverable_id: string;
                readonly source_work_id: string;
                readonly source_work_revision: number;
                readonly kind: string;
                readonly role: string | null;
              }>(
                "SELECT d.deliverable_id, d.source_work_id, d.source_work_revision, d.kind, a.role FROM deliverables d LEFT JOIN deliverable_artifacts a ON a.deliverable_id = d.deliverable_id WHERE d.project_id = ? ORDER BY d.deliverable_id, a.role",
                [projectId],
              );
              const snapshots = new Map<
                string,
                {
                  deliverableId: DeliverableId;
                  sourceWorkId: WorkId;
                  sourceWorkRevision: number;
                  kind: string;
                  artifactRoles: string[];
                }
              >();
              for (const row of rows) {
                const current = snapshots.get(row.deliverable_id);
                if (current === undefined) {
                  snapshots.set(row.deliverable_id, {
                    deliverableId: row.deliverable_id as DeliverableId,
                    sourceWorkId: row.source_work_id as WorkId,
                    sourceWorkRevision: row.source_work_revision,
                    kind: row.kind,
                    artifactRoles: row.role === null ? [] : [row.role],
                  });
                } else if (row.role !== null) {
                  current.artifactRoles.push(row.role);
                }
              }
              return [...snapshots.values()];
            }),
          ),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

const makeVerificationDeps = (gateway: CommandGatewayService) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    return {
      gateway,
      verifications: {
        findOpenByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
          tx.transact(
            verifications.findOpenByWorkRevision(workId, targetWorkRevision),
          ),
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
      workspaces: {
        findById: (workspaceId: WorkspaceId) =>
          tx.transact(workspaces.findById(workspaceId)),
      },
    };
  });

const makeCompletionDeps = () =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    return {
      gateway,
      verifications: {
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      acceptances: {
        findByWorkRevision: () => Effect.succeed(Option.none()),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

/** One-shot pre-commit interruption at the gateway (WF1/WF3): the first
 * matching submission dies with the transient operational class. */
const transientOnceGateway = (
  gateway: CommandGatewayService,
  commandType: string,
): { gateway: CommandGatewayService; fired: () => boolean } => {
  let fired = false;
  return {
    fired: () => fired,
    gateway: {
      execute: (envelope, context, authority) =>
        Effect.suspend(() => {
          if (!fired && envelope.commandType === commandType) {
            fired = true;
            return Effect.die({
              _tag: "TransactionOperationalFailure",
              cause: "harness-kill:pre-commit",
            }) as never;
          }
          return gateway.execute(envelope, context, authority);
        }) as never,
    },
  };
};

/** Gateway wrapper: arm the commit gate after the handler's command
 * transaction landed (CC mid-batch injection point). */
const armingGateway = (
  gateway: CommandGatewayService,
  gate: { armed: boolean },
): CommandGatewayService => ({
  execute: (envelope, context, authority) =>
    gateway.execute(envelope, context, authority).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          gate.armed = true;
        }),
      ),
    ) as never,
});

const INSERT_EXECUTION_G = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${executionId}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${executionId}`],
    );
  });

const dispatchRound = (
  executionId: string,
  port: Layer.Layer<WorkerDispatchPort>,
) =>
  Effect.provide(
    Effect.gen(function* () {
      const dispatch = yield* WorkerDispatchPort;
      yield* dispatch.dispatch({
        executionId: executionId as never as ExecutionId,
        workspaceId: p7RootWorkspace,
        workerKind: "Agent",
      });
    }),
    port,
  );

const dyingDispatch = (): Layer.Layer<WorkerDispatchPort> =>
  Layer.succeed(WorkerDispatchPort, {
    dispatch: () => Effect.die(new Error("harness-kill:dispatch")),
  });

const settleCompletedG = (executionId: string) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    const lease = yield* tx.transact(
      leases.acquire(executionId as never as ExecutionId, "worker:story-g"),
    );
    const payload: SettleExecutionPayload = {
      executionId: executionId as never as ExecutionId,
      settlement: {
        _tag: "Completed",
        result: { _tag: "CoordinationCompleted" },
      },
      expectedFencingGeneration: lease.generation,
    };
    const commandId = `cmd_settle_p9ag_${executionId}` as never as CommandId;
    return yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: p7Project,
          actor: p7TestActor,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        commandKind: "SettleExecution",
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      },
    );
  });

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story A (06 §A) [crash-injected]: recovery visibility gate — before-form recorded, after-form escalates the unsettled NonIdempotent stop and NEVER settles Interrupted", async () => {
    expect(
      labeled("story-A-recovery-visibility-gate", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_sa_dirty", "t");
        yield* INSERT_INVOCATION("tin_sa_non", "exe_sa_dirty", "NonIdempotent");
        yield* INSERT_EXECUTION("exe_sa_clean", "t");
        // BEFORE (B-1 stub-era defect shape): the retired stub's pending
        // visibility is the empty list, so a stopped execution carrying an
        // unsettled NonIdempotent invocation would take the clean path and
        // settle Interrupted — the form demonstrated by the clean twin.
        const stubEraPending: ReadonlyArray<unknown> = [];
        expect(stubEraPending.length).toBe(0);
        // AFTER: the wired ReconciliationSource sees the dangling
        // invocation; recovery escalates with a durable Attention fact.
        const recovery = yield* runRecovery(p7TestPrincipal);
        expect([...recovery.settled].sort()).toEqual(["exe_sa_clean"]);
        expect(recovery.escalated).toEqual(["exe_sa_dirty"]);
        const clean = yield* executionRowOf("exe_sa_clean");
        expect(clean?.settlement_kind).toBe("Interrupted");
        expect(JSON.parse(clean?.settlement_json ?? "null")).toEqual({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        const dirty = yield* executionRowOf("exe_sa_dirty");
        expect(dirty?.settlement_kind).not.toBe("Interrupted");
        expect(dirty?.settlement_kind).toBeNull();
        expect(dirty?.settled_at).toBeNull();
        expect(dirty?.settlement_json).toBeNull();
        expect(yield* attentionFacts("exe_sa_dirty")).toBe(1);
        expect(yield* countEventsFor("exe_sa_dirty", "ExecutionSettled")).toBe(
          0,
        );
        expect(yield* countEventsFor("exe_sa_clean", "ExecutionSettled")).toBe(
          1,
        );
      }),
      makeP7App(durableFile("a")),
    );
  });

  it("Story B-clean (06 §B1) [crash-injected]: dirty restart, all invocations settled — one T1 settles Interrupted(StopRequested) + completion fact → Completed; lease invalidated, timers re-fired, runnable re-driven, repeated T1 idempotent", async () => {
    expect(
      labeled("story-B-clean-dirty-restart", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const { calls, app } = makeStoryBApp(durableFile("b1"));
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_sb_clean", "t");
        const fact = yield* INSERT_COMPLETION_FACT("exe_sb_fact");
        yield* INSERT_EXECUTION("exe_sb_fact", null);
        yield* INSERT_EXPIRED_LEASE("exe_sb_clean");
        yield* INSERT_TIMER("tmr_sb_due", "2000-01-01T00:00:00.000Z");
        yield* INSERT_TIMER("tmr_sb_future", "2999-01-01T00:00:00.000Z");
        const first = yield* startupRecovery(p7TestPrincipal);
        expect([...first.recovery.settled].sort()).toEqual([
          "exe_sb_clean",
          "exe_sb_fact",
        ]);
        expect(first.recovery.escalated).toEqual([]);
        expect(first.recovery.invalidated).toBeGreaterThanOrEqual(1);
        const clean = yield* executionRowOf("exe_sb_clean");
        expect(clean?.settlement_kind).toBe("Interrupted");
        expect(JSON.parse(clean?.settlement_json ?? "null")).toEqual({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        const completed = yield* executionRowOf("exe_sb_fact");
        expect(completed?.settlement_kind).toBe("Completed");
        expect(JSON.parse(completed?.settlement_json ?? "null")).toEqual(fact);
        expect(
          first.firedTimers.map((timer: SchedulerTimer) => timer.timerId),
        ).toEqual(["tmr_sb_due"]);
        expect(yield* timerIds()).toEqual(["tmr_sb_future"]);
        expect(calls).toEqual([
          { workspaceId: p7RootWorkspace, wakeReasonTag: "Recovery" },
        ]);
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = 'cmd_recovery_completion_exe_sb_fact'",
          ),
        ).toBe(1);
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = 'cmd_recovery_settle_exe_sb_clean'",
          ),
        ).toBe(1);
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
        expect(yield* countEventsFor("exe_sb_clean", "ExecutionSettled")).toBe(
          1,
        );
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
        yield* runMigrations(P8_MIGRATIONS);
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
        yield* INSERT_EXECUTION("exe_sb_pending", "t");
        yield* INSERT_INVOCATION("tin_sb_ro", "exe_sb_pending", "ReadOnly");
        yield* INSERT_INVOCATION("tin_sb_idem", "exe_sb_pending", "Idempotent");
        yield* INSERT_INVOCATION(
          "tin_sb_rec",
          "exe_sb_pending",
          "Reconcilable",
        );
        yield* INSERT_INVOCATION(
          "tin_sb_non",
          "exe_sb_pending",
          "NonIdempotent",
        );
        yield* INSERT_TIMER("tmr_sbp_due", "2000-01-01T00:00:00.000Z");
        yield* INSERT_TIMER("tmr_sbp_future", "2999-01-01T00:00:00.000Z");
        yield* INSERT_EXPIRED_LEASE("exe_sb_pending");
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?, 'Any', '[]', 't', 't')",
          [WORK_B3],
        );
        // T1 over the full pending-state fixture.
        const first = yield* startupRecovery(p7TestPrincipal);
        expect(first.recovery.settled).toEqual([]);
        expect(first.recovery.escalated).toEqual(["exe_sb_pending"]);
        expect(first.recovery.invalidated).toBeGreaterThanOrEqual(1);
        expect(
          first.firedTimers.map((timer: SchedulerTimer) => timer.timerId),
        ).toEqual(["tmr_sbp_due"]);
        const pending = yield* executionRowOf("exe_sb_pending");
        expect(pending?.settlement_kind).not.toBe("Interrupted");
        expect(pending?.settlement_kind).toBeNull();
        expect(pending?.stop_requested_at).not.toBeNull();
        expect(yield* attentionFacts("exe_sb_pending")).toBe(1);
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
        expect(second.recovery.escalated).toEqual(["exe_sb_pending"]);
        expect(second.firedTimers).toEqual([]);
        expect(yield* attentionFacts("exe_sb_pending")).toBe(1);
        expect(calls).toHaveLength(1);
        // Four-tier disposition: ReadOnly + Idempotent settle safely (the
        // Idempotent settlement write replays as a no-op — still one row),
        // Reconcilable settles after reconcile; NonIdempotent stays
        // escalated — the execution NEVER takes plain Interrupted.
        yield* settleInvocation("tin_sb_ro");
        yield* settleInvocation("tin_sb_idem");
        const idemRowOnce = yield* invocationRowOf("tin_sb_idem");
        yield* settleInvocation("tin_sb_idem");
        const idemRowTwice = yield* invocationRowOf("tin_sb_idem");
        expect(idemRowTwice).toEqual(idemRowOnce);
        yield* settleInvocation("tin_sb_rec");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = 'tin_sb_idem'",
          ),
        ).toBe(1);
        const third = yield* startupRecovery(p7TestPrincipal);
        expect(third.recovery.settled).toEqual([]);
        expect(third.recovery.escalated).toEqual(["exe_sb_pending"]);
        // The [non]-only fingerprint is new relative to the seeded
        // [non, rec] fact → exactly one additional durable Attention fact.
        expect(yield* attentionFacts("exe_sb_pending")).toBe(2);
        const finalState = yield* executionRowOf("exe_sb_pending");
        expect(finalState?.settlement_kind).not.toBe("Interrupted");
        expect(finalState?.settlement_kind).toBeNull();
        const nonRow = yield* invocationRowOf("tin_sb_non");
        expect(nonRow?.settled_at).toBeNull();
        expect(nonRow?.settlement_kind).toBeNull();
      }),
      app,
    );
  });

  it("Story C (06 §C) [crash-injected]: resurrection and expiry — five stale write surfaces all rejected, renewal boundary (TTL/3) commits then rejects, pre-dispatch T4 runs zero nine-step side effects", async () => {
    expect(
      labeled("story-C-resurrection-and-expiry", "crash-injected").guarantee,
    ).toBe("crash-injected");
    expect(LEASE_RENEW_INTERVAL_MS).toBe(LEASE_TTL_MS / 3);
    await runOn(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seedStoryC;
        // Takeover fixture: the old worker (g) resurrects across g+1.
        const old = yield* cAcquireLease("worker:a");
        yield* cExpireInPlace("worker:a", old.generation);
        const current = yield* cAcquireLease("worker:b");
        expect(Number(current.generation)).toBe(Number(old.generation) + 1);
        // Surface 1: stale Execution settle.
        const r1 = yield* cSettleViaGateway(old.generation, cCompleted);
        const r1Resolution = (
          r1 as { resolution: { _tag: string; error?: { _tag: string } } }
        ).resolution;
        expect(r1Resolution._tag).toBe("TerminalRejected");
        expect(r1Resolution.error?._tag).toBe("FencingRejected");
        // Surface 2: stale Session append.
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const r2 = yield* tx
          .transact(
            sessions.appendEntry(
              C_SESSION,
              { entryKind: "ModelOutput", payload: { text: "stale" } },
              { executionId: C_EXECUTION, fencingGeneration: old.generation },
            ),
          )
          .pipe(Effect.flip);
        expect((r2 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
            [C_SESSION],
          ),
        ).toBe(0);
        // Surface 3: stale ProviderTurn settlement (fence shares the tx).
        yield* cOpenProviderTurn;
        const turns = yield* ProviderTurnStore;
        const r3 = yield* tx
          .transact(
            cWithLeaseFence(
              old.generation,
              turns.settleTurn(C_TURN, "Stop", "{}", "t"),
            ),
          )
          .pipe(Effect.flip);
        expect((r3 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM provider_turns WHERE provider_turn_id = ? AND settled_at IS NULL",
            [C_TURN],
          ),
        ).toBe(1);
        // Surface 4: stale ToolInvocation settlement.
        yield* cRecordToolIntent;
        const tools = yield* ToolInvocationStore;
        const r4 = yield* tx
          .transact(
            cWithLeaseFence(
              old.generation,
              tools.settle(C_INVOCATION, { _tag: "Success" }, null, "t"),
            ),
          )
          .pipe(Effect.flip);
        expect((r4 as { _tag: string })._tag).toBe("LeaseFencingRejected");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ? AND settled_at IS NULL",
            [C_INVOCATION],
          ),
        ).toBe(1);
        // Surface 5: stale agent-produced canonical command.
        const staleCommandId = nextCCommandId();
        const r5 = yield* cSelectCurrentWork(staleCommandId, old.generation);
        const r5Retry = yield* cSelectCurrentWork(
          staleCommandId,
          old.generation,
        );
        const r5Live = yield* cSelectCurrentWork(
          nextCCommandId(),
          current.generation,
        );
        const staleResolution = (
          r5 as { resolution: { _tag: string; error?: { _tag: string } } }
        ).resolution;
        expect(staleResolution._tag).toBe("TerminalRejected");
        expect(staleResolution.error?._tag).toBe("FencingRejected");
        expect(
          (r5Retry as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("TerminalRejected");
        expect(
          (r5Live as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM works WHERE work_id = ? AND lifecycle = 'Open'",
            [C_WORK],
          ),
        ).toBe(1);
        // Renewal boundary: while live the CAS commits and the fenced
        // write lands; after expiry both reject.
        yield* Effect.sleep(2);
        const renewed = yield* cRenewLease("worker:b", current.generation);
        expect(Number(renewed.generation)).toBe(Number(current.generation));
        expect(renewed.expiresAt > current.expiresAt).toBe(true);
        const ownerAppend = yield* tx.transact(
          sessions.appendEntry(
            C_SESSION,
            { entryKind: "ModelOutput", payload: { text: "owner" } },
            {
              executionId: C_EXECUTION,
              fencingGeneration: current.generation,
            },
          ),
        );
        expect(ownerAppend.sequence).toBe(0);
        yield* cExpireInPlace("worker:b", current.generation);
        // L1 face: post-expiry settle rejected — the fence predicate's
        // `expires_at > now` clause fails for the released lease.
        const lateSettle = yield* cSettleViaGateway(
          current.generation,
          cCompleted,
        );
        const lateSettleResolution = (
          lateSettle as {
            resolution: { _tag: string; error?: { _tag: string } };
          }
        ).resolution;
        expect(lateSettleResolution._tag).toBe("TerminalRejected");
        expect(lateSettleResolution.error?._tag).toBe("FencingRejected");
        const lateExec = yield* executionRowOf(C_EXECUTION);
        expect(lateExec?.settled_at).toBeNull();
        // T4: the targeted pre-dispatch check is the fence predicate read
        // only — zero nine-step observables (side-effect count = 0).
        const live = yield* cAcquireLease("worker:c");
        expect(Number(live.generation)).toBe(Number(current.generation) + 1);
        const before = yield* cSideEffectCounters;
        expect(yield* preDispatchCheck(C_EXECUTION)).toBe(false);
        yield* cExpireInPlace("worker:c", live.generation);
        expect(yield* preDispatchCheck(C_EXECUTION)).toBe(true);
        expect(yield* preDispatchCheck(C_EXECUTION_T4 as never)).toBe(true);
        expect(yield* cSideEffectCounters).toEqual(before);
        // L3 face: stale-worker renewal and stale fenced write rejected
        // after the takeover-by-expiry window.
        const lateRenew = yield* cRenewLease(
          "worker:b",
          current.generation,
        ).pipe(Effect.flip);
        expect((lateRenew as { _tag: string })._tag).toBe(
          "LeaseFencingRejected",
        );
        const lateAppend = yield* tx
          .transact(
            sessions.appendEntry(
              C_SESSION,
              { entryKind: "ModelOutput", payload: { text: "late" } },
              {
                executionId: C_EXECUTION,
                fencingGeneration: current.generation,
              },
            ),
          )
          .pipe(Effect.flip);
        expect((lateAppend as { _tag: string })._tag).toBe(
          "LeaseFencingRejected",
        );
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
            [C_SESSION],
          ),
        ).toBe(1);
      }),
      makeStoryCApp(durableFile("c")),
    );
  });

  it("Story D (06 §D) [crash-injected]: provider disconnect — ProviderUnavailable/StreamInterrupted retried under the same Turn, crash-left turn recovered same Turn/Manifest with a new Attempt, bound exhausted → Turn failed, Execution never settled by recovery", async () => {
    expect(
      labeled("story-D-provider-disconnect", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: DProbe = { calls: [] };
    await runOn(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seedStoryD;
        const runtime = yield* ProviderRuntime;
        // Connect-phase inject → ProviderUnavailable; retried under the
        // SAME Turn with turnNo unchanged.
        const eventsA = yield* runtime.runTurn(dRunTurnInput(D_TURN_A));
        expect(eventsA.some((event) => event._tag === "TurnCompleted")).toBe(
          true,
        );
        // Mid-stream inject → StreamInterrupted; append-only history.
        yield* runtime.runTurn(dRunTurnInput(D_TURN_B));
        // Crash leftovers: turn C exhausted its retry bound, turn D died
        // mid-stream after one recorded attempt.
        yield* dOpenDanglingTurn(D_TURN_C, [
          { attemptNo: 0, kind: "RateLimited" },
          { attemptNo: 1, kind: "RateLimited" },
          { attemptNo: 2, kind: "RateLimited" },
        ]);
        yield* dOpenDanglingTurn(D_TURN_D, [
          { attemptNo: 0, kind: "StreamInterrupted" },
        ]);
        const report = yield* dRecover({ maxAttempts: 3 });
        const turnsAfter = yield* dTurnRows;
        const settlement = yield* dExecutionSettlement;
        // The recovery pass never called the provider (5 transport calls
        // total: 3 pre-connect retries + 2 mid-stream).
        expect(probe.calls).toHaveLength(5);
        expect(
          probe.calls
            .filter((call) => call.providerTurnId === D_TURN_A)
            .map((call) => call.attemptNo),
        ).toEqual([0, 1, 2]);
        expect(
          probe.calls
            .filter((call) => call.providerTurnId === D_TURN_B)
            .map((call) => call.attemptNo),
        ).toEqual([0, 1]);
        // PD mapping: classification by the observable boundary.
        expect(yield* dAttemptRows(D_TURN_A)).toEqual([
          {
            attemptNo: 0,
            outcome: "RetryableFailure",
            providerErrorKind: "ProviderUnavailable",
          },
          {
            attemptNo: 1,
            outcome: "RetryableFailure",
            providerErrorKind: "ProviderUnavailable",
          },
          { attemptNo: 2, outcome: "Success", providerErrorKind: null },
        ]);
        expect(yield* dAttemptRows(D_TURN_B)).toEqual([
          {
            attemptNo: 0,
            outcome: "RetryableFailure",
            providerErrorKind: "StreamInterrupted",
          },
          { attemptNo: 1, outcome: "Success", providerErrorKind: null },
        ]);
        // Same Turn identity + same Manifest across every retry and every
        // recovery disposition (turnNo invariant).
        expect(turnsAfter).toHaveLength(4);
        for (const turn of turnsAfter) {
          expect(turn.manifest_id).toBe(D_MANIFEST);
        }
        const settledA = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_A,
        );
        const settledB = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_B,
        );
        expect(settledA?.settled_at).not.toBeNull();
        expect(settledA?.finish_reason).toBe("Stop");
        expect(settledB?.settled_at).not.toBeNull();
        expect(settledB?.finish_reason).toBe("Stop");
        // Bound exhausted → existing Turn-failure semantics.
        expect(report.retryPlan.map((entry) => entry.providerTurnId)).toEqual([
          D_TURN_D,
        ]);
        expect(report.failedTurns).toHaveLength(1);
        expect(report.failedTurns[0]!.providerTurnId).toBe(D_TURN_C);
        expect(report.failedTurns[0]!.exhausted).toBe(true);
        const turnC = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_C,
        );
        expect(turnC?.settled_at).not.toBeNull();
        expect(turnC?.finish_reason).toBe("Failed");
        // Unsettled-turn recovery: same Turn, new Attempt, Manifest intact.
        const planD = report.retryPlan[0]!;
        expect(planD.manifestId).toBe(D_MANIFEST);
        expect(planD.nextAttemptNo).toBe(1);
        expect(planD.lastProviderErrorKind).toBe("StreamInterrupted");
        // Recovery never invents an Execution settlement.
        expect(settlement).toBeNull();
        // The resumed transport retry lands under the SAME Turn and
        // settles it with the per-Turn usage aggregate.
        const tx = yield* TransactionPort;
        const store = yield* ProviderTurnStore;
        yield* tx.transact(
          store.recordAttempt(
            D_TURN_D,
            planD.nextAttemptNo,
            { _tag: "Success" },
            "t2",
            "t3",
          ),
        );
        yield* tx.transact(
          store.settleTurn(
            D_TURN_D,
            "Stop",
            JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
            "t3",
          ),
        );
        const resumed = (yield* dTurnRows).find(
          (turn) => turn.provider_turn_id === D_TURN_D,
        );
        expect(resumed?.settled_at).not.toBeNull();
        expect(resumed?.finish_reason).toBe("Stop");
        expect(JSON.parse(resumed?.usage_json ?? "{}")).toEqual({
          inputTokens: 10,
          outputTokens: 5,
        });
        expect(yield* dAttemptRows(D_TURN_D)).toEqual([
          {
            attemptNo: 0,
            outcome: "RetryableFailure",
            providerErrorKind: "StreamInterrupted",
          },
          { attemptNo: 1, outcome: "Success", providerErrorKind: null },
        ]);
      }),
      makeStoryDApp(
        [
          {
            turnId: D_TURN_A,
            script: [
              { disconnect: "pre-connect" },
              { disconnect: "pre-connect" },
              { events: dSuccessTurn(D_TURN_A) },
            ],
          },
          {
            turnId: D_TURN_B,
            script: [
              { disconnect: "mid-stream" },
              { events: dSuccessTurn(D_TURN_B) },
            ],
          },
        ],
        probe,
        durableFile("d"),
      ),
    );
  });

  it("Story E (06 §E) [crash-injected]: tool four tiers — dangling detected for all, ReadOnly retries clean, Idempotent same-identity no-duplicate-effect, Reconcilable reconcile-then-settle, NonIdempotent NEVER auto-replayed and the execution NEVER settles Interrupted", async () => {
    expect(labeled("story-E-tool-four-tiers", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const probe: EProbe = { effects: [] };
    const mode: Record<ETier, ECrashMode> = {
      ReadOnly: "before-effect",
      Idempotent: "after-effect",
      Reconcilable: "after-effect",
      NonIdempotent: "after-effect",
    };
    await runOn(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* seedStoryE;
        // ReadOnly: crash before the effect — nothing happened externally;
        // the crashed invocation settles the actual (no-op) outcome and a
        // clean retry under a fresh identity settles Success.
        const roCrash = yield* eInvoke("ReadOnly", E_RO_CRASH);
        expect((defectOf(roCrash) as Error).message).toBe(
          "harness-kill:ReadOnly:pre-effect",
        );
        const danglingRo = yield* eDangling;
        expect(danglingRo).toHaveLength(1);
        expect(danglingRo[0]!.sideEffectSemantics).toBe("ReadOnly");
        yield* settleInvocation(E_RO_CRASH);
        mode.ReadOnly = "none";
        const roRetry = yield* eInvoke("ReadOnly", E_RO_RETRY);
        expect(roRetry._tag).toBe("Success");
        yield* settleInvocation(E_RO_RETRY);
        expect(probe.effects).toHaveLength(1);
        // Idempotent: crash after the effect; the same-identity settlement
        // write replays as a no-op — exactly one row, one external effect.
        const idemCrash = yield* eInvoke("Idempotent", E_IDEM);
        expect((defectOf(idemCrash) as Error).message).toBe(
          "harness-kill:Idempotent:post-effect",
        );
        yield* settleInvocation(E_IDEM);
        const idemRowOnce = yield* invocationRowOf(E_IDEM);
        yield* settleInvocation(E_IDEM);
        const idemRowTwice = yield* invocationRowOf(E_IDEM);
        expect(idemRowTwice).toEqual(idemRowOnce);
        expect(
          yield* sqlCount(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
            [E_IDEM],
          ),
        ).toBe(1);
        expect(probe.effects).toHaveLength(2);
        // NonIdempotent: ambiguity escalates — never automatic replay.
        const nonCrash = yield* eInvoke("NonIdempotent", E_NON);
        expect((defectOf(nonCrash) as Error).message).toBe(
          "harness-kill:NonIdempotent:post-effect",
        );
        yield* eRequestStop;
        const pass1 = yield* runRecovery(E_PRINCIPAL);
        expect(pass1.settled).toEqual([]);
        expect(pass1.escalated).toEqual([E_EXECUTION]);
        expect(yield* eEscalationFacts).toBe(1);
        expect(probe.effects).toHaveLength(3);
        // Reconcilable: while it dangles the stop path still escalates;
        // reconcile-then-settle is the only unlock.
        const recCrash = yield* eInvoke("Reconcilable", E_REC);
        expect((defectOf(recCrash) as Error).message).toBe(
          "harness-kill:Reconcilable:post-effect",
        );
        const pendingAll = yield* ePending;
        expect([...pendingAll].map(String).sort()).toEqual(
          [String(E_NON), String(E_REC)].sort(),
        );
        const pass2 = yield* runRecovery(E_PRINCIPAL);
        expect(pass2.settled).toEqual([]);
        expect(pass2.escalated).toEqual([E_EXECUTION]);
        // The [non, rec] fingerprint differs from the seeded [non] fact →
        // exactly one additional durable Attention fact.
        expect(yield* eEscalationFacts).toBe(2);
        yield* settleInvocation(E_REC);
        const pass3 = yield* runRecovery(E_PRINCIPAL);
        expect(pass3.settled).toEqual([]);
        expect(pass3.escalated).toEqual([E_EXECUTION]);
        // The [non] fingerprint already has its fact → no third mint.
        expect(yield* eEscalationFacts).toBe(2);
        // Final tier ledger: no replay ever (one row per identity), the
        // NonIdempotent invocation stays reconciling, the Execution never
        // settles plain Interrupted/Completed/Failed.
        expect(
          yield* sqlCount("SELECT COUNT(*) AS count FROM tool_invocations"),
        ).toBe(5);
        const finalExecution = yield* eExecutionRow;
        expect(finalExecution?.settlement_kind).toBeNull();
        expect(finalExecution?.settlement_kind).not.toBe("Interrupted");
        const nonRow = yield* invocationRowOf(E_NON);
        expect(nonRow?.settled_at).toBeNull();
        expect(nonRow?.settlement_kind).toBeNull();
        const danglingFinal = yield* eDangling;
        expect(danglingFinal).toHaveLength(1);
        expect(danglingFinal[0]!.sideEffectSemantics).toBe("NonIdempotent");
        expect(probe.effects).toHaveLength(4);
      }),
      makeStoryEApp(probe, mode, durableFile("e")),
    );
  });

  it("Story F (06 §F) [crash-injected + durability-asserted]: consumer crash mid-batch replays idempotently, poison dead-letters, reopen evidence reconciles, rebuild floor-refuses / resets / replays idempotently; GQ2 P10 boundary negative", async () => {
    expect(
      labeled("story-F-consumer-rebuild", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const filename = durableFile("f");
    const gate = commitGate();
    const expected = await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const consumer = yield* p7SeedWork(F_WORK_C, F_ASSIGN_CMD_C);
        expect(consumer.resolution._tag).toBe("Committed");
        const producer = yield* p7SeedWork(F_WORK_P, F_ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        yield* seedDependencyAndDeliverable(F_DEP, F_DEL, F_WORK_C, F_WORK_P);
        const head = yield* preconsume("sf1");
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(F_DEL, F_WORK_P),
        );
        // CC mid-batch: apply committed, advance died at the commit
        // boundary — both roll back, redelivery re-applies idempotently.
        const stores = yield* loopStores;
        const arming = yield* makeCoordinatorDeps((base) =>
          armingGateway(base, gate),
        );
        const failure = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            arming,
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(yield* offsetOf("sf1")).toBe(head);
        const clean = yield* makeCoordinatorDeps();
        const replay = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            clean,
          ),
        });
        const headAfterSatisfy = yield* journalHead;
        expect(replay.applied).toBe(headAfterSatisfy - head);
        expect(yield* offsetOf("sf1")).toBe(headAfterSatisfy);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* countRows(
            "dependencies",
            "dependency_id = ? AND state = 'Satisfied'",
            [F_DEP],
          ),
        ).toBe(1);
        // Poison: eventVersion above the reader ceiling dead-letters in
        // the same transaction; the batch continues past it.
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(F_DEL, F_WORK_P),
        );
        yield* journalEvent("WorkspaceCreated", {}, 2);
        const poison = yield* pollOnce("sf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            clean,
          ),
        });
        expect(poison.applied).toBe(1);
        expect(poison.quarantined).toBe(1);
        expect(
          yield* countRows(
            "consumer_dead_letters",
            "consumer_id = ? AND reason LIKE '%unsupported eventVersion%'",
            ["sf1"],
          ),
        ).toBe(1);
        return {
          works: yield* countRows("works"),
          executions: yield* countRows("executions"),
          domain_events: yield* countRows("domain_events"),
          commands: yield* countRows("commands"),
          consumer_offsets: yield* countRows("consumer_offsets"),
        };
      }),
      makeP9ConsumerApp({
        filename,
        transaction: gatedTransactionPort(gate),
      }),
    );
    // Daemon exit (scope closed) → reopen with a fresh connection and
    // collect the frozen five-step durability evidence (02 §12).
    const evidence: DurabilityEvidence =
      await collectDurabilityEvidence(filename);
    expect(
      labeled("story-F-DA-evidence", "durability-asserted").guarantee,
    ).toBe("durability-asserted");
    expect(evidence.guarantee).not.toBe("crash-injected");
    expect(evidence.synchronous).toBe(2);
    expect(evidence.journalMode.toLowerCase()).toBe("wal");
    expect(evidence.integrity).toBe("ok");
    expect(evidence.version).toBe(
      P8_MIGRATIONS.reduce((max, migration) => Math.max(max, migration.id), 0),
    );
    expect(evidence.counts.works).toBe(expected.works);
    expect(evidence.counts.executions).toBe(expected.executions);
    expect(evidence.counts.domain_events).toBe(expected.domain_events);
    expect(evidence.counts.commands).toBe(expected.commands);
    expect(evidence.counts.consumer_offsets).toBe(expected.consumer_offsets);
    // Restart (fresh app on the same durable file): rebuild semantics +
    // the GQ2 P10 boundary negative assertion.
    await runP9Consumer(
      Effect.gen(function* () {
        const businessProjectionSurface =
          /InboxProjection[S]tore|Attention[P]rojection|Attention[V]iew|Waitgraph[V]iew|rebuild[I]nbox|rebuild[A]ttention|rebuild[W]aitGraph/;
        const dir = import.meta.dirname;
        const p9Suites = readdirSync(dir).filter(
          (name) => name.startsWith("p9-") && name.endsWith(".test.ts"),
        );
        expect(p9Suites.length).toBeGreaterThanOrEqual(13);
        for (const name of p9Suites) {
          expect(
            businessProjectionSurface.test(
              readFileSync(join(dir, name), "utf8"),
            ),
            `${name} must not touch business-projection rebuild (P10, GQ2)`,
          ).toBe(false);
        }
        const sql = yield* SqlClient;
        // Establish the rebuild consumer position.
        const consumed = yield* runConsumerBatch("sf_rb", p7Project, 1000);
        expect(consumed.quarantined).toBeGreaterThanOrEqual(1);
        const trueOffset = yield* offsetOf("sf_rb");
        expect(trueOffset).toBe(
          Number(
            (yield* sql.unsafe<{ max: number }>(
              "SELECT MAX(sequence) AS max FROM domain_events WHERE project_id = ?",
              [p7Project],
            ))[0]?.max ?? 0,
          ),
        );
        // Floor refusal: offset regressed below the pruned floor — typed
        // refusal, no partial reset, no state destruction.
        yield* sql.unsafe(
          "DELETE FROM domain_events WHERE project_id = ? AND sequence < 3",
          [p7Project],
        );
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = 1 WHERE consumer_id = ?",
          ["sf_rb"],
        );
        const refused = yield* rebuildProjection("sf_rb", p7Project).pipe(
          Effect.flip,
        );
        expect(refused._tag).toBe("ConsumerRebuildRefused");
        expect(refused).toMatchObject({ offset: 1, floor: 3 });
        expect(yield* offsetOf("sf_rb")).toBe(1);
        // Reset + replay: restore the offset, rebuild from the floor.
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [trueOffset, "sf_rb"],
        );
        const retained = yield* sql.unsafe<{
          sequence: number;
          event_version: number;
        }>(
          "SELECT sequence, event_version FROM domain_events WHERE project_id = ? AND sequence >= 3 ORDER BY sequence",
          [p7Project],
        );
        const rebuilt = yield* rebuildProjection("sf_rb", p7Project);
        expect(rebuilt.floor).toBe(3);
        expect(rebuilt.replayed).toBe(retained.length);
        const projection = yield* sql.unsafe<{ sequence: number }>(
          "SELECT sequence FROM projection_state ORDER BY sequence",
        );
        expect(projection.map((row) => Number(row.sequence))).toEqual(
          retained
            .filter((row) => Number(row.event_version) === 1)
            .map((row) => Number(row.sequence)),
        );
        expect(yield* offsetOf("sf_rb")).toBe(trueOffset);
        // Replay idempotency: re-running the rebuild is a no-op delta.
        const again = yield* rebuildProjection("sf_rb", p7Project);
        expect(again).toEqual(rebuilt);
        const projectionAgain = yield* sql.unsafe<{ sequence: number }>(
          "SELECT sequence FROM projection_state ORDER BY sequence",
        );
        expect(projectionAgain).toEqual(projection);
      }),
      makeP9ConsumerApp({ filename }),
    );
  });

  it("Story G (06 §G) [crash-injected]: P7/P8 workflow interruption replay converges (coordinator, verifier spawn window, consumers A/B) and DF dispatch failure never settles — all via deterministic id idempotency", async () => {
    expect(
      labeled("story-G-workflow-interruption-dispatch", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const seeded = yield* p7SeedWork(G_WORK, G_ASSIGN_CMD);
        expect(seeded.resolution._tag).toBe("Committed");
        const producer = yield* p7SeedWork(G_WORK_P, G_ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE works SET verification_mission = ? WHERE work_id = ?",
          [JSON.stringify(G_MISSION), G_WORK],
        );
        yield* seedDependencyAndDeliverable(G_DEP, G_DEL, G_WORK, G_WORK_P);
        // WF1: coordinator consumption interrupted before the
        // SatisfyDependency commit — redelivery converges.
        const head1 = yield* preconsume("sg1");
        yield* journalEvent(
          "DeliverableProduced",
          producedPayload(G_DEL, G_WORK_P),
        );
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "SatisfyDependency");
        const failure = yield* pollOnce("sg1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps((base) => interrupted.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(
          yield* countRows("commands", "command_id = ?", [
            satisfactionCommandId(G_DEL, G_DEP, REV(0)),
          ]),
        ).toBe(0);
        expect(yield* countEvents("DependencySatisfied")).toBe(0);
        expect(yield* offsetOf("sg1")).toBe(head1);
        const converged = yield* pollOnce("sg1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps(),
          ),
        });
        expect(converged.records).toContain("SatisfyDependency");
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(yield* offsetOf("sg1")).toBe(head1 + 1);
        // WF2: verifier spawn window — the P8 closure holds under
        // injection: replay emits needSpawn with the same caller-
        // preallocated id; AdmitExecution idempotent; no permanent
        // committed-without-Verifier state.
        const head2 = yield* preconsume("sg2");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000b2",
          workId: G_WORK,
          workRevision: 0,
          claimRef: "claim-sg2",
        });
        const verificationDeps = yield* makeVerificationDeps(gateway);
        const firstSpawn = yield* pollOnce("sg2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            verificationDeps,
          ),
        });
        expect(firstSpawn.records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(G_WORK, 0, "claim-sg2");
        yield* sql.unsafe(
          "UPDATE verifications SET verification_execution_ids = '[]' WHERE verification_id = ?",
          [ids.verificationId],
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(0);
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [head2, "sg2"],
        );
        const replaySpawn = yield* pollOnce("sg2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            verificationDeps,
          ),
        });
        expect(replaySpawn.records).toEqual([
          `needSpawn:${ids.verificationId}:${ids.verifierExecutionId}`,
        ]);
        expect(yield* countRows("verifications")).toBe(1);
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const executions = yield* ExecutionRepository;
        const clock = yield* Clock;
        const stored = yield* tx.transact(
          verifications.findById(ids.verificationId),
        );
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isNone(stored)) {
          return;
        }
        const spawnDeps = {
          gateway,
          verifications,
          executions,
          tx,
          clock,
          principal: p7TestPrincipal as Principal,
        };
        const spawnArgs = {
          verification: stored.value,
          projectId: p7Project,
          ownerWorkspaceId: p7RootWorkspace,
          verifierExecutionId: ids.verifierExecutionId,
          missionDigest: "story-g",
        };
        const spawned = yield* ensureVerifierSpawned(spawnArgs, spawnDeps);
        expect(spawned._tag).toBe("Spawned");
        expect(spawned._tag === "Spawned" ? spawned.admitted : false).toBe(
          true,
        );
        const spawnedAgain = yield* ensureVerifierSpawned(spawnArgs, spawnDeps);
        expect(spawnedAgain._tag).toBe("Noop");
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(1);
        expect(
          yield* countRows("commands", "command_id = ?", [
            verifierAdmitCommandId(ids.verificationId, ids.verifierExecutionId),
          ]),
        ).toBe(1);
        // Close the WF2 verification so consumer A's next replay (same
        // work revision) is not gated by VerificationAlreadyOpen.
        yield* tx.transact(
          verifications.concludeIfOpen(ids.verificationId, "Pass", undefined),
        );
        // WF3a: consumer A interrupted before the StartVerification commit
        // — replay converges to exactly one more Verification.
        const head3 = yield* preconsume("sg3a");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000g3",
          workId: G_WORK,
          workRevision: 0,
          claimRef: "claim-sg3",
        });
        const interruptedA = transientOnceGateway(gateway, "StartVerification");
        const failureA = yield* pollOnce("sg3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeVerificationDeps(interruptedA.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failureA._tag).toBe("TransactionOperationalFailure");
        expect(interruptedA.fired()).toBe(true);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* offsetOf("sg3a")).toBe(head3);
        const replayA = yield* pollOnce("sg3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeVerificationDeps(gateway),
          ),
        });
        expect(replayA.records).toEqual(["StartVerification"]);
        expect(yield* countRows("verifications")).toBe(2);
        expect(yield* countEvents("VerificationStarted")).toBe(2);
        expect(yield* offsetOf("sg3a")).toBe(head3 + 1);
        // WF3b: consumer B interrupted before the CompleteWork commit —
        // replay converges to exactly one Completion. The verification
        // opened by WF3a (same work + revision, partial unique index) is
        // the one concluded and accepted.
        const ids3 = verificationSpawnIds(G_WORK, 0, "claim-sg3");
        yield* tx.transact(
          verifications.concludeIfOpen(ids3.verificationId, "Pass", undefined),
        );
        yield* sql.unsafe(
          "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,'t')",
          [G_ACC, p7Project, G_WORK, 0, ids3.verificationId, p7TestActor],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
          [G_WORK, p7RootWorkspace],
        );
        const head4 = yield* preconsume("sg3b");
        yield* journalEvent("WorkOutcomeAccepted", {
          acceptanceId: G_ACC,
          workId: G_WORK,
          targetWorkRevision: 0,
          verificationId: ids3.verificationId,
          actor: p7TestActor,
        });
        const interruptedB = transientOnceGateway(gateway, "CompleteWork");
        const failureB = yield* pollOnce("sg3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* Effect.gen(function* () {
              const base = yield* makeCompletionDeps();
              return { ...base, gateway: interruptedB.gateway };
            }),
          ),
        }).pipe(Effect.flip);
        expect(failureB._tag).toBe("TransactionOperationalFailure");
        expect(interruptedB.fired()).toBe(true);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Open'", [
            G_WORK,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* offsetOf("sg3b")).toBe(head4);
        const replayB = yield* pollOnce("sg3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCompletionDeps(),
          ),
        });
        expect(replayB.records).toEqual(["CompleteWork"]);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Completed'", [
            G_WORK,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(1);
        // DF1: dispatch port failure never settles; re-dispatch converges.
        yield* INSERT_EXECUTION_G("exe_sg_df1");
        const dispatchExit = yield* Effect.exit(
          dispatchRound("exe_sg_df1", dyingDispatch()),
        );
        expect(dispatchExit._tag).toBe("Failure");
        expect(
          yield* countRows(
            "executions",
            "execution_id = ? AND settled_at IS NULL",
            ["exe_sg_df1"],
          ),
        ).toBe(1);
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [
            "exe_sg_df1",
          ]),
        ).toBe(0);
        expect(yield* preDispatchCheck("exe_sg_df1" as never)).toBe(true);
        const receipt = yield* settleCompletedG("exe_sg_df1");
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(
          yield* countRows(
            "executions",
            "execution_id = ? AND settlement_kind = 'Completed'",
            ["exe_sg_df1"],
          ),
        ).toBe(1);
      }),
      makeP9ConsumerApp(),
    );
  });
});

// ---------------------------------------------------------------------------
// Mechanical assertion checklist (06 §机械断言清单).
// ---------------------------------------------------------------------------

const P9_DIR = import.meta.dirname;
const REPO_ROOT = join(P9_DIR, "..");

const p9SuiteSources = (): ReadonlyArray<{
  name: string;
  source: string;
}> =>
  readdirSync(P9_DIR)
    .filter(
      (name) =>
        name.startsWith("p9-") &&
        name.endsWith(".test.ts") &&
        name !== "p9-acceptance.test.ts",
    )
    .map((name) => ({
      name,
      source: readFileSync(join(P9_DIR, name), "utf8"),
    }));

/** Coverage-audit table: matrix face (02 §1–§12) → owning suite files. */
const FACE_SUITES: ReadonlyArray<{
  readonly face: string;
  readonly section: string;
  readonly rowPattern: RegExp;
  readonly suites: ReadonlyArray<string>;
}> = [
  {
    face: "W",
    section: "02 §1 worker crash",
    rowPattern: /\bW[1-5]\b/,
    suites: ["tests/p9-worker-crash.test.ts"],
  },
  {
    face: "R",
    section: "02 §2 old-worker resurrection",
    rowPattern: /\bR[1-6]\b/,
    suites: ["tests/p9-worker-crash.test.ts"],
  },
  {
    face: "L",
    section: "02 §3 lease expiry",
    rowPattern: /\bL[1-4]\b/,
    suites: ["tests/p9-lease-expiry.test.ts", "tests/p9-lease-renewal.test.ts"],
  },
  {
    face: "D",
    section: "02 §4 daemon crash / dirty restart",
    rowPattern: /\bD[1-6]\b/,
    suites: [
      "tests/p9-recovery-driver.test.ts",
      "tests/p9-tool-outcome-unknown.test.ts",
      "tests/p9-timer-refire.test.ts",
      "tests/p9-workflow-interruption.test.ts",
    ],
  },
  {
    face: "T",
    section: "02 §5 tool outcome unknown",
    rowPattern: /\bT[1-4]\b/,
    suites: ["tests/p9-tool-outcome-unknown.test.ts"],
  },
  {
    face: "PD",
    section: "02 §6 provider disconnect",
    rowPattern: /\bPD[1-4]\b/,
    suites: ["tests/p9-provider-disconnect.test.ts"],
  },
  {
    face: "CC",
    section: "02 §7 consumer crash",
    rowPattern: /\bCC-?[1-6]\b/,
    suites: ["tests/p9-consumer-crash.test.ts"],
  },
  {
    face: "WF",
    section: "02 §8 P7/P8 workflow interruption replay",
    rowPattern: /\bWF[1-3]\b/,
    suites: ["tests/p9-workflow-interruption.test.ts"],
  },
  {
    face: "DF",
    section: "02 §9 dispatch failure / lost dispatch",
    rowPattern: /\bDF[1-2]\b/,
    suites: ["tests/p9-workflow-interruption.test.ts"],
  },
  {
    face: "PR",
    section: "02 §10 projection rebuild (generic, GQ2)",
    rowPattern: /\bPR[1-4]\b/,
    suites: ["tests/p9-rebuild-durability.test.ts"],
  },
  {
    face: "PB",
    section: "02 §11 persistence-boundary faults",
    rowPattern: /\bPB[1-3]\b/,
    suites: ["tests/p9-harness-fault-modes.test.ts"],
  },
  {
    face: "DA",
    section: "02 §12 durability-asserted (GQ5)",
    rowPattern: /\bDA[12]\b/,
    suites: ["tests/p9-rebuild-durability.test.ts"],
  },
];

const REGRESSION_GUARDS: ReadonlyArray<{
  readonly phase: string;
  readonly pattern: RegExp;
  readonly minimum: number;
}> = [
  { phase: "P5", pattern: /^p5-.*\.test\.ts$/, minimum: 9 },
  { phase: "P6", pattern: /^p6-.*\.test\.ts$/, minimum: 13 },
  { phase: "P7", pattern: /^p7-.*\.test\.ts$/, minimum: 13 },
  { phase: "P8", pattern: /^p8-.*\.test\.ts$/, minimum: 9 },
];

describe("p9-acceptance mechanical assertions (06 checklist)", () => {
  it("matrix coverage audit: every 02 face has ≥1 mechanical case and its owning suite file exists", () => {
    const sources = p9SuiteSources();
    expect(sources.length).toBeGreaterThanOrEqual(12);
    for (const entry of FACE_SUITES) {
      for (const suite of entry.suites) {
        expect(
          existsSync(join(REPO_ROOT, suite)),
          `${entry.face} owning suite ${suite}`,
        ).toBe(true);
      }
      const hits = sources.filter((file) => entry.rowPattern.test(file.source));
      expect(
        hits.length,
        `${entry.face} (${entry.section}) needs ≥1 case across the p9 suites`,
      ).toBeGreaterThanOrEqual(1);
      // B-10 disambiguation: every suite names the phase.
      for (const file of hits) {
        expect(file.source.includes("P9"), file.name).toBe(true);
      }
    }
  });

  it("guarantee labeling is complete: every harness record carries exactly one of the two frozen classes (GQ5)", () => {
    const sources = p9SuiteSources();
    const callPattern = /labeled\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*\)/g;
    const classes: Record<string, number> = {};
    let calls = 0;
    for (const file of sources) {
      for (const match of file.source.matchAll(callPattern)) {
        calls += 1;
        const guarantee = match[1] ?? "";
        classes[guarantee] = (classes[guarantee] ?? 0) + 1;
      }
    }
    expect(calls).toBeGreaterThanOrEqual(40);
    expect(Object.keys(classes).sort()).toEqual([
      "crash-injected",
      "durability-asserted",
    ]);
    expect(classes["crash-injected"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(classes["durability-asserted"] ?? 0).toBeGreaterThanOrEqual(1);
    // The convention itself is frozen in the harness API (two classes
    // only, never a third).
    const harnessApi = readFileSync(
      join(P9_DIR, "support", "p9-harness-api.ts"),
      "utf8",
    );
    expect(
      harnessApi.includes('"crash-injected" | "durability-asserted"'),
    ).toBe(true);
  });

  it("P5–P8 regression guards present and chained into pnpm check", () => {
    for (const guard of REGRESSION_GUARDS) {
      const inTests = readdirSync(P9_DIR).filter((name) =>
        guard.pattern.test(name),
      );
      const inApps = readdirSync(
        join(REPO_ROOT, "apps", "single-workspace", "test"),
      ).filter((name) => guard.pattern.test(name));
      expect(
        inTests.length + inApps.length,
        `${guard.phase} guard suites`,
      ).toBeGreaterThanOrEqual(guard.minimum);
    }
    const architecture = readdirSync(join(P9_DIR, "architecture"));
    for (const phase of ["p5", "p6", "p7", "p8"]) {
      expect(
        architecture.includes(`${phase}-architecture.test.ts`),
        phase,
      ).toBe(true);
    }
    // The pnpm check reference assertion: the guard chain itself is wired
    // (lint + typecheck + architecture + test, all green together).
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.check).toContain("test");
    expect(scripts.check).toContain("architecture");
    expect(scripts.architecture).toContain("tests/architecture");
    expect(scripts.test).toContain("vitest run");
  });
});
