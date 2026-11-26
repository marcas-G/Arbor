import { realpathSync } from "node:fs";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockTest,
  CommandStoreLive,
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
  WorkspaceResourceActivationStoreLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeRecordDecisionHandler } from "../../packages/application/src/commands/record-decision.js";
import { makeSendMessageHandler } from "../../packages/application/src/commands/send-message.js";
import { makeSteerWorkHandler } from "../../packages/application/src/commands/steer-work.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
  runFormationConsumer,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  Actor,
  type ChildWorkspaceProposal,
  CommandId,
  ContextEpochNumber,
  type Execution,
  ExecutionId,
  LeaseGeneration,
  MessageId,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  type Clock,
  DomainEventJournal,
  ExecutionRepository,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  ProjectResourceProfilePort,
  type ProjectResourceProfilePortService,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import {
  seedCurrentOpenWork,
  workEpisode,
} from "../support/execution-episode-fixtures.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";

export const ACTOR = parse(Actor)("user:gov");
export const PRINCIPAL = parse(Principal)("user:gov");
export const PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const ROOT = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const ROOT_SESSION = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const P6_PROFILE_REF = "p6-acceptance-root";
export const P6_PROFILE_VERSION = "fixture-v1";
export const P6_PROFILE_ADDRESS = realpathSync("tests");
export const P6_FILE_TREE_ADDRESS = {
  _tag: "FileTree" as const,
  path: P6_PROFILE_ADDRESS,
};
export const p6ProjectResourceProfiles: ProjectResourceProfilePortService = {
  list: () =>
    Effect.succeed([
      {
        resourceProfileRef: P6_PROFILE_REF,
        version: P6_PROFILE_VERSION,
        displayName: "P6 test FileTree profile",
        available: true,
      },
    ]),
  resolve: (resourceProfileRef, version) =>
    Effect.succeed(
      resourceProfileRef === P6_PROFILE_REF && version === P6_PROFILE_VERSION
        ? Option.some({
            resourceProfileRef: P6_PROFILE_REF,
            version: P6_PROFILE_VERSION,
            displayName: "P6 test FileTree profile",
            available: true as const,
            canonicalAddress: P6_FILE_TREE_ADDRESS,
          })
        : Option.none(),
    ),
};
export const SEED_COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

export const ws = (suffix: string) =>
  parse(WorkspaceId)(`ws_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
export const ses = (suffix: string) =>
  parse(SessionId)(`ses_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
export const exe = (suffix: string) =>
  parse(ExecutionId)(`exe_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
export const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
export const msg = (suffix: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
export const wrk = (suffix: string) =>
  parse(WorkId)(`wrk_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

export const EXE_ROOT = exe("a1");
export const MAIN_WORK = wrk("e1");
export const MODIFY_COMMAND = cmd("a2");
export const STALE_COMMAND = cmd("a3");
export const APPROVE_COMMAND = cmd("a4");

export const CHILD_B1 = ws("b2");
export const CHILD_B1_SESSION = ses("b2");
export const EXE_CHILD = exe("b3");
export const CHILD_B_STORY_WORK = wrk("b9");
export const FORCED_CHILD = ws("b4");
export const FORCED_SESSION = ses("b4");
export const SIBLING_CREATE_COMMAND = cmd("b5");

export const EXE_MAIN_C = exe("c1");
export const MAIN_ADMIT_C = cmd("c3");

export const CHILD_D = ws("d1");
export const CHILD_D_SESSION = ses("d1");
export const GRANDCHILD_D = ws("d2");
export const GRANDCHILD_D_SESSION = ses("d2");
export const CHILD_B_D = ws("d3");
export const CHILD_B_D_SESSION = ses("d3");
export const EXE_PARENT_D = exe("d1");
export const PARENT_ADMIT_D = cmd("d4");
export const REPORT_MSG = msg("d5");
export const REPORT_COMMAND = cmd("d5");
export const REPLY_MSG = msg("d6");
export const REPLY_COMMAND = cmd("d6");
export const ILLEGAL_QUERY_MSG = msg("d7");
export const ILLEGAL_QUERY_COMMAND = cmd("d7");
export const CORRELATION_D = "corr-p6-acceptance-d";

export const CHILD_E = ws("e1");
export const CHILD_E_SESSION = ses("e1");
export const CHILD_B_E = ws("e2");
export const CHILD_B_E_SESSION = ses("e2");
export const WORK_E = wrk("e1");
export const ASSIGN_E = cmd("e1");
export const ADMIT_E = cmd("e2");
export const EXE_MAIN_E = exe("e1");
export const NORMAL_STEER_E = cmd("e3");
export const SIBLING_STEER_E = cmd("e4");
export const CRITICAL_STEER_E = cmd("e5");
export const CRITICAL_STOP_E = cmd("e6");
export const STALE_STEER_E = cmd("e7");
export const STALE_STOP_E = cmd("e8");

export const AcceptanceRegistryLive: Layer.Layer<
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
  | WorkspaceResourceActivationStore
  | ProjectResourceProfilePort
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
    const activations = yield* WorkspaceResourceActivationStore;
    const projectResourceProfiles = yield* ProjectResourceProfilePort;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({
        projects,
        workspaces,
        sessions,
        activations,
        works,
        projectResourceProfiles,
      }),
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
        readmissionGate: NoHoldWorkReadmissionGateStoreService,
      }),
      makeRecordDecisionHandler({
        proposals,
        inbox,
        originatingWorkspaceOf: (record) => record.parentWorkspaceId,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeSendMessageHandler({
        workspaces,
        messages,
        inbox,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeSteerWorkHandler({
        works,
        inbox,
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

export const makeAcceptanceApp = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | Clock
  | DomainEventJournal
  | FormationProposalStore
  | MessageStore
  | WorkspaceResourceActivationStore
  | InboxProjectionStore
  | WorkspaceRepository
  | WorkRepository
  | ExecutionRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const storeDeps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    Layer.succeed(ProjectResourceProfilePort, p6ProjectResourceProfiles),
  );
  const registry = Layer.provide(AcceptanceRegistryLive, storeDeps);
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    storeDeps,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | Clock
    | DomainEventJournal
    | FormationProposalStore
    | MessageStore
    | WorkspaceResourceActivationStore
    | InboxProjectionStore
    | WorkspaceRepository
    | WorkRepository
    | ExecutionRepository
  >;
};

export const runAcceptance = <A, R>(
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

export const seedProject = Effect.gen(function* () {
  yield* ensureLegacyProjectResourceSourceFixture();
  const gateway = yield* CommandGateway;
  const payload = {
    name: "p6-acceptance",
    revision: parse(Revision)(0),
    projectPolicy: makeProjectPolicy(),
    projectPolicyRevision: parse(Revision)(0),
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId: ROOT,
    primarySession: {
      sessionId: ROOT_SESSION,
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
      resourceSelection: {
        _tag: "Profile" as const,
        resourceProfileRef: P6_PROFILE_REF,
        version: P6_PROFILE_VERSION,
      },
      agentBinding: responsibilityBound(ROOT),
      workspacePolicy: makeWorkspacePolicy(),
      workspacePolicyRevision: parse(Revision)(0),
      revision: parse(Revision)(0),
    },
  };
  yield* gateway.execute(
    {
      commandType: "CreateProject",
      commandId: SEED_COMMAND,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: PRINCIPAL },
    {
      _tag: "CreateProjectAuthority",
      principal: PRINCIPAL,
      commandId: SEED_COMMAND,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateProject",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "2",
        payload,
      }),
      projectId: PROJECT,
    },
  );
});

export const workspaceRow = (
  workspaceId: WorkspaceId,
  parentWorkspaceId: WorkspaceId,
  sessionId: SessionId,
) => [
  workspaceId,
  PROJECT,
  parentWorkspaceId,
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
    addresses: [P6_FILE_TREE_ADDRESS],
  }),
  1,
  JSON.stringify({ _tag: "ResponsibilityBound", workspaceId }),
  sessionId,
  JSON.stringify({}),
  0,
  0,
  "Active",
  "t",
  "t",
];

export const seedLineage = (
  entries: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly parentWorkspaceId: WorkspaceId;
    readonly sessionId: SessionId;
  }>,
): Effect.Effect<void, unknown, TransactionPort | SqlClient> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    yield* tx.transact(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const entry of entries) {
          yield* sql.unsafe(
            "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            workspaceRow(
              entry.workspaceId,
              entry.parentWorkspaceId,
              entry.sessionId,
            ),
          );
          yield* sql.unsafe(
            "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
            [
              entry.sessionId,
              "WorkspacePrimary",
              entry.workspaceId,
              null,
              0,
              "t",
            ],
          );
        }
      }),
    );
  });

export const countRows = (table: string, where = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} ${where}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const scalar = <T>(sqlText: string, params: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ value: T }>(sqlText, params);
    return rows[0]?.value;
  });

export const journalEvents = Effect.gen(function* () {
  const journal = yield* DomainEventJournal;
  const tx = yield* TransactionPort;
  const last = yield* tx.transact(journal.lastSequence(PROJECT));
  const events = yield* tx.transact(journal.readAfter(PROJECT, 0, last + 1));
  return events.map((event) => ({
    eventType: event.eventType,
    payload: event.payload,
    eventId: `${event.sequence}`,
    occurredAt: event.occurredAt,
  }));
});

export const eventTypes = Effect.map(journalEvents, (events) =>
  events.map((event) => event.eventType),
);

export const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

export const executionOf = (
  executionId: ExecutionId,
  workspaceId: WorkspaceId,
  stopRequestedAt: string | null = null,
  episode = workEpisode(MAIN_WORK),
): Execution => ({
  executionId,
  projectId: PROJECT,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    episode,
  },
  sessionId: ROOT_SESSION,
  admittedAt: "t",
  stopRequestedAt,
  state: { status: "Active" as const, settlement: null },
});

export const executionContext = (executionId: ExecutionId) => ({
  _tag: "ExecutionOrigin" as const,
  principal: PRINCIPAL,
  executionId,
  fencingGeneration: parse(LeaseGeneration)(0),
});

export const proposalDraft = (
  name: string,
  addresses: ReadonlyArray<{
    readonly _tag: "FileTree";
    readonly path: string;
  }> = [],
): ChildWorkspaceProposal => ({
  name,
  responsibilityDraft: {
    purpose: "own the integration slice",
    ownedResponsibilities: ["integration"],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  resourceBoundaryDraft: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
    addresses,
  },
  rationale: "parallelizable responsibility block",
  initialWork: {
    objective: "make the slice pass",
    why: "downstream integration",
    constraints: [],
    completionExpectation: "all suites green",
    verificationMission: {
      goal: "verify the integration slice",
      criteria: [
        {
          criterionId: "suites-green",
          requirement: "all suites are green",
          required: true,
        },
      ],
      riskRequirements: [],
    },
  },
  formationDepthHint: "Single",
});

export const admitMain = (args: {
  readonly commandId: CommandId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    yield* seedCurrentOpenWork(PROJECT, args.workspaceId, MAIN_WORK);
    const payload = {
      _tag: "WorkspaceMain" as const,
      executionId: args.executionId,
      workspaceId: args.workspaceId,
      episode: {
        _tag: "WorkEpisode" as const,
        workId: MAIN_WORK,
        targetWorkRevision: parse(WorkRevision)(0),
      },
    };
    return yield* gw.execute(
      {
        commandType: "AdmitExecution",
        commandId: args.commandId,
        projectId: PROJECT,
        actor: PRINCIPAL as never,
        issuedAt: "t",
        payload,
      },
      { _tag: "System", principal: PRINCIPAL, causationRef: "acceptance" },
      {
        _tag: "AdmitExecutionAuthority",
        submissionOrigin: "System",
        principal: PRINCIPAL,
        commandId: args.commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AdmitExecution",
          projectId: PROJECT,
          actor: PRINCIPAL as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: PROJECT,
        commandKind: "AdmitExecution",
        workspaceId: args.workspaceId,
        bindingKind: "WorkspaceMain",
      },
    );
  });

export const runConsume = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const proposals = yield* FormationProposalStore;
  const workspaces = yield* WorkspaceRepository;
  const tx = yield* TransactionPort;
  const events = yield* journalEvents;
  return yield* runFormationConsumer(
    events,
    {
      gateway: gw,
      workspaces: {
        findById: (id) => tx.transact(workspaces.findById(id)),
      },
      proposals: {
        findById: (id) => tx.transact(proposals.findById(id)),
      },
    },
    PROJECT,
  );
});

export const idFromText = (text: string, prefix: string): string | undefined =>
  new RegExp(`${prefix}[0-9a-f-]+`).exec(text)?.[0];
