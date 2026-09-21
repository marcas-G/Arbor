import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P6_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
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
  ExecutionRepository,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  SessionRepository,
  type TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";

export const p6TestActor = parse(Actor)("user:gov");
export const p6TestPrincipal = parse(Principal)("user:gov");

export const p6Project = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6RootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6RootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6SeedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

/** P6 governance command set; extended as tasks land. */
export const makeP6CommandHandlers = (dependencies: {
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

const P6CommandHandlerRegistryLive: Layer.Layer<
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
      ...makeP6CommandHandlers({
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

/** sqlite infra; tests run `runMigrations(P6_MIGRATIONS)` first (P1 pattern).
 * Exposes the P6 stores + TransactionPort so test bodies can seed directly. */
export const makeP6App = (
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
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const registry = Layer.provide(
    P6CommandHandlerRegistryLive,
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
  >;
};

export const runP6 = <A, R>(
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

export const p6SeedProject = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const payload: CreateProjectPayload = {
    name: "p6",
    revision: parse(Revision)(0),
    projectPolicy: makeProjectPolicy(),
    projectPolicyRevision: parse(Revision)(0),
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId: p6RootWorkspace,
    primarySession: {
      sessionId: p6RootSession,
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
      agentBinding: responsibilityBound(p6RootWorkspace),
      workspacePolicy: makeWorkspacePolicy(),
      workspacePolicyRevision: parse(Revision)(0),
      revision: parse(Revision)(0),
    },
  };
  const authority: VerifiedCommandAuthority = {
    _tag: "CreateProjectAuthority",
    principal: p6TestPrincipal,
    commandId: p6SeedCommandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "CreateProject",
      projectId: p6Project,
      actor: p6TestActor,
      schemaVersion: "1",
      payload,
    }),
    projectId: p6Project,
  };
  yield* gateway.execute(
    {
      commandType: "CreateProject",
      commandId: p6SeedCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: p6TestPrincipal },
    authority,
  );
});

export const p6EventTypes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ event_type: string }>(
    "SELECT event_type FROM domain_events ORDER BY sequence",
  );
  return rows.map((row) => row.event_type);
});

void MessageStore;
