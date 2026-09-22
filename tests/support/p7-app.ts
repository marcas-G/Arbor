import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
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
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeRecordDecisionHandler } from "../../packages/application/src/commands/record-decision.js";
import { makeSendMessageHandler } from "../../packages/application/src/commands/send-message.js";
import { makeSteerWorkHandler } from "../../packages/application/src/commands/steer-work.js";
import { CommandHandlerRegistry } from "../../packages/application/src/gateway.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  type CreateProjectPayload,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  type AcceptanceRepository,
  type DeliverableRepository,
  type DependencyRepository,
  type EvidenceRepository,
  ExecutionRepository,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  SessionRepository,
  type TransactionPort,
  type VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";

export const p7TestActor = parse(Actor)("user:gov");
export const p7TestPrincipal = parse(Principal)("user:gov");

export const p7Project = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7RootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7RootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7SeedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

/** P6 governance command set; extended as tasks land. */
export const makeP7CommandHandlers = (dependencies: {
  readonly proposals: typeof FormationProposalStore.Service;
  readonly inbox: typeof InboxProjectionStore.Service;
  readonly messages: typeof MessageStore.Service;
  readonly workspaces: typeof WorkspaceRepository.Service;
  readonly works: typeof WorkRepository.Service;
}): ReadonlyArray<CommandHandler<unknown, unknown>> => [
  makeRecordDecisionHandler({
    proposals: dependencies.proposals,
    inbox: dependencies.inbox,
    originatingWorkspaceOf: (record) => record.parentWorkspaceId,
  }) as unknown as CommandHandler<unknown, unknown>,
  makeSendMessageHandler({
    workspaces: dependencies.workspaces,
    messages: dependencies.messages,
    inbox: dependencies.inbox,
  }) as unknown as CommandHandler<unknown, unknown>,
  makeSteerWorkHandler({
    works: dependencies.works,
    inbox: dependencies.inbox,
  }) as unknown as CommandHandler<unknown, unknown>,
];

const P7CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
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

/** sqlite infra; tests run `runMigrations(P8_MIGRATIONS)` first (P1 pattern).
 * Exposes the P6 stores + TransactionPort so test bodies can seed directly. */
export const makeP7App = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | FormationProposalStore
  | MessageStore
  | InboxProjectionStore
  | WorkspaceRepository
  | WorkRepository
  | DependencyRepository
  | DeliverableRepository
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const registry = Layer.provide(
    P7CommandHandlerRegistryLive,
    Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(ExecutionRepositoryLive, infra),
      Layer.provide(WorkWaitStoreLive, infra),
      Layer.provide(FormationProposalStoreLive, infra),
      Layer.provide(MessageStoreLive, infra),
      Layer.provide(InboxProjectionStoreLive, infra),
      Layer.provide(DependencyRepositoryLive, infra),
      Layer.provide(DeliverableRepositoryLive, infra),
      Layer.provide(VerificationRepositoryLive, infra),
      Layer.provide(EvidenceRepositoryLive, infra),
      Layer.provide(AcceptanceRepositoryLive, infra),
    ),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | FormationProposalStore
    | MessageStore
    | InboxProjectionStore
    | WorkspaceRepository
    | WorkRepository
    | DependencyRepository
    | DeliverableRepository
    | VerificationRepository
    | EvidenceRepository
    | AcceptanceRepository
  >;
};

export const runP7 = <A, R>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient | R>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, unknown, CommandGateway | SqlClient>,
        app,
      ),
    ),
  );

export const p7SeedProject = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const payload: CreateProjectPayload = {
    name: "p6",
    revision: parse(Revision)(0),
    projectPolicy: makeProjectPolicy(),
    projectPolicyRevision: parse(Revision)(0),
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId: p7RootWorkspace,
    primarySession: {
      sessionId: p7RootSession,
      contextEpoch: parse(ContextEpochNumber)(0),
    },
    rootWorkspace: {
      name: "root",
      responsibilityDefinition: {
        purpose: "p",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: parse(ResponsibilityRevision)(0),
      resourceBoundary: {
        basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
        addresses: [],
      },
      resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
      agentBinding: responsibilityBound(p7RootWorkspace),
      workspacePolicy: makeWorkspacePolicy(),
      workspacePolicyRevision: parse(Revision)(0),
      revision: parse(Revision)(0),
    },
  };
  const authority: VerifiedCommandAuthority = {
    _tag: "CreateProjectAuthority",
    principal: p7TestPrincipal,
    commandId: p7SeedCommandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "CreateProject",
      projectId: p7Project,
      actor: p7TestActor,
      schemaVersion: "1",
      payload,
    }),
    projectId: p7Project,
  };
  yield* gateway.execute(
    {
      commandType: "CreateProject",
      commandId: p7SeedCommandId,
      projectId: p7Project,
      actor: p7TestActor,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: p7TestPrincipal },
    authority,
  );
});

export const p7EventTypes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ event_type: string }>(
    "SELECT event_type FROM domain_events ORDER BY sequence",
  );
  return rows.map((row) => row.event_type);
});

void MessageStore;

/** Seeds one Open Work on the root workspace via the real AssignWork command. */
export const p7SeedWork = (
  workId: import("../../packages/domain/dist/index.js").WorkId,
  commandId: import("../../packages/domain/dist/index.js").CommandId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const { parse, WorkRevision } = yield* Effect.promise(
      () => import("../../packages/domain/dist/index.js"),
    );
    const payload = {
      workId,
      workspaceId: p7RootWorkspace,
      expectedWorkspaceRevision: parse(Revision)(0),
      objective: "p7",
      why: "seed",
      constraints: [],
      completionExpectation: "green",
      verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
      provenance: { predecessorWorkId: null, reason: "seed" },
      revision: parse(WorkRevision)(0),
    };
    return yield* gateway.execute(
      {
        commandType: "AssignWork",
        commandId,
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        payload,
      },
      { _tag: "External", principal: p7TestPrincipal },
      {
        _tag: "AssignWorkAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AssignWork",
          projectId: p7Project,
          actor: p7TestActor,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
      },
    );
  });
