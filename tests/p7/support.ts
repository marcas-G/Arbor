import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
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
  ProjectRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../../apps/single-workspace/src/runnable-source-p7.js";
import {
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  makeDeclareDependencyHandler,
} from "../../packages/application/src/commands/declare-dependency.js";
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
} from "../../packages/application/src/commands/dependency-transitions.js";
import {
  makeProduceDeliverableHandler,
  type ProduceDeliverablePayload,
  type ProduceDeliverableResult,
} from "../../packages/application/src/commands/produce-deliverable.js";
import {
  makeSatisfyDependencyHandler,
  type SatisfyDependencyPayload,
  type SatisfyDependencyResult,
} from "../../packages/application/src/commands/satisfy-dependency.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  ArtifactId,
  type ArtifactRole,
  CommandId,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  ExecutionId,
  type ExpectedDeliverable,
  MessageId,
  parse,
  WorkId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  type DomainEventJournal,
  ExecutionRepository,
  ExecutionScheduler,
  FormationProposalStore,
  type IdGenerator,
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  type RunnableWorkSource,
  type SchedulerDecision,
  SessionRepository,
  type TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import {
  NoHoldWorkReadmissionGateStoreLive,
  NoHoldWorkReadmissionGateStoreService,
} from "../../packages/testkit/src/index.js";
import {
  makeP7CommandHandlers,
  p7Project,
  p7RootWorkspace,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";

// --- ids (uuid-v7 shaped, one namespace per story) ---

export const wrk = (tail: string) =>
  parse(WorkId)(`wrk_00000000-0000-7000-8000-000000${tail}`);
export const ws = (tail: string) =>
  parse(WorkspaceId)(`ws_00000000-0000-7000-8000-000000${tail}`);
export const dep = (tail: string) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-000000${tail}`);
export const del = (tail: string) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-000000${tail}`);
export const art = (tail: string) =>
  parse(ArtifactId)(`art_00000000-0000-7000-8000-000000${tail}`);
export const msg = (tail: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-${tail}`);
export const cmd = (tail: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${tail}`);
export const exe = (tail: string) =>
  parse(ExecutionId)(`exe_00000000-0000-7000-8000-000000${tail}`);
export const REV = (n: number) => parse(DependencyRevision)(n);

export const WORK_A_CHILD = wrk("00a001");
export const WORK_A_PARENT = wrk("00a002");
export const WORK_A_SIBLING = wrk("00a003");
export const DEP_A1 = dep("00a011");
export const DEP_A2 = dep("00a012");

export const WORK_B_CONSUMER = wrk("00b001");
export const WORK_B_PRODUCER = wrk("00b002");
export const DEP_B1 = dep("00b011");
export const DEP_B2 = dep("00b012");
export const DEL_B1 = del("00b021");
export const DEL_B2 = del("00b022");
export const ART_B = art("00b031");
export const EXE_B = exe("00b041");

export const CHILD_C = ws("00c001");
export const CHILD_C_SESSION = "ses_00000000-0000-7000-8000-00000000c001";
export const WORK_C_CHILD = wrk("00c002");
export const WORK_C_ROOT = wrk("00c003");
export const DEP_C = dep("00c011");
export const DEL_C = del("00c021");
export const MSG_C_DELIVER = msg("89c0000000c4");
export const CMD_C_DELIVER = cmd("89c0000000c3");
export const MSG_C_REJECT = msg("89c0000000c6");
export const CMD_C_REJECT = cmd("89c0000000c5");
export const MSG_C_REPORT = msg("89c0000000c8");
export const CMD_C_REPORT = cmd("89c0000000c7");

export const WORK_D_CONSUMER = wrk("00d001");
export const WORK_D_PRODUCER = wrk("00d002");
export const WORK_D_AGENT = wrk("00d003");
export const DEP_D_SATISFIED = dep("00d011");
export const DEP_D_REVISED = dep("00d012");
export const DEP_D_WITHDRAWN = dep("00d013");
export const DEP_D_MARKED = dep("00d014");
export const DEP_D_LOSS_WB = dep("00d015");
export const DEP_D_LOSS_WS = dep("00d016");
export const DEP_D_LOSS_ANY = dep("00d017");
export const DEP_D_AGENT = dep("00d018");
export const DEL_D_SAT = del("00d021");
export const DEL_D_AGENT = del("00d022");
export const ART_D = art("00d031");
export const EXE_D = exe("00d041");

export const WORK_E1 = wrk("00e001");
export const WORK_E2 = wrk("00e002");
export const DEP_E1 = dep("00e011");
export const DEP_E2 = dep("00e012");
export const NOW_E = "2026-09-21T00:00:00.000Z";

export const WORK_F_WAIT = wrk("00f001");
export const WORK_F_BLOCKED = wrk("00f002");
export const WORK_F_DEP_ONLY = wrk("00f003");
export const WORK_F_CLEAN = wrk("00f004");
export const DEP_F_BLOCKED = dep("00f011");
export const DEP_F_UNREFERENCED = dep("00f012");
export const WS_F_OTHER = ws("00f005");

// --- mini gateway composition: P1 + P2 + the P7-phase commands ---

export const P7_PHASE_COMMAND_TYPES: ReadonlyArray<string> = [
  "RecordDecision",
  "SendMessage",
  "DeliverMessage",
  "SteerWork",
  "DeclareDependency",
  "ProduceDeliverable",
  "SatisfyDependency",
  "WithdrawDependency",
  "MarkDependencyUnfulfillable",
  "ReviseDependencyContract",
];

export type StoryServices =
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

export interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReasonTag: string;
}

export const makeSchedulerStub = () => {
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

export type RegistryDeps =
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

export const StoryRegistryLive: Layer.Layer<
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
        readmissionGate: NoHoldWorkReadmissionGateStoreService,
      }),
      ...makeP7CommandHandlers({
        proposals,
        inbox,
        messages,
        workspaces,
        works,
        deliverables,
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

export const makeStoryApp = () => {
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
    NoHoldWorkReadmissionGateStoreLive,
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

export const runStory = <A>(
  app: Layer.Layer<StoryServices>,
  program: Effect.Effect<A, unknown, StoryServices>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(program, app)));

// --- shared helpers ---

export const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

export const envelopeOf = <P>(
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

export const fingerprintOf = <P>(commandType: string, payload: P) =>
  semanticRequestFingerprint({
    commandType,
    projectId: p7Project,
    actor: p7TestActor,
    schemaVersion: "1",
    payload,
  });

export const externalContext = {
  _tag: "External",
  principal: p7TestPrincipal,
} as const;

export const submitDeclare = (
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

export const submitProduce = (
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

export const submitSatisfy = (
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

export const submitWithdraw = (
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

export const submitMark = (
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

export const submitRevise = (
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
