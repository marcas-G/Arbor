import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P7_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../apps/single-workspace/src/runnable-source-p7.js";
import {
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  makeDeclareDependencyHandler,
} from "../packages/application/src/commands/declare-dependency.js";
import {
  type DeliverDependencies,
  submitDeliver,
} from "../packages/application/src/commands/deliver-command.js";
import {
  type MarkDependencyUnfulfillablePayload,
  type MarkDependencyUnfulfillableResult,
  makeMarkDependencyUnfulfillableHandler,
  makeReviseDependencyContractHandler,
  makeWithdrawDependencyHandler,
  type ReviseDependencyContractPayload,
  type ReviseDependencyContractResult,
  type WithdrawDependencyPayload,
  type WithdrawDependencyResult,
} from "../packages/application/src/commands/dependency-transitions.js";
import {
  makeProduceDeliverableHandler,
  type ProduceDeliverablePayload,
  type ProduceDeliverableResult,
} from "../packages/application/src/commands/produce-deliverable.js";
import {
  makeSatisfyDependencyHandler,
  type SatisfyDependencyPayload,
  type SatisfyDependencyResult,
  satisfactionCommandId,
} from "../packages/application/src/commands/satisfy-dependency.js";
import { makeSendMessageHandler } from "../packages/application/src/commands/send-message.js";
import { runDependencyCoordinator } from "../packages/application/src/dependency-coordinator.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  deliverWakeSignal,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
  sendMessagePlan,
  type VerifiedCommandAuthority,
  type WakeSinkDependencies,
} from "../packages/application/src/index.js";
import {
  buildWaitGraph,
  type ClassifyOutputForGate,
  detectDeadlock,
  evaluateDeadlock,
  hasDeadlock,
  type WaitGraphWait,
  type WaitGraphWork,
} from "../packages/application/src/wait-graph.js";
import {
  ArtifactId,
  type ArtifactRole,
  CommandId,
  DeliverableId,
  type DeliverableKind,
  type Dependency,
  DependencyId,
  type DependencyLifecycle,
  DependencyRevision,
  declareDependency,
  ExecutionId,
  type ExpectedDeliverable,
  MessageId,
  markUnfulfillableOnProducerLoss,
  type ProducerBinding,
  type ProducerLossFacts,
  parse,
  Revision,
  type WakeCondition,
  WorkId,
  type WorkLifecycle,
  WorkRevision,
  WorkspaceId,
  workBound,
  workspaceBound,
} from "../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../packages/execution-runtime/src/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  ExecutionRepository,
  ExecutionScheduler,
  FormationProposalStore,
  type IdGenerator,
  InboxProjectionStore,
  MessageStore,
  type PendingDomainEvent,
  ProjectRepository,
  RunnableWorkSource,
  type SchedulerDecision,
  SessionRepository,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  makeP7CommandHandlers,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "./support/p7-app.js";

// --- ids (uuid-v7 shaped, one namespace per story) ---

const wrk = (tail: string) =>
  parse(WorkId)(`wrk_00000000-0000-7000-8000-000000${tail}`);
const ws = (tail: string) =>
  parse(WorkspaceId)(`ws_00000000-0000-7000-8000-000000${tail}`);
const dep = (tail: string) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-000000${tail}`);
const del = (tail: string) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-000000${tail}`);
const art = (tail: string) =>
  parse(ArtifactId)(`art_00000000-0000-7000-8000-000000${tail}`);
const msg = (tail: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-${tail}`);
const cmd = (tail: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${tail}`);
const exe = (tail: string) =>
  parse(ExecutionId)(`exe_00000000-0000-7000-8000-000000${tail}`);
const REV = (n: number) => parse(DependencyRevision)(n);

const WORK_A_CHILD = wrk("00a001");
const WORK_A_PARENT = wrk("00a002");
const WORK_A_SIBLING = wrk("00a003");
const DEP_A1 = dep("00a011");
const DEP_A2 = dep("00a012");

const WORK_B_CONSUMER = wrk("00b001");
const WORK_B_PRODUCER = wrk("00b002");
const DEP_B1 = dep("00b011");
const DEP_B2 = dep("00b012");
const DEL_B1 = del("00b021");
const DEL_B2 = del("00b022");
const ART_B = art("00b031");
const EXE_B = exe("00b041");

const CHILD_C = ws("00c001");
const CHILD_C_SESSION = "ses_00000000-0000-7000-8000-00000000c001";
const WORK_C_CHILD = wrk("00c002");
const WORK_C_ROOT = wrk("00c003");
const DEP_C = dep("00c011");
const DEL_C = del("00c021");
const MSG_C_DELIVER = msg("89c0000000c4");
const CMD_C_DELIVER = cmd("89c0000000c3");
const MSG_C_REJECT = msg("89c0000000c6");
const CMD_C_REJECT = cmd("89c0000000c5");
const MSG_C_REPORT = msg("89c0000000c8");
const CMD_C_REPORT = cmd("89c0000000c7");

const WORK_D_CONSUMER = wrk("00d001");
const WORK_D_PRODUCER = wrk("00d002");
const WORK_D_AGENT = wrk("00d003");
const DEP_D_SATISFIED = dep("00d011");
const DEP_D_REVISED = dep("00d012");
const DEP_D_WITHDRAWN = dep("00d013");
const DEP_D_MARKED = dep("00d014");
const DEP_D_LOSS_WB = dep("00d015");
const DEP_D_LOSS_WS = dep("00d016");
const DEP_D_LOSS_ANY = dep("00d017");
const DEP_D_AGENT = dep("00d018");
const DEL_D_SAT = del("00d021");
const DEL_D_AGENT = del("00d022");
const ART_D = art("00d031");
const EXE_D = exe("00d041");

const WORK_E1 = wrk("00e001");
const WORK_E2 = wrk("00e002");
const DEP_E1 = dep("00e011");
const DEP_E2 = dep("00e012");
const NOW_E = "2026-09-21T00:00:00.000Z";

const WORK_F_WAIT = wrk("00f001");
const WORK_F_BLOCKED = wrk("00f002");
const WORK_F_DEP_ONLY = wrk("00f003");
const WORK_F_CLEAN = wrk("00f004");
const DEP_F_BLOCKED = dep("00f011");
const DEP_F_UNREFERENCED = dep("00f012");
const WS_F_OTHER = ws("00f005");

// --- mini gateway composition: P1 + P2 + the nine P7-phase commands ---

const P7_PHASE_COMMAND_TYPES: ReadonlyArray<string> = [
  "RecordDecision",
  "SendMessage",
  "SteerWork",
  "DeclareDependency",
  "ProduceDeliverable",
  "SatisfyDependency",
  "WithdrawDependency",
  "MarkDependencyUnfulfillable",
  "ReviseDependencyContract",
];

type StoryServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | DomainEventJournal
  | IdGenerator
  | WorkWaitStore
  | RunnableWorkSource
  | ExecutionScheduler
  | InboxProjectionStore
  | MessageStore
  | DependencyRepository
  | DeliverableRepository
  | WorkRepository
  | WorkspaceRepository
  | CommandHandlerRegistry;

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReasonTag: string;
}

const makeSchedulerStub = () => {
  const calls: SchedulerCall[] = [];
  const layer = Layer.succeed(
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
  return { calls, layer };
};

type RegistryDeps =
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
  | DependencyRepository
  | DeliverableRepository;

const StoryRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  RegistryDeps
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const workWaits = yield* WorkWaitStore;
    const proposals = yield* FormationProposalStore;
    const inbox = yield* InboxProjectionStore;
    const messages = yield* MessageStore;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
      }),
      ...makeP7CommandHandlers({
        proposals,
        inbox,
        messages,
        workspaces,
        works,
      }),
      makeDeclareDependencyHandler({
        works,
        workspaces,
        dependencies,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeProduceDeliverableHandler({
        works,
        deliverables,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeSatisfyDependencyHandler({
        dependencies,
        deliverables,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeWithdrawDependencyHandler({
        dependencies,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeMarkDependencyUnfulfillableHandler({
        dependencies,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeReviseDependencyContractHandler({
        dependencies,
        works,
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

const makeStoryApp = () => {
  const scheduler = makeSchedulerStub();
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
  );
  const transaction = Layer.provide(TransactionPortLive, infra);
  const registry = Layer.provide(
    StoryRegistryLive,
    Layer.mergeAll(repositories, transaction),
  );
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    journal,
    repositories,
    transaction,
    Layer.provide(CommandStoreLive, infra),
    FenceStopCheckInertLive,
  );
  const runnableSource = Layer.provide(
    DependencyAwareRunnableWorkSourceLive,
    Layer.mergeAll(repositories, transaction),
  );
  const app = Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
    journal,
    registry,
    runnableSource,
    scheduler.layer,
  ) as unknown as Layer.Layer<StoryServices>;
  return { app, calls: scheduler.calls };
};

const runStory = <A>(
  app: Layer.Layer<StoryServices>,
  program: Effect.Effect<A, unknown, StoryServices>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(program, app)));

// --- shared helpers ---

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

const envelopeOf = <P>(
  commandType: string,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const fingerprintOf = <P>(commandType: string, payload: P) =>
  semanticRequestFingerprint({
    commandType,
    projectId: p7Project,
    actor: p7TestActor,
    schemaVersion: "1",
    payload,
  });

const externalContext = {
  _tag: "External",
  principal: p7TestPrincipal,
} as const;

const submitDeclare = (
  commandId: CommandId,
  payload: DeclareDependencyPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      DeclareDependencyPayload,
      DeclareDependencyResult
    >(envelopeOf("DeclareDependency", commandId, payload), externalContext, {
      _tag: "DeclareDependencyAuthority",
      principal: p7TestPrincipal,
      commandId,
      semanticRequestFingerprint: fingerprintOf("DeclareDependency", payload),
      projectId: p7Project,
      targetWorkspaceId: p7RootWorkspace,
      consumerWorkId: payload.consumerWorkId,
    });
  });

const submitProduce = (
  commandId: CommandId,
  payload: ProduceDeliverablePayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      ProduceDeliverablePayload,
      ProduceDeliverableResult
    >(envelopeOf("ProduceDeliverable", commandId, payload), externalContext, {
      _tag: "ProduceDeliverableAuthority",
      principal: p7TestPrincipal,
      commandId,
      semanticRequestFingerprint: fingerprintOf("ProduceDeliverable", payload),
      projectId: p7Project,
      sourceWorkspaceId: p7RootWorkspace,
      sourceWorkId: payload.sourceWorkId,
    });
  });

const submitSatisfy = (
  commandId: CommandId,
  payload: SatisfyDependencyPayload,
  source:
    | {
        readonly _tag: "ConsumerExecution";
        readonly workspaceId: WorkspaceId;
        readonly executionId: ExecutionId;
      }
    | { readonly _tag: "P7Coordinator" },
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      SatisfyDependencyPayload,
      SatisfyDependencyResult
    >(envelopeOf("SatisfyDependency", commandId, payload), externalContext, {
      _tag: "SatisfyDependencyAuthority",
      source,
      principal: p7TestPrincipal,
      commandId,
      semanticRequestFingerprint: fingerprintOf("SatisfyDependency", payload),
      projectId: p7Project,
      targetWorkspaceId: p7RootWorkspace,
      dependencyId: payload.dependencyId,
      deliverableId: payload.deliverableId,
    });
  });

const submitWithdraw = (
  commandId: CommandId,
  payload: WithdrawDependencyPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      WithdrawDependencyPayload,
      WithdrawDependencyResult
    >(envelopeOf("WithdrawDependency", commandId, payload), externalContext, {
      _tag: "WithdrawDependencyAuthority",
      principal: p7TestPrincipal,
      commandId,
      semanticRequestFingerprint: fingerprintOf("WithdrawDependency", payload),
      projectId: p7Project,
      targetWorkspaceId: p7RootWorkspace,
      dependencyId: payload.dependencyId,
    });
  });

const submitMark = (
  commandId: CommandId,
  payload: MarkDependencyUnfulfillablePayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      MarkDependencyUnfulfillablePayload,
      MarkDependencyUnfulfillableResult
    >(
      envelopeOf("MarkDependencyUnfulfillable", commandId, payload),
      externalContext,
      {
        _tag: "MarkDependencyUnfulfillableAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "MarkDependencyUnfulfillable",
          payload,
        ),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        dependencyId: payload.dependencyId,
      },
    );
  });

const submitRevise = (
  commandId: CommandId,
  payload: ReviseDependencyContractPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<
      ReviseDependencyContractPayload,
      ReviseDependencyContractResult
    >(
      envelopeOf("ReviseDependencyContract", commandId, payload),
      externalContext,
      {
        _tag: "ReviseDependencyContractAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "ReviseDependencyContract",
          payload,
        ),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        dependencyId: payload.dependencyId,
      },
    );
  });

const seedWorks = (
  entries: ReadonlyArray<readonly [WorkId, CommandId]>,
): Effect.Effect<void, unknown, CommandGateway> =>
  Effect.forEach(entries, ([workId, commandId]) =>
    Effect.gen(function* () {
      const receipt = yield* p7SeedWork(workId, commandId);
      expect(receipt.resolution._tag).toBe("Committed");
    }),
  );

/** p7-deliver-primitive seedWorkOn pattern: AssignWork against an arbitrary
 * workspace (p7SeedWork always targets the root workspace). */
const seedWorkOn = (
  workspaceId: WorkspaceId,
  workId: WorkId,
  commandId: CommandId,
): Effect.Effect<void, unknown, CommandGateway> =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const payload = {
      workId,
      workspaceId,
      expectedWorkspaceRevision: parse(Revision)(0),
      objective: "p7-acceptance",
      why: "seed",
      constraints: [],
      completionExpectation: "green",
      verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
      provenance: { predecessorWorkId: null, reason: "seed" },
      revision: parse(WorkRevision)(0),
    };
    const receipt = yield* gateway.execute(
      {
        commandType: "AssignWork",
        commandId,
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        payload,
      },
      externalContext,
      {
        _tag: "AssignWorkAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf("AssignWork", payload),
        projectId: p7Project,
        targetWorkspaceId: workspaceId,
      },
    );
    expect(receipt.resolution._tag).toBe("Committed");
  });

const insertWait = (
  workId: WorkId,
  conditions: ReadonlyArray<unknown>,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
      [workId, "Any", JSON.stringify(conditions), "t", "t"],
    );
  });

const depChanged = (dependencyId: DependencyId): WakeCondition => ({
  _tag: "DependencyChanged",
  dependencyId,
  observedRevision: parse(Revision)(0),
});

const timeReached: WakeCondition = {
  _tag: "TimeReached",
  instant: "2099-01-01T00:00:00.000Z",
};

const setCurrentWork = (
  workId: WorkId | null,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

const countDependencyEvents = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ readonly n: number }>(
    "SELECT COUNT(*) AS n FROM domain_events WHERE event_type LIKE 'Dependency%'",
  );
  return Number(rows[0]?.n ?? 0);
});

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? 0);
  });

const eventPayloads = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE event_type = ? ORDER BY sequence",
      [eventType],
    );
    return rows.map(
      (row) => JSON.parse(row.payload_json) as Record<string, unknown>,
    );
  });

const receiptResolution = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly resolution: string }>(
      "SELECT resolution FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1 ? rows[0]!.resolution : null;
  });

const storedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
  });

const seedDependency = (
  dependencyId: DependencyId,
  consumerWorkId: WorkId,
  producerBinding: ProducerBinding,
  expected: ExpectedDeliverable,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId,
          consumerWorkId,
          producerBinding,
          revision: REV(0),
          expectedDeliverable: expected,
        }),
        p7Project,
      ),
    );
  });

const seedDeliverable = (
  deliverableId: DeliverableId,
  sourceWorkId: WorkId,
  roles: ReadonlyArray<string>,
  artifactId: ArtifactId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId,
          sourceWorkId,
          sourceWorkRevision: 0,
          kind: "report",
        },
        roles.map((role) => ({ role, artifactId })),
        p7Project,
      ),
    );
  });

const journalEvents = Effect.gen(function* () {
  const journal = yield* DomainEventJournal;
  const tx = yield* TransactionPort;
  const last = yield* tx.transact(journal.lastSequence(p7Project));
  const events = yield* tx.transact(journal.readAfter(p7Project, 0, last + 1));
  return events.map((event) => ({
    eventType: event.eventType,
    payload: event.payload,
    eventId: event.eventId,
  }));
});

const producedEvents = Effect.map(journalEvents, (events) =>
  events.filter((event) => event.eventType === "DeliverableProduced"),
);

const classifyRoot: Effect.Effect<
  { current: Option.Option<WorkId>; runnable: ReadonlyArray<WorkId> },
  unknown,
  RunnableWorkSource
> = Effect.gen(function* () {
  const source = yield* RunnableWorkSource;
  return yield* source.classify(p7RootWorkspace);
});

const decideFromTable = (
  current: Option.Option<WorkId>,
  runnable: ReadonlyArray<WorkId>,
): SchedulerDecision =>
  Option.isSome(current)
    ? { _tag: "Admit", focus: { _tag: "Work", workId: current.value } }
    : runnable.length === 0
      ? { _tag: "Idle" }
      : runnable.length === 1
        ? { _tag: "SelectCurrentWork", workId: runnable[0] as WorkId }
        : { _tag: "Admit", focus: { _tag: "Coordination" } };

const makeCoordinatorDeps = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const tx = yield* TransactionPort;
  const sql = yield* SqlClient;
  const dependencies = yield* DependencyRepository;
  const deliverables = yield* DeliverableRepository;
  const works = yield* WorkRepository;
  return {
    gateway,
    dependencies: {
      listUnsatisfiedByProject: (projectId: typeof p7Project) =>
        tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
    },
    deliverables: {
      findById: (deliverableId: DeliverableId) =>
        tx.transact(deliverables.findById(deliverableId)),
      listArtifactRoles: (deliverableId: DeliverableId) =>
        tx.transact(deliverables.listArtifactRoles(deliverableId)),
      deliverablesByProject: (projectId: typeof p7Project) =>
        tx.transact(
          Effect.gen(function* () {
            yield* TransactionScope;
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

const runCoordinatorOverProducedEvents = Effect.gen(function* () {
  const events = yield* producedEvents;
  const deps = yield* makeCoordinatorDeps;
  return yield* runDependencyCoordinator(
    events,
    deps,
    p7Project,
    p7TestPrincipal,
  );
});

const makeSinkDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies WakeSinkDependencies;
});

const makeDeliverDeps = Effect.gen(function* () {
  const workspaces = yield* WorkspaceRepository;
  const works = yield* WorkRepository;
  const deliverables = yield* DeliverableRepository;
  const messages = yield* MessageStore;
  const inbox = yield* InboxProjectionStore;
  const journal = yield* DomainEventJournal;
  const deps: DeliverDependencies = {
    deliverables,
    works,
    workspaces,
    sendMessage: makeSendMessageHandler({ workspaces, messages, inbox }),
    inbox,
    journal,
    clock: { now: () => Effect.succeed("t") },
  };
  return deps;
});

const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

const submitReport = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const plan = sendMessagePlan({
    messageId: MSG_C_REPORT,
    commandId: CMD_C_REPORT,
    projectId: p7Project,
    senderWorkspaceId: CHILD_C,
    principal: p7TestPrincipal,
    actor: p7TestActor,
    message: {
      kind: "Report",
      recipientWorkspaceId: p7RootWorkspace,
      bodyRef: "art-p7-acceptance-report-body",
      urgency: "Normal",
    },
  });
  return yield* gateway.execute(
    {
      commandType: "SendMessage",
      commandId: CMD_C_REPORT,
      projectId: p7Project,
      actor: p7TestActor,
      issuedAt: "t",
      payload: plan.payload,
    },
    externalContext,
    plan.authority,
  );
});

// --- Story E fixtures (assertions stand alone in this file) ---

const WS_EA = ws("00e101");
const WS_EB = ws("00e102");
const WS_EC = ws("00e103");
const WE1 = wrk("00e111");
const WE2 = wrk("00e112");
const WE3 = wrk("00e113");
const WE9 = wrk("00e119");
const ED1 = dep("00e121");
const ED2 = dep("00e122");

const pureDep = (
  dependencyId: DependencyId,
  consumerWorkId: WorkId,
  producerBinding: ProducerBinding,
  state: DependencyLifecycle = "Unsatisfied",
): Dependency => ({
  dependencyId,
  consumerWorkId,
  producerBinding,
  revision: REV(0),
  expectedDeliverable: expectedOf("report", ["summary"]),
  state,
  satisfiedByDeliverableId: null,
  satisfiedAtDependencyRevision: null,
});

const pureWork = (
  workId: WorkId,
  workspaceId: WorkspaceId,
  lifecycle: WorkLifecycle = "Open",
): WaitGraphWork => ({ workId, workspaceId, lifecycle });

const waitOn = (
  workId: WorkId,
  ...dependencyIds: DependencyId[]
): WaitGraphWait => ({
  workId,
  conditions: dependencyIds.map(depChanged),
  active: true,
});

const idle = (workspaceId: WorkspaceId): ClassifyOutputForGate => ({
  workspaceId,
  current: Option.none(),
  runnable: [],
});

const allIdle = (...workspaces: WorkspaceId[]) =>
  workspaces.map((workspaceId) => idle(workspaceId));

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const evaluateOverDb = (now: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const works = yield* WorkRepository;
    const dependencies = yield* DependencyRepository;
    const waits = yield* WorkWaitStore;
    const source = yield* RunnableWorkSource;
    return yield* evaluateDeadlock(
      {
        projectId: p7Project,
        listWorkspaceIds: () =>
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{
              readonly workspace_id: WorkspaceId;
            }>(
              "SELECT workspace_id FROM workspaces WHERE project_id = ? ORDER BY workspace_id",
              [p7Project],
            );
            return rows.map((row) => row.workspace_id);
          }).pipe(
            Effect.mapError((cause) => ({
              _tag: "WaitGraphReadFailure" as const,
              cause,
            })),
          ),
        works,
        dependencies,
        waits,
        classify: source.classify,
      },
      now,
    );
  });

const snapshotCanonical = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const works = yield* sql.unsafe("SELECT * FROM works ORDER BY work_id");
  const dependencies = yield* sql.unsafe(
    "SELECT * FROM dependencies ORDER BY dependency_id",
  );
  const workWaits = yield* sql.unsafe(
    "SELECT * FROM work_waits ORDER BY work_id",
  );
  return { works, dependencies, workWaits };
});

const appendToJournal = (events: ReadonlyArray<PendingDomainEvent>) =>
  Effect.gen(function* () {
    const journal = yield* DomainEventJournal;
    const tx = yield* TransactionPort;
    yield* tx.transact(journal.append(events));
  });

// --- stories ---

describe("p7-acceptance", () => {
  it("Story A (07 §1): declare → Yield blocks; no runnable → quiescence with zero provider turns; an un-yielded dependency never blocks", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        const registry = yield* CommandHandlerRegistry;
        for (const commandType of P7_PHASE_COMMAND_TYPES) {
          expect(Option.isSome(registry.lookup(commandType)), commandType).toBe(
            true,
          );
        }

        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        yield* seedWorks([
          [WORK_A_CHILD, cmd("89a0000000a1")],
          [WORK_A_PARENT, cmd("89a0000000a2")],
        ]);

        const declared = yield* submitDeclare(cmd("89a0000000a3"), {
          dependencyId: DEP_A1,
          consumerWorkId: WORK_A_CHILD,
          producerBinding: workBound(WORK_A_PARENT),
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declared.resolution._tag).toBe("Committed");
        if (declared.resolution._tag === "Committed") {
          expect(declared.resolution.result.state).toBe("Unsatisfied");
          expect(declared.resolution.result.revision).toBe(0);
        }
        expect(yield* countEvents("DependencyDeclared")).toBe(1);
        const declaredPayloads = yield* eventPayloads("DependencyDeclared");
        expect(declaredPayloads[0]).toEqual({
          dependencyId: DEP_A1,
          consumerWorkId: WORK_A_CHILD,
          producerBinding: { _tag: "WorkBound", workId: WORK_A_PARENT },
          expectedDeliverable: {
            kind: "report",
            requiredArtifactRoles: ["summary"],
          },
          revision: 0,
        });
        const stored = yield* storedDependency(DEP_A1);
        expect(stored?.state).toBe("Unsatisfied");
        expect(stored?.revision).toBe(0);

        const beforeYield = yield* classifyRoot;
        expect([...beforeYield.runnable]).toEqual([
          WORK_A_CHILD,
          WORK_A_PARENT,
        ]);

        yield* insertWait(WORK_A_CHILD, [depChanged(DEP_A1)]);
        yield* setCurrentWork(WORK_A_CHILD);
        yield* insertWait(WORK_A_PARENT, [timeReached]);

        const blocked = yield* classifyRoot;
        expect(blocked.current).toEqual(Option.none());
        expect([...blocked.runnable]).toEqual([]);
        expect(decideFromTable(blocked.current, blocked.runnable)).toEqual({
          _tag: "Idle",
        });
        expect(yield* countRows("provider_turns")).toBe(0);

        yield* seedWorks([[WORK_A_SIBLING, cmd("89a0000000a4")]]);
        const unyielded = yield* submitDeclare(cmd("89a0000000a5"), {
          dependencyId: DEP_A2,
          consumerWorkId: WORK_A_SIBLING,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(unyielded.resolution._tag).toBe("Committed");
        const afterSecond = yield* classifyRoot;
        expect(afterSecond.current).toEqual(Option.none());
        expect([...afterSecond.runnable]).toEqual([WORK_A_SIBLING]);
      }),
    );
  });

  it("Story B (07 §2): produce → coordinator auto-satisfy → wake clears the wait and returns the consumer to runnable; replay idempotent; matcher negative; concurrent first-win", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        yield* seedWorks([
          [WORK_B_CONSUMER, cmd("89b0000000b1")],
          [WORK_B_PRODUCER, cmd("89b0000000b2")],
        ]);

        const declaredFirst = yield* submitDeclare(cmd("89b0000000b3"), {
          dependencyId: DEP_B1,
          consumerWorkId: WORK_B_CONSUMER,
          producerBinding: workBound(WORK_B_PRODUCER),
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredFirst.resolution._tag).toBe("Committed");
        const declaredSecond = yield* submitDeclare(cmd("89b0000000b4"), {
          dependencyId: DEP_B2,
          consumerWorkId: WORK_B_CONSUMER,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("diagram", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredSecond.resolution._tag).toBe("Committed");

        yield* insertWait(WORK_B_CONSUMER, [depChanged(DEP_B1)]);
        const blocked = yield* classifyRoot;
        expect(blocked.runnable).not.toContain(WORK_B_CONSUMER);

        const revised = yield* submitRevise(cmd("89b0000000b5"), {
          dependencyId: DEP_B1,
          targetDependencyRevision: REV(0),
          newExpectedDeliverable: expectedOf("report", ["summary"]),
        });
        expect(revised.resolution._tag).toBe("Committed");
        if (revised.resolution._tag === "Committed") {
          expect(revised.resolution.result.fromRevision).toBe(0);
          expect(revised.resolution.result.toRevision).toBe(1);
        }
        expect(yield* countEvents("DependencyContractRevised")).toBe(1);

        const producedFirst = yield* submitProduce(cmd("89b0000000b6"), {
          deliverableId: DEL_B1,
          sourceWorkId: WORK_B_PRODUCER,
          observedSourceWorkRevision: parse(WorkRevision)(0),
          kind: "report" as never as DeliverableKind,
          artifacts: [{ role: "summary" as never, artifactId: ART_B }],
        });
        expect(producedFirst.resolution._tag).toBe("Committed");
        if (producedFirst.resolution._tag === "Committed") {
          expect(producedFirst.resolution.result.sourceWorkRevision).toBe(0);
        }
        const producedSecond = yield* submitProduce(cmd("89b0000000b7"), {
          deliverableId: DEL_B2,
          sourceWorkId: WORK_B_PRODUCER,
          observedSourceWorkRevision: parse(WorkRevision)(0),
          kind: "report" as never as DeliverableKind,
          artifacts: [{ role: "summary" as never, artifactId: ART_B }],
        });
        expect(producedSecond.resolution._tag).toBe("Committed");
        expect(yield* countEvents("DeliverableProduced")).toBe(2);
        const deliverables = yield* DeliverableRepository;
        const tx = yield* TransactionPort;
        const storedDeliverable = yield* tx.transact(
          deliverables.findById(DEL_B1),
        );
        expect(Option.isSome(storedDeliverable)).toBe(true);
        if (Option.isSome(storedDeliverable)) {
          expect(storedDeliverable.value.sourceWorkRevision).toBe(0);
          expect(storedDeliverable.value.sourceWorkId).toBe(WORK_B_PRODUCER);
        }

        const records = yield* runCoordinatorOverProducedEvents;
        expect(records).toContain("SatisfyDependency");
        expect(records).toContain(`skipped:DependencyNotSatisfiable:${DEP_B2}`);

        const satisfied = yield* storedDependency(DEP_B1);
        expect(satisfied?.state).toBe("Satisfied");
        expect(satisfied?.satisfiedByDeliverableId).toBe(DEL_B1);
        expect(satisfied?.revision).toBe(1);
        expect(satisfied?.satisfiedAtDependencyRevision).toBe(1);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* receiptResolution(
            satisfactionCommandId(DEL_B1, DEP_B1, REV(1)),
          ),
        ).toBe("Committed");

        const replay = yield* runCoordinatorOverProducedEvents;
        expect(replay).not.toContain("SatisfyDependency");
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        const mismatched = yield* storedDependency(DEP_B2);
        expect(mismatched?.state).toBe("Unsatisfied");
        expect(mismatched?.satisfiedByDeliverableId).toBeUndefined();

        const loser = yield* submitSatisfy(
          cmd("89b0000000b8"),
          {
            dependencyId: DEP_B1,
            targetDependencyRevision: REV(1),
            deliverableId: DEL_B2,
          },
          {
            _tag: "ConsumerExecution",
            workspaceId: p7RootWorkspace,
            executionId: EXE_B,
          },
        );
        expect(loser.resolution._tag).toBe("TerminalRejected");
        if (loser.resolution._tag === "TerminalRejected") {
          expect(loser.resolution.error._tag).toBe("TerminalLifecycleMutation");
        }
        const afterRace = yield* storedDependency(DEP_B1);
        expect(afterRace?.satisfiedByDeliverableId).toBe(DEL_B1);
        expect(afterRace?.satisfiedAtDependencyRevision).toBe(1);

        const stillWaiting = yield* classifyRoot;
        expect(stillWaiting.runnable).not.toContain(WORK_B_CONSUMER);

        const signal = {
          workspaceId: p7RootWorkspace,
          reason: "DependencySatisfied" as const,
          detail: {
            dependencyId: DEP_B1,
            fromRevision: satisfied?.revision ?? 1,
            toRevision: satisfied?.revision ?? 1,
          },
        };
        const sink = yield* makeSinkDeps;
        const delivery = yield* deliverWakeSignal(signal, sink);
        expect(delivery).toEqual({ woke: true, clearedWaits: 1 });
        expect(calls).toContainEqual({
          workspaceId: p7RootWorkspace,
          wakeReasonTag: "DependencySatisfied",
        });
        const afterWake = yield* classifyRoot;
        expect([...afterWake.runnable]).toEqual([
          WORK_B_CONSUMER,
          WORK_B_PRODUCER,
        ]);
        const redelivered = yield* deliverWakeSignal(signal, sink);
        expect(redelivered).toEqual({ woke: false, clearedWaits: 0 });
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
      }),
    );
  });

  it("Story C (07 §3): Deliver lands one parent Inbox Message entry + MessageSent + ChildDelivered wake, satisfies nothing; wrong sender denied; Report has zero Dependency side-effects", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                CHILD_C,
                p7Project,
                p7RootWorkspace,
                "lineage",
                JSON.stringify({
                  purpose: "p",
                  ownedResponsibilities: [],
                  obligations: [],
                  includes: [],
                  excludes: [],
                  interfaces: [],
                }),
                1,
                JSON.stringify({
                  basisResponsibilityRevision: 1,
                  addresses: [],
                }),
                1,
                JSON.stringify({
                  _tag: "ResponsibilityBound",
                  workspaceId: CHILD_C,
                }),
                CHILD_C_SESSION,
                JSON.stringify({}),
                0,
                0,
                "Active",
                "t",
                "t",
              ],
            );
            yield* sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
              [CHILD_C_SESSION, "WorkspacePrimary", CHILD_C, null, 0, "t"],
            );
          }),
        );
        yield* seedWorkOn(CHILD_C, WORK_C_CHILD, cmd("89c0000000c1"));
        yield* seedWorks([[WORK_C_ROOT, cmd("89c0000000c2")]]);
        yield* seedDeliverable(DEL_C, WORK_C_CHILD, [], art("00c031"));
        yield* seedDependency(
          DEP_C,
          WORK_C_ROOT,
          { _tag: "AnyProducer" },
          expectedOf("report", []),
        );

        const deps = yield* makeDeliverDeps;
        const submission = yield* tx.transact(
          submitDeliver(
            {
              deliverableId: DEL_C,
              bodyRef: "art-p7-acceptance-deliver-body",
              commandId: CMD_C_DELIVER,
              messageId: MSG_C_DELIVER,
              projectId: p7Project,
              actor: p7TestActor,
              principal: p7TestPrincipal,
              senderWorkspaceId: CHILD_C,
            },
            deps,
          ),
        );
        expect(submission._tag).toBe("Delivered");
        if (submission._tag === "Delivered") {
          expect(submission.outcome.recipientWorkspaceId).toBe(p7RootWorkspace);
          expect(submission.outcome.wakeSignal).toEqual({
            workspaceId: p7RootWorkspace,
            reason: { _tag: "ChildDelivered" },
            detail: {
              deliverableId: DEL_C,
              messageId: MSG_C_DELIVER,
            },
          });
          expect(submission.outcome.promotion).toEqual({
            closesCorrelation: null,
            triggersReevaluation: false,
          });
        }

        const entries = yield* inboxOf(p7RootWorkspace);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe("Message");
        expect(entries[0]?.entryKey).toBe(`msg:${MSG_C_DELIVER}`);
        expect(entries[0]?.summary).toBe(`Deliver ${DEL_C} from ${CHILD_C}`);

        const sent = yield* eventPayloads("MessageSent");
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({
          messageId: MSG_C_DELIVER,
          kind: "Deliver",
          sender: CHILD_C,
          recipient: p7RootWorkspace,
          deliverableId: DEL_C,
          correlationId: null,
          causationId: null,
        });
        expect(yield* countRows("messages")).toBe(1);

        const dependencyAfterDeliver = yield* storedDependency(DEP_C);
        expect(dependencyAfterDeliver?.state).toBe("Unsatisfied");
        expect(yield* countDependencyEvents).toBe(0);

        const notOwner = yield* tx.transact(
          submitDeliver(
            {
              deliverableId: DEL_C,
              bodyRef: "art-p7-acceptance-deliver-body",
              commandId: CMD_C_REJECT,
              messageId: MSG_C_REJECT,
              projectId: p7Project,
              actor: p7TestActor,
              principal: p7TestPrincipal,
              senderWorkspaceId: p7RootWorkspace,
            },
            deps,
          ),
        );
        expect(notOwner._tag).toBe("Rejected");
        if (notOwner._tag === "Rejected") {
          expect(notOwner.rejection._tag).toBe("AuthorityDenied");
        }
        expect(yield* eventPayloads("MessageSent")).toHaveLength(1);
        expect(yield* countRows("messages")).toBe(1);

        const report = yield* submitReport;
        expect(report.resolution._tag).toBe("Committed");
        const dependencyAfterReport = yield* storedDependency(DEP_C);
        expect(dependencyAfterReport?.state).toBe("Unsatisfied");
        expect(yield* countDependencyEvents).toBe(0);
      }),
    );
  });

  it("Story D (07 §4): Revise bumps and never reinterprets satisfaction; Withdraw / MarkUnfulfillable carry their events; producer-loss batch wiring; agent Satisfy shares the coordinator command face", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        yield* seedWorks([
          [WORK_D_CONSUMER, cmd("89d000000001")],
          [WORK_D_PRODUCER, cmd("89d000000002")],
          [WORK_D_AGENT, cmd("89d000000003")],
        ]);

        const declaredSat = yield* submitDeclare(cmd("89d000000004"), {
          dependencyId: DEP_D_SATISFIED,
          consumerWorkId: WORK_D_CONSUMER,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredSat.resolution._tag).toBe("Committed");
        const produced = yield* submitProduce(cmd("89d000000005"), {
          deliverableId: DEL_D_SAT,
          sourceWorkId: WORK_D_PRODUCER,
          observedSourceWorkRevision: parse(WorkRevision)(0),
          kind: "report" as never as DeliverableKind,
          artifacts: [{ role: "summary" as never, artifactId: ART_D }],
        });
        expect(produced.resolution._tag).toBe("Committed");
        const coordinated = yield* runCoordinatorOverProducedEvents;
        expect(coordinated).toContain("SatisfyDependency");
        const satisfied = yield* storedDependency(DEP_D_SATISFIED);
        expect(satisfied?.state).toBe("Satisfied");
        expect(satisfied?.satisfiedAtDependencyRevision).toBe(0);

        const revisedAfterSatisfaction = yield* submitRevise(
          cmd("89d000000006"),
          {
            dependencyId: DEP_D_SATISFIED,
            targetDependencyRevision: REV(0),
            newExpectedDeliverable: expectedOf("report-v2", ["summary"]),
          },
        );
        expect(revisedAfterSatisfaction.resolution._tag).toBe(
          "TerminalRejected",
        );
        if (revisedAfterSatisfaction.resolution._tag === "TerminalRejected") {
          expect(revisedAfterSatisfaction.resolution.error._tag).toBe(
            "TerminalLifecycleMutation",
          );
        }
        const unchanged = yield* storedDependency(DEP_D_SATISFIED);
        expect(unchanged?.state).toBe("Satisfied");
        expect(unchanged?.revision).toBe(0);
        expect(unchanged?.satisfiedAtDependencyRevision).toBe(0);
        expect(unchanged?.satisfiedByDeliverableId).toBe(DEL_D_SAT);

        const declaredRevise = yield* submitDeclare(cmd("89d000000007"), {
          dependencyId: DEP_D_REVISED,
          consumerWorkId: WORK_D_CONSUMER,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("chart", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredRevise.resolution._tag).toBe("Committed");
        const revised = yield* submitRevise(cmd("89d000000008"), {
          dependencyId: DEP_D_REVISED,
          targetDependencyRevision: REV(0),
          newExpectedDeliverable: expectedOf("chart-v2", ["summary", "legend"]),
        });
        expect(revised.resolution._tag).toBe("Committed");
        if (revised.resolution._tag === "Committed") {
          expect(revised.resolution.result.toRevision).toBe(1);
        }
        const revisedStored = yield* storedDependency(DEP_D_REVISED);
        expect(revisedStored?.state).toBe("Unsatisfied");
        expect(revisedStored?.revision).toBe(1);
        expect(revisedStored?.expectedDeliverable).toEqual({
          kind: "chart-v2",
          requiredArtifactRoles: ["summary", "legend"],
        });
        expect(yield* countEvents("DependencyContractRevised")).toBe(1);

        const declaredWithdraw = yield* submitDeclare(cmd("89d000000009"), {
          dependencyId: DEP_D_WITHDRAWN,
          consumerWorkId: WORK_D_CONSUMER,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("chart", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredWithdraw.resolution._tag).toBe("Committed");
        const withdrawn = yield* submitWithdraw(cmd("89d00000000a"), {
          dependencyId: DEP_D_WITHDRAWN,
          targetDependencyRevision: REV(0),
          reason: "consumer no longer needs the result",
        });
        expect(withdrawn.resolution._tag).toBe("Committed");
        const withdrawnStored = yield* storedDependency(DEP_D_WITHDRAWN);
        expect(withdrawnStored?.state).toBe("Withdrawn");
        expect(withdrawnStored?.revision).toBe(0);
        const withdrawnPayloads = yield* eventPayloads("DependencyWithdrawn");
        expect(withdrawnPayloads).toHaveLength(1);
        expect(withdrawnPayloads[0]).toEqual({
          dependencyId: DEP_D_WITHDRAWN,
          dependencyRevision: 0,
          reason: "consumer no longer needs the result",
        });

        const declaredMark = yield* submitDeclare(cmd("89d00000000b"), {
          dependencyId: DEP_D_MARKED,
          consumerWorkId: WORK_D_CONSUMER,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("chart", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredMark.resolution._tag).toBe("Committed");
        const marked = yield* submitMark(cmd("89d00000000c"), {
          dependencyId: DEP_D_MARKED,
          targetDependencyRevision: REV(0),
          justification: "adjudicated unfulfillable after producer loss",
        });
        expect(marked.resolution._tag).toBe("Committed");
        const markedStored = yield* storedDependency(DEP_D_MARKED);
        expect(markedStored?.state).toBe("Unfulfillable");
        const markedPayloads = yield* eventPayloads(
          "DependencyMarkedUnfulfillable",
        );
        expect(markedPayloads).toHaveLength(1);
        expect(markedPayloads[0]).toEqual({
          dependencyId: DEP_D_MARKED,
          dependencyRevision: 0,
          justification: "adjudicated unfulfillable after producer loss",
        });

        const lossDeclarations: ReadonlyArray<
          readonly [DependencyId, ProducerBinding, CommandId]
        > = [
          [DEP_D_LOSS_WB, workBound(WORK_D_PRODUCER), cmd("89d00000000d")],
          [DEP_D_LOSS_WS, workspaceBound(p7RootWorkspace), cmd("89d00000000e")],
          [DEP_D_LOSS_ANY, { _tag: "AnyProducer" }, cmd("89d00000000f")],
        ];
        for (const [dependencyId, binding, commandId] of lossDeclarations) {
          const declared = yield* submitDeclare(commandId, {
            dependencyId,
            consumerWorkId: WORK_D_CONSUMER,
            producerBinding: binding,
            expectedDeliverable: expectedOf("losskind", ["summary"]),
            expectedConsumerWorkRevision: parse(WorkRevision)(0),
            revision: REV(0),
          });
          expect(declared.resolution._tag).toBe("Committed");
        }
        const repository = yield* DependencyRepository;
        const journal = yield* DomainEventJournal;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
              [WORK_D_PRODUCER],
            );
            const unsatisfied =
              yield* repository.listUnsatisfiedByProject(p7Project);
            const facts: ReadonlyArray<ProducerLossFacts> = [
              {
                binding: workBound(WORK_D_PRODUCER),
                lost: { _tag: "WorkCancelled", workId: WORK_D_PRODUCER },
                replacedInSameGovernanceChange: false,
              },
            ];
            const next = markUnfulfillableOnProducerLoss(facts, unsatisfied);
            const events: PendingDomainEvent[] = [];
            for (let index = 0; index < unsatisfied.length; index += 1) {
              const before = unsatisfied[index]!;
              const after = next[index]!;
              if (before.state === after.state) {
                continue;
              }
              yield* repository.transitionIfUnsatisfiedRevision(
                before.dependencyId,
                before.revision,
                after,
              );
              events.push({
                projectId: p7Project,
                eventType: "DependencyMarkedUnfulfillable",
                eventVersion: 1,
                occurredAt: "t",
                aggregateRef: before.dependencyId,
                actor: p7TestActor,
                payload: {
                  dependencyId: before.dependencyId,
                  dependencyRevision: after.revision,
                  justification: `producer lost: work ${WORK_D_PRODUCER} cancelled`,
                },
              });
            }
            yield* journal.append(events);
          }),
        );
        const lossWorkBound = yield* storedDependency(DEP_D_LOSS_WB);
        expect(lossWorkBound?.state).toBe("Unfulfillable");
        const lossWorkspaceBound = yield* storedDependency(DEP_D_LOSS_WS);
        expect(lossWorkspaceBound?.state).toBe("Unsatisfied");
        const lossAnyProducer = yield* storedDependency(DEP_D_LOSS_ANY);
        expect(lossAnyProducer?.state).toBe("Unsatisfied");
        const batchPayloads = yield* eventPayloads(
          "DependencyMarkedUnfulfillable",
        );
        expect(batchPayloads).toHaveLength(2);
        expect(batchPayloads[1]?.dependencyId).toBe(DEP_D_LOSS_WB);

        const declaredAgent = yield* submitDeclare(cmd("89d000000010"), {
          dependencyId: DEP_D_AGENT,
          consumerWorkId: WORK_D_AGENT,
          producerBinding: { _tag: "AnyProducer" },
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredAgent.resolution._tag).toBe("Committed");
        const producedAgent = yield* submitProduce(cmd("89d000000011"), {
          deliverableId: DEL_D_AGENT,
          sourceWorkId: WORK_D_AGENT,
          observedSourceWorkRevision: parse(WorkRevision)(0),
          kind: "report" as never as DeliverableKind,
          artifacts: [{ role: "summary" as never, artifactId: ART_D }],
        });
        expect(producedAgent.resolution._tag).toBe("Committed");
        const beforeAgentSatisfy = yield* countEvents("DependencySatisfied");
        const agentSatisfy = yield* submitSatisfy(
          cmd("89d000000012"),
          {
            dependencyId: DEP_D_AGENT,
            targetDependencyRevision: REV(0),
            deliverableId: DEL_D_AGENT,
          },
          {
            _tag: "ConsumerExecution",
            workspaceId: p7RootWorkspace,
            executionId: EXE_D,
          },
        );
        expect(agentSatisfy.resolution._tag).toBe("Committed");
        if (agentSatisfy.resolution._tag === "Committed") {
          expect(agentSatisfy.resolution.result.state).toBe("Satisfied");
          expect(agentSatisfy.resolution.result.wakeSignals).toHaveLength(1);
          expect(agentSatisfy.resolution.result.wakeSignals[0]?.reason).toEqual(
            { _tag: "DependencySatisfied" },
          );
        }
        expect(yield* countEvents("DependencySatisfied")).toBe(
          beforeAgentSatisfy + 1,
        );
        const agentSatisfied = yield* storedDependency(DEP_D_AGENT);
        expect(agentSatisfied?.state).toBe("Satisfied");
        expect(agentSatisfied?.satisfiedByDeliverableId).toBe(DEL_D_AGENT);

        const wrongAuthority = yield* Effect.gen(function* () {
          const gateway = yield* CommandGateway;
          const payload: SatisfyDependencyPayload = {
            dependencyId: DEP_D_AGENT,
            targetDependencyRevision: REV(0),
            deliverableId: DEL_D_AGENT,
          };
          const commandId = cmd("89d000000013");
          return yield* gateway.execute<
            SatisfyDependencyPayload,
            SatisfyDependencyResult
          >(
            envelopeOf("SatisfyDependency", commandId, payload),
            externalContext,
            {
              _tag: "SteerWorkAuthority",
              principal: p7TestPrincipal,
              commandId,
              semanticRequestFingerprint: fingerprintOf(
                "SatisfyDependency",
                payload,
              ),
              projectId: p7Project,
              targetWorkspaceId: p7RootWorkspace,
              workId: WORK_D_AGENT,
            } as unknown as VerifiedCommandAuthority,
          );
        });
        expect(wrongAuthority.resolution._tag).toBe("TerminalRejected");
        if (wrongAuthority.resolution._tag === "TerminalRejected") {
          expect(wrongAuthority.resolution.error._tag).toBe("AuthorityDenied");
        }
      }),
    );
  });

  it("Story E (07 §5.1–§5.3): the second WorkWait completes the mutual cycle, DeadlockAttentionRequested carries cycle members and dependencies with zero canonical mutation, Withdraw ends determination", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        yield* seedWorks([
          [WORK_E1, cmd("89e0000000e1")],
          [WORK_E2, cmd("89e0000000e2")],
        ]);
        const declaredFirst = yield* submitDeclare(cmd("89e0000000e3"), {
          dependencyId: DEP_E1,
          consumerWorkId: WORK_E1,
          producerBinding: workBound(WORK_E2),
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredFirst.resolution._tag).toBe("Committed");
        const declaredSecond = yield* submitDeclare(cmd("89e0000000e4"), {
          dependencyId: DEP_E2,
          consumerWorkId: WORK_E2,
          producerBinding: workBound(WORK_E1),
          expectedDeliverable: expectedOf("report", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declaredSecond.resolution._tag).toBe("Committed");

        yield* insertWait(WORK_E1, [depChanged(DEP_E1)]);
        const firstCheck = yield* evaluateOverDb(NOW_E);
        expect(Option.isNone(firstCheck)).toBe(true);

        yield* insertWait(WORK_E2, [depChanged(DEP_E2)]);
        const before = yield* snapshotCanonical;
        const detected = yield* evaluateOverDb(NOW_E);
        expect(Option.isSome(detected)).toBe(true);
        if (Option.isSome(detected)) {
          const { fact, event } = detected.value;
          expect([...fact.cycleWorkIds]).toEqual([WORK_E1, WORK_E2]);
          expect([...fact.dependencyIds]).toEqual([DEP_E1, DEP_E2]);
          expect(event.eventType).toBe("DeadlockAttentionRequested");
          expect(event.aggregateRef).toBe(`deadlock:${WORK_E1}+${WORK_E2}`);
          expect(event.payload).toEqual({
            _tag: "DeadlockAttentionRequested",
            cycleWorkIds: [WORK_E1, WORK_E2],
            dependencyIds: [DEP_E1, DEP_E2],
            detectedAt: NOW_E,
          });
          yield* appendToJournal([event]);
        }
        const afterDetect = yield* snapshotCanonical;
        expect(afterDetect).toEqual(before);
        expect(yield* countEvents("DeadlockAttentionRequested")).toBe(1);

        const withdrawn = yield* submitWithdraw(cmd("89e0000000e5"), {
          dependencyId: DEP_E1,
          targetDependencyRevision: REV(0),
          reason: "resolve the mutual wait",
        });
        expect(withdrawn.resolution._tag).toBe("Committed");
        const rechecked = yield* evaluateOverDb(NOW_E);
        expect(Option.isNone(rechecked)).toBe(true);
        expect(yield* countEvents("DeadlockAttentionRequested")).toBe(1);
      }),
    );
  });

  it("Story E (07 §5.2): detection performs zero mutation on frozen inputs", () => {
    const works = deepFreeze([pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)]);
    const waits = deepFreeze([waitOn(WE1, ED1), waitOn(WE2, ED2)]);
    const dependencies = deepFreeze([
      pureDep(ED1, WE1, workBound(WE2)),
      pureDep(ED2, WE2, workBound(WE1)),
    ]);
    const before = JSON.stringify({ works, waits, dependencies });
    const graph = buildWaitGraph({ works, waits, dependencies });
    const fact = detectDeadlock(graph, {
      classifyOutputs: allIdle(WS_EA),
      now: NOW_E,
    });
    expect(fact).not.toBeNull();
    expect(JSON.stringify({ works, waits, dependencies })).toBe(before);
  });

  it("Story E (07 §5.3): Withdraw breaks the cycle even while the consumer wait is uncleared", () => {
    const graph = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)],
      waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
      dependencies: [
        pureDep(ED1, WE1, workBound(WE2)),
        pureDep(ED2, WE2, workBound(WE1), "Withdrawn"),
      ],
    });
    expect(
      detectDeadlock(graph, { classifyOutputs: allIdle(WS_EA), now: NOW_E }),
    ).toBeNull();
    expect(hasDeadlock(graph, allIdle(WS_EA))).toBe(false);
  });

  it("Story E (07 §5.4–§5.5): WorkspaceBound degeneration — exactly 1 eligible producer participates, ≥2 declines (SCC false-positive counterexample), 0 declines", () => {
    const degenerate = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB)],
      waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
      dependencies: [
        pureDep(ED1, WE1, workspaceBound(WS_EB)),
        pureDep(ED2, WE2, workspaceBound(WS_EA)),
      ],
    });
    expect(
      detectDeadlock(degenerate, {
        classifyOutputs: allIdle(WS_EA, WS_EB),
        now: NOW_E,
      }),
    ).toEqual({
      cycleWorkIds: [WE1, WE2],
      dependencyIds: [ED1, ED2],
      detectedAt: NOW_E,
    });

    const orOpen = buildWaitGraph({
      works: [
        pureWork(WE1, WS_EA),
        pureWork(WE3, WS_EA),
        pureWork(WE2, WS_EB),
        pureWork(WE9, WS_EB),
      ],
      waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
      dependencies: [
        pureDep(ED1, WE1, workspaceBound(WS_EB)),
        pureDep(ED2, WE2, workspaceBound(WS_EA)),
      ],
    });
    expect(
      detectDeadlock(orOpen, {
        classifyOutputs: allIdle(WS_EA, WS_EB),
        now: NOW_E,
      }),
    ).toBeNull();

    const vacant = buildWaitGraph({
      works: [pureWork(WE1, WS_EA)],
      waits: [waitOn(WE1, ED1)],
      dependencies: [pureDep(ED1, WE1, workspaceBound(WS_EC))],
    });
    expect(
      detectDeadlock(vacant, {
        classifyOutputs: allIdle(WS_EA, WS_EC),
        now: NOW_E,
      }),
    ).toBeNull();
  });

  it("Story E (07 §5.6): eligible-set lifecycle — 0→1 enters determination, 1→2 exits; producer-side terminal states are re-check points", () => {
    const dependencies = [
      pureDep(ED1, WE1, workspaceBound(WS_EB)),
      pureDep(ED2, WE2, workBound(WE1)),
    ];
    const waits = [waitOn(WE1, ED1), waitOn(WE2, ED2)];
    const gate = allIdle(WS_EA, WS_EB);

    const vacant = buildWaitGraph({
      works: [pureWork(WE1, WS_EA)],
      waits,
      dependencies,
    });
    expect(
      detectDeadlock(vacant, { classifyOutputs: gate, now: NOW_E }),
    ).toBeNull();

    const one = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB)],
      waits,
      dependencies,
    });
    expect(detectDeadlock(one, { classifyOutputs: gate, now: NOW_E })).toEqual({
      cycleWorkIds: [WE1, WE2],
      dependencyIds: [ED1, ED2],
      detectedAt: NOW_E,
    });

    const two = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB), pureWork(WE3, WS_EB)],
      waits,
      dependencies,
    });
    expect(
      detectDeadlock(two, { classifyOutputs: gate, now: NOW_E }),
    ).toBeNull();

    const producerCancelled = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB, "Cancelled")],
      waits,
      dependencies,
    });
    expect(
      detectDeadlock(producerCancelled, { classifyOutputs: gate, now: NOW_E }),
    ).toBeNull();

    const producerCompleted = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB, "Completed")],
      waits,
      dependencies,
    });
    expect(
      detectDeadlock(producerCompleted, { classifyOutputs: gate, now: NOW_E }),
    ).toBeNull();
  });

  it("Story E (07 §5.7): ghost edge — a Satisfied dependency with an uncleared consumer wait emits no fact", () => {
    const graph = buildWaitGraph({
      works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)],
      waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
      dependencies: [
        pureDep(ED1, WE1, workBound(WE2), "Satisfied"),
        pureDep(ED2, WE2, workBound(WE1)),
      ],
    });
    expect(
      detectDeadlock(graph, { classifyOutputs: allIdle(WS_EA), now: NOW_E }),
    ).toBeNull();
  });

  it("Story F (07 §6): classify is the only runnable authority — the wait × dependency matrix decides equivalently; P5 runnable-source guards stay in place", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* runMigrations(P7_MIGRATIONS);
        yield* p7SeedProject;
        yield* seedWorks([
          [WORK_F_WAIT, cmd("89f0000000f1")],
          [WORK_F_BLOCKED, cmd("89f0000000f2")],
          [WORK_F_DEP_ONLY, cmd("89f0000000f3")],
          [WORK_F_CLEAN, cmd("89f0000000f4")],
        ]);
        yield* insertWait(WORK_F_WAIT, [timeReached]);
        yield* seedDependency(
          DEP_F_BLOCKED,
          WORK_F_BLOCKED,
          workspaceBound(WS_F_OTHER),
          expectedOf("report", ["summary"]),
        );
        yield* insertWait(WORK_F_BLOCKED, [depChanged(DEP_F_BLOCKED)]);
        yield* seedDependency(
          DEP_F_UNREFERENCED,
          WORK_F_DEP_ONLY,
          workspaceBound(WS_F_OTHER),
          expectedOf("report", ["summary"]),
        );

        const matrix = yield* classifyRoot;
        expect(matrix.current).toEqual(Option.none());
        expect([...matrix.runnable]).toEqual([WORK_F_DEP_ONLY, WORK_F_CLEAN]);
        expect(decideFromTable(matrix.current, matrix.runnable)).toEqual({
          _tag: "Admit",
          focus: { _tag: "Coordination" },
        });

        yield* setCurrentWork(WORK_F_BLOCKED);
        const blockedCurrent = yield* classifyRoot;
        expect(blockedCurrent.current).toEqual(Option.none());
        expect([...blockedCurrent.runnable]).toEqual([
          WORK_F_DEP_ONLY,
          WORK_F_CLEAN,
        ]);
        expect(
          decideFromTable(blockedCurrent.current, blockedCurrent.runnable),
        ).toEqual({ _tag: "Admit", focus: { _tag: "Coordination" } });

        yield* setCurrentWork(WORK_F_CLEAN);
        const cleanCurrent = yield* classifyRoot;
        expect(cleanCurrent.current).toEqual(Option.some(WORK_F_CLEAN));
        expect([...cleanCurrent.runnable]).toEqual([WORK_F_DEP_ONLY]);
        expect(
          decideFromTable(cleanCurrent.current, cleanCurrent.runnable),
        ).toEqual({
          _tag: "Admit",
          focus: { _tag: "Work", workId: WORK_F_CLEAN },
        });

        yield* setCurrentWork(null);
        yield* insertWait(WORK_F_DEP_ONLY, [{ _tag: "Manual" }]);
        const singleRunnable = yield* classifyRoot;
        expect(singleRunnable.current).toEqual(Option.none());
        expect([...singleRunnable.runnable]).toEqual([WORK_F_CLEAN]);
        expect(
          decideFromTable(singleRunnable.current, singleRunnable.runnable),
        ).toEqual({ _tag: "SelectCurrentWork", workId: WORK_F_CLEAN });

        expect(
          existsSync(
            join(
              import.meta.dirname,
              "..",
              "apps/single-workspace/test/p5-runnable-source.test.ts",
            ),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(
              import.meta.dirname,
              "..",
              "apps/single-workspace/src/runnable-source-p7.ts",
            ),
          ),
        ).toBe(true);
      }),
    );
  });
});
