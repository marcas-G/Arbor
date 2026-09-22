import { readFileSync } from "node:fs";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
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
  P6_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeProposeChildWorkspaceHandler,
  makeSpawnSpecialistHandler,
} from "../apps/single-workspace/src/directives.js";
import { makeRequestGovernanceHandler } from "../apps/single-workspace/src/governance-directive.js";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  loadProgram,
  PROGRAM_REGISTRY,
  type ProgramRegistryEntry,
  programFilePath,
} from "../packages/agent-runtime/src/prompt-programs.js";
import type { RecordDecisionResult } from "../packages/application/src/commands/record-decision.js";
import { makeRecordDecisionHandler } from "../packages/application/src/commands/record-decision.js";
import {
  makeSendMessageHandler,
  type SendMessagePayload,
  type SendMessageResult,
  sendMessagePlan,
} from "../packages/application/src/commands/send-message.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
  type SteerWorkResult,
} from "../packages/application/src/commands/steer-work.js";
import {
  type SubmitCriticalSteerArgs,
  submitCriticalSteer,
} from "../packages/application/src/critical-steer.js";
import { consumeInboxEntry } from "../packages/application/src/inbox-consumption.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  type CommandRejection,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  runFormationConsumer,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import { admitSpecialistSettlement } from "../packages/application/src/specialist-settlement.js";
import {
  Actor,
  type ChildWorkspaceProposal,
  CommandId,
  type CommandReceipt,
  ContextEpochNumber,
  type Execution,
  ExecutionId,
  type ExecutionSettlement,
  FormationProposalId,
  type FormationProposalRecord,
  LeaseGeneration,
  MessageId,
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
  settlementFingerprint,
  specialistSettlementEntryKey,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  makeP2CommandHandlers,
  makeStopExecutionHandler,
  type StopExecutionPayload,
  type StopExecutionResult,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  DomainEventJournal,
  ExecutionRepository,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";

const ACTOR = parse(Actor)("user:gov");
const PRINCIPAL = parse(Principal)("user:gov");
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789c1");
const ROOT_SESSION = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const SEED_COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

const ws = (suffix: string) =>
  parse(WorkspaceId)(`ws_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const ses = (suffix: string) =>
  parse(SessionId)(`ses_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const exe = (suffix: string) =>
  parse(ExecutionId)(`exe_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const msg = (suffix: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const wrk = (suffix: string) =>
  parse(WorkId)(`wrk_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

const EXE_ROOT = exe("a1");
const MODIFY_COMMAND = cmd("a2");
const STALE_COMMAND = cmd("a3");
const APPROVE_COMMAND = cmd("a4");

const CHILD_B1 = ws("b2");
const CHILD_B1_SESSION = ses("b2");
const EXE_CHILD = exe("b3");
const FORCED_CHILD = ws("b4");
const FORCED_SESSION = ses("b4");
const SIBLING_CREATE_COMMAND = cmd("b5");

const EXE_MAIN_C = exe("c1");
const MAIN_ADMIT_C = cmd("c3");

const CHILD_D = ws("d1");
const CHILD_D_SESSION = ses("d1");
const GRANDCHILD_D = ws("d2");
const GRANDCHILD_D_SESSION = ses("d2");
const CHILD_B_D = ws("d3");
const CHILD_B_D_SESSION = ses("d3");
const EXE_PARENT_D = exe("d1");
const PARENT_ADMIT_D = cmd("d4");
const REPORT_MSG = msg("d5");
const REPORT_COMMAND = cmd("d5");
const REPLY_MSG = msg("d6");
const REPLY_COMMAND = cmd("d6");
const ILLEGAL_QUERY_MSG = msg("d7");
const ILLEGAL_QUERY_COMMAND = cmd("d7");
const CORRELATION_D = "corr-p6-acceptance-d";

const CHILD_E = ws("e1");
const CHILD_E_SESSION = ses("e1");
const CHILD_B_E = ws("e2");
const CHILD_B_E_SESSION = ses("e2");
const WORK_E = wrk("e1");
const ASSIGN_E = cmd("e1");
const ADMIT_E = cmd("e2");
const EXE_MAIN_E = exe("e1");
const NORMAL_STEER_E = cmd("e3");
const SIBLING_STEER_E = cmd("e4");
const CRITICAL_STEER_E = cmd("e5");
const CRITICAL_STOP_E = cmd("e6");
const STALE_STEER_E = cmd("e7");
const STALE_STOP_E = cmd("e8");

const AcceptanceRegistryLive: Layer.Layer<
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

const makeAcceptanceApp = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | Clock
  | DomainEventJournal
  | FormationProposalStore
  | MessageStore
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
    | InboxProjectionStore
    | WorkspaceRepository
    | WorkRepository
    | ExecutionRepository
  >;
};

const runAcceptance = <A, R>(
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

const seedProject = Effect.gen(function* () {
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
      resourceBoundary: {
        basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
        addresses: [],
      },
      resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
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
        schemaVersion: "1",
        payload,
      }),
      projectId: PROJECT,
    },
  );
});

const workspaceRow = (
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
  JSON.stringify({ basisResponsibilityRevision: 1, addresses: [] }),
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

const seedLineage = (
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

const countRows = (table: string, where = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} ${where}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const scalar = <T>(sqlText: string, params: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ value: T }>(sqlText, params);
    return rows[0]?.value;
  });

const journalEvents = Effect.gen(function* () {
  const journal = yield* DomainEventJournal;
  const tx = yield* TransactionPort;
  const last = yield* tx.transact(journal.lastSequence(PROJECT));
  const events = yield* tx.transact(journal.readAfter(PROJECT, 0, last + 1));
  return events.map((event) => ({
    eventType: event.eventType,
    payload: event.payload,
    eventId: `${event.sequence}`,
  }));
});

const eventTypes = Effect.map(journalEvents, (events) =>
  events.map((event) => event.eventType),
);

const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

const executionOf = (
  executionId: ExecutionId,
  workspaceId: WorkspaceId,
  stopRequestedAt: string | null = null,
): Execution => ({
  executionId,
  projectId: PROJECT,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    focus: { _tag: "Coordination" as const },
  },
  sessionId: ROOT_SESSION,
  admittedAt: "t",
  stopRequestedAt,
  state: { status: "Active" as const, settlement: null },
});

const executionContext = (executionId: ExecutionId) => ({
  _tag: "ExecutionOrigin" as const,
  principal: PRINCIPAL,
  executionId,
  fencingGeneration: parse(LeaseGeneration)(0),
});

const proposalDraft = (
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
  },
  formationDepthHint: "Single",
});

const admitMain = (args: {
  readonly commandId: CommandId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    const payload = {
      _tag: "WorkspaceMain" as const,
      executionId: args.executionId,
      workspaceId: args.workspaceId,
      focus: { _tag: "Coordination" as const },
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

const submitDecision = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly proposalId: FormationProposalId;
    readonly expectedProposalRevision: number;
    readonly outcome:
      | { readonly _tag: "Approve" }
      | { readonly _tag: "Reject" }
      | {
          readonly _tag: "Modify";
          readonly proposal: ChildWorkspaceProposal;
        };
  },
): Effect.Effect<
  CommandReceipt<RecordDecisionResult, CommandRejection>,
  unknown
> => {
  const payload = {
    proposalId: args.proposalId,
    expectedProposalRevision: args.expectedProposalRevision,
    outcome: args.outcome,
  };
  return gw.execute(
    {
      commandType: "RecordDecision",
      commandId: args.commandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: PRINCIPAL },
    {
      _tag: "RecordDecisionAuthority",
      principal: PRINCIPAL,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "RecordDecision",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "1",
        payload,
      }),
      projectId: PROJECT,
      proposalId: args.proposalId,
    },
  );
};

const submitSend = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SendMessagePayload;
  },
): Effect.Effect<
  CommandReceipt<SendMessageResult, CommandRejection>,
  unknown
> => {
  const plan = sendMessagePlan({
    messageId: args.payload.messageId,
    commandId: args.commandId,
    projectId: PROJECT,
    senderWorkspaceId: args.payload.senderWorkspaceId,
    principal: PRINCIPAL,
    actor: ACTOR,
    message: args.payload.message,
  });
  const envelope: GatewayEnvelope<SendMessagePayload> = {
    commandType: "SendMessage",
    commandId: args.commandId,
    projectId: PROJECT,
    actor: ACTOR,
    issuedAt: "t",
    payload: args.payload,
  };
  return gw.execute(
    envelope,
    { _tag: "External", principal: PRINCIPAL },
    plan.authority,
  );
};

const submitSteer = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly authorityTargetWorkspaceId?: WorkspaceId;
  },
) => {
  const authority: VerifiedCommandAuthority = {
    _tag: "SteerWorkAuthority",
    principal: PRINCIPAL,
    commandId: args.commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "SteerWork",
      projectId: PROJECT,
      actor: ACTOR,
      schemaVersion: "1",
      payload: args.payload,
    }),
    projectId: PROJECT,
    targetWorkspaceId:
      args.authorityTargetWorkspaceId ?? args.payload.workspaceId,
    workId: args.payload.workId,
  };
  return gw.execute(
    {
      commandType: "SteerWork",
      commandId: args.commandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: args.payload,
    },
    { _tag: "External", principal: PRINCIPAL },
    authority,
  );
};

const steerHandlers = Effect.gen(function* () {
  return {
    steerHandler: makeSteerWorkHandler({
      works: yield* WorkRepository,
      inbox: yield* InboxProjectionStore,
    }),
    stopHandler: makeStopExecutionHandler({
      executions: yield* ExecutionRepository,
    }),
  };
});

const criticalSteerSubmission = (
  handlers: {
    readonly steerHandler: CommandHandler<SteerWorkPayload, SteerWorkResult>;
    readonly stopHandler: CommandHandler<
      StopExecutionPayload,
      StopExecutionResult
    >;
  },
  args: {
    readonly steerCommandId: CommandId;
    readonly stopCommandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly executionId: ExecutionId;
  },
): SubmitCriticalSteerArgs<StopExecutionPayload, StopExecutionResult> => {
  const stopPayload: StopExecutionPayload = { executionId: args.executionId };
  return {
    steerEnvelope: {
      commandType: "SteerWork",
      commandId: args.steerCommandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: args.payload,
    },
    steerContext: { _tag: "External", principal: PRINCIPAL },
    steerAuthority: {
      _tag: "SteerWorkAuthority",
      principal: PRINCIPAL,
      commandId: args.steerCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SteerWork",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "1",
        payload: args.payload,
      }),
      projectId: PROJECT,
      targetWorkspaceId: args.payload.workspaceId,
      workId: args.payload.workId,
    },
    stopEnvelope: {
      commandType: "StopExecution",
      commandId: args.stopCommandId,
      projectId: PROJECT,
      actor: ACTOR,
      issuedAt: "t",
      payload: stopPayload,
    },
    stopContext: {
      _tag: "System",
      principal: PRINCIPAL,
      causationRef: `acceptance-critical:${args.steerCommandId}`,
    },
    stopAuthority: {
      _tag: "StopExecutionAuthority",
      submissionOrigin: "System",
      principal: PRINCIPAL,
      commandId: args.stopCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "StopExecution",
        projectId: PROJECT,
        actor: ACTOR,
        schemaVersion: "1",
        payload: stopPayload,
      }),
      projectId: PROJECT,
      commandKind: "StopExecution",
      executionId: args.executionId,
    },
    deps: handlers,
  };
};

const runConsume = Effect.gen(function* () {
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

const idFromText = (text: string, prefix: string): string | undefined =>
  new RegExp(`${prefix}[0-9a-f-]+`).exec(text)?.[0];

describe("p6-acceptance", () => {
  it("Story A: first-layer formation under the human gate (D1)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* seedProject;

      const proposeHandler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const govHandler = makeRequestGovernanceHandler({
        gateway: yield* CommandGateway,
        proposals: yield* FormationProposalStore,
        inbox: yield* InboxProjectionStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
        workspaces: yield* WorkspaceRepository,
        messages: yield* MessageStore,
      });
      const proposals = yield* FormationProposalStore;
      const tx = yield* TransactionPort;
      const gw = yield* CommandGateway;

      const proposeOutcome = yield* proposeHandler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("child-integration"),
        },
        execution: executionOf(EXE_ROOT, ROOT),
        context: executionContext(EXE_ROOT),
      });
      const proposalId = parse(FormationProposalId)(
        proposeOutcome._tag === "Observation"
          ? (idFromText(proposeOutcome.observation.text, "fpr_") ?? "")
          : "",
      );
      const record = yield* tx.transact(proposals.findById(proposalId));

      const govOutcome = yield* govHandler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "FormationApproval",
            proposalId,
            proposalRevision: 1,
          },
        },
        execution: executionOf(EXE_ROOT, ROOT),
        context: executionContext(EXE_ROOT),
      });
      const afterProposeEventTypes = yield* eventTypes;
      const afterProposeInbox = yield* inboxOf(ROOT);

      const modify = yield* submitDecision(gw, {
        commandId: MODIFY_COMMAND,
        proposalId,
        expectedProposalRevision: 1,
        outcome: {
          _tag: "Modify",
          proposal: proposalDraft("child-integration-v2"),
        },
      });
      const modified = yield* tx.transact(proposals.findById(proposalId));

      const stale = yield* submitDecision(gw, {
        commandId: STALE_COMMAND,
        proposalId,
        expectedProposalRevision: 1,
        outcome: { _tag: "Approve" },
      });
      const afterStaleEventTypes = yield* eventTypes;
      const afterStaleInbox = yield* inboxOf(ROOT);

      const approve = yield* submitDecision(gw, {
        commandId: APPROVE_COMMAND,
        proposalId,
        expectedProposalRevision: 2,
        outcome: { _tag: "Approve" },
      });
      const approveReplay = yield* submitDecision(gw, {
        commandId: APPROVE_COMMAND,
        proposalId,
        expectedProposalRevision: 2,
        outcome: { _tag: "Approve" },
      });
      const afterApproveEvents = yield* journalEvents;
      const afterApproveWorkspaces = yield* countRows("workspaces");

      const consumed = yield* runConsume;
      const eventsAfterConsume = yield* journalEvents;
      const createdEvents = eventsAfterConsume.filter(
        (event) => event.eventType === "WorkspaceCreated",
      );
      const createdPayload = createdEvents[1]?.payload as {
        workspaceId: WorkspaceId;
        parentWorkspaceId: WorkspaceId;
      };
      const childParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [createdPayload.workspaceId],
      );
      const rootParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [ROOT],
      );
      const countsAfterConsume = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };

      yield* runConsume;
      const countsAfterReplayConsume = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };

      return {
        proposeOutcome,
        record,
        govOutcome,
        afterProposeEventTypes,
        afterProposeInbox,
        modify,
        modified,
        stale,
        afterStaleEventTypes,
        afterStaleInbox,
        approve,
        approveReplay,
        afterApproveEvents,
        eventsAfterConsume,
        afterApproveWorkspaces,
        consumed,
        createdEvents,
        createdPayload,
        childParent,
        rootParent,
        countsAfterConsume,
        countsAfterReplayConsume,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.proposeOutcome._tag).toBe("Observation");
    expect(Option.isSome(result.record)).toBe(true);
    if (Option.isSome(result.record)) {
      expect(result.record.value.state).toBe("Pending");
      expect(result.record.value.revision).toBe(1);
      expect(result.record.value.parentWorkspaceId).toBe(ROOT);
      expect(result.record.value.proposal.name).toBe("child-integration");
    }

    expect(result.govOutcome._tag).toBe("Observation");
    expect(
      result.afterProposeEventTypes.filter((t) => t === "WorkspaceCreated"),
    ).toHaveLength(1);
    expect(result.afterProposeInbox).toHaveLength(1);
    expect(result.afterProposeInbox[0]?.kind).toBe("Governance");
    expect(result.afterProposeInbox[0]?.entryKey).toBe(
      `gov:${(Option.getOrThrow(result.record) as FormationProposalRecord).proposalId}:1`,
    );

    expect(result.modify.resolution._tag).toBe("Committed");
    expect(Option.isSome(result.modified)).toBe(true);
    if (Option.isSome(result.modified)) {
      expect(result.modified.value.state).toBe("Pending");
      expect(result.modified.value.revision).toBe(2);
      expect(result.modified.value.proposal.name).toBe("child-integration-v2");
    }

    expect(result.stale.resolution._tag).toBe("TerminalRejected");
    if (result.stale.resolution._tag === "TerminalRejected") {
      expect(result.stale.resolution.error._tag).toBe("RevisionConflict");
    }
    expect(
      result.afterStaleEventTypes.filter((t) => t === "DecisionRecorded"),
    ).toHaveLength(1);
    expect(result.afterStaleInbox).toHaveLength(2);

    expect(result.approve.resolution._tag).toBe("Committed");
    if (result.approve.resolution._tag === "Committed") {
      expect(result.approve.resolution.result.proposalRevision).toBe(2);
    }
    expect(result.approveReplay).toEqual(result.approve);
    const approveFact = result.afterApproveEvents.find(
      (event) =>
        event.eventType === "DecisionRecorded" &&
        (event.payload as { decision: string }).decision === "Approve",
    );
    expect(approveFact?.payload).toEqual(
      expect.objectContaining({ proposalRevision: 2 }),
    );
    expect(result.afterApproveWorkspaces).toBe(1);
    expect(
      result.afterApproveEvents.filter(
        (event) => event.eventType === "WorkspaceCreated",
      ),
    ).toHaveLength(1);

    expect(result.consumed).toEqual(["CreateChildWorkspace", "AssignWork"]);
    expect(result.createdEvents).toHaveLength(2);
    expect(result.createdPayload.parentWorkspaceId).toBe(ROOT);
    expect(result.childParent).toBe(ROOT);
    expect(result.rootParent).toBeNull();
    expect(result.countsAfterConsume).toEqual({
      workspaces: 2,
      works: 1,
      sessions: 2,
    });
    expect(result.countsAfterReplayConsume).toEqual(result.countsAfterConsume);
    expect(
      result.eventsAfterConsume.some(
        (event) => event.eventType === "WorkAssigned",
      ),
    ).toBe(true);
  });

  it("Story B: deep autonomous formation is gate-free and ceiling-guarded", async () => {
    const CHILD_B_STORY = ws("b1");
    const CHILD_B_STORY_SESSION = ses("b1");
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_B_STORY,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_STORY_SESSION,
        },
        {
          workspaceId: CHILD_B1,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B1_SESSION,
        },
      ]);

      const handler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const outcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("grandchild-deep"),
        },
        execution: executionOf(EXE_CHILD, CHILD_B_STORY),
        context: executionContext(EXE_CHILD),
      });
      const grandchildId = parse(WorkspaceId)(
        outcome._tag === "Observation"
          ? (idFromText(outcome.observation.text, "ws_") ?? "")
          : "",
      );
      const grandchildParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [grandchildId],
      );
      const childParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [CHILD_B_STORY],
      );
      const directCounts = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        proposals: yield* countRows("formation_proposals"),
      };
      const childInbox = yield* inboxOf(CHILD_B_STORY);

      const ceilingOutcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("grandchild-escape", [
            { _tag: "FileTree", path: "outside/parent/boundary" },
          ]),
        },
        execution: executionOf(EXE_CHILD, CHILD_B_STORY),
        context: executionContext(EXE_CHILD),
      });
      const afterCeilingWorkspaces = yield* countRows("workspaces");
      const afterCeilingProposals = yield* countRows("formation_proposals");

      const gw = yield* CommandGateway;
      const forcedPayload = {
        parentWorkspaceId: CHILD_B1,
        workspaceId: FORCED_CHILD,
        primarySession: {
          sessionId: FORCED_SESSION,
          contextEpoch: parse(ContextEpochNumber)(0),
        },
        name: "sibling-forced-child",
        responsibilityDefinition: {
          purpose: "p",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: parse(ResponsibilityRevision)(1),
        resourceBoundary: {
          basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
          addresses: [],
        },
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        agentBinding: responsibilityBound(FORCED_CHILD),
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
      };
      const siblingReceipt = yield* gw.execute(
        {
          commandType: "CreateChildWorkspace",
          commandId: SIBLING_CREATE_COMMAND,
          projectId: PROJECT,
          actor: PRINCIPAL as never,
          issuedAt: "t",
          payload: forcedPayload,
        },
        executionContext(EXE_CHILD),
        {
          _tag: "CreateChildWorkspaceAuthority",
          principal: PRINCIPAL,
          commandId: SIBLING_CREATE_COMMAND,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "CreateChildWorkspace",
            projectId: PROJECT,
            actor: PRINCIPAL as never,
            schemaVersion: "1",
            payload: forcedPayload,
          }),
          projectId: PROJECT,
          parentWorkspaceId: CHILD_B_STORY,
        },
      );
      const afterSiblingWorkspaces = yield* countRows("workspaces");

      return {
        outcome,
        grandchildParent,
        childParent,
        childId: CHILD_B_STORY,
        directCounts,
        childInbox,
        ceilingOutcome,
        afterCeilingWorkspaces,
        afterCeilingProposals,
        siblingReceipt,
        afterSiblingWorkspaces,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.outcome._tag).toBe("Observation");
    expect(result.childParent).toBe(ROOT);
    expect(result.grandchildParent).toBe(result.childId);
    expect(result.directCounts).toEqual({
      workspaces: 4,
      works: 1,
      proposals: 0,
    });
    expect(result.childInbox).toHaveLength(0);

    expect(result.ceilingOutcome._tag).toBe("Observation");
    if (result.ceilingOutcome._tag === "Observation") {
      expect(result.ceilingOutcome.observation.text).toContain(
        "AuthorityDenied",
      );
      expect(result.ceilingOutcome.observation.text).toContain(
        "escapes parent boundary",
      );
    }
    expect(result.afterCeilingWorkspaces).toBe(4);
    expect(result.afterCeilingProposals).toBe(0);

    expect(result.siblingReceipt.resolution._tag).toBe("TerminalRejected");
    if (result.siblingReceipt.resolution._tag === "TerminalRejected") {
      expect(result.siblingReceipt.resolution.error._tag).toBe(
        "AuthorityDenied",
      );
      if (result.siblingReceipt.resolution.error._tag === "AuthorityDenied") {
        expect(result.siblingReceipt.resolution.error.reason).toContain(
          "target mismatch",
        );
      }
    }
    expect(result.afterSiblingWorkspaces).toBe(4);
  });

  it("Story C: specialist spawn, settlement dedup, parent session zero-write (D3)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* seedProject;
      const admitted = yield* admitMain({
        commandId: MAIN_ADMIT_C,
        executionId: EXE_MAIN_C,
        workspaceId: ROOT,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const spawnHandler = makeSpawnSpecialistHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const spawnOutcome = yield* spawnHandler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: {
            mission: "scan the integration slice",
            constraints: [],
            skillIds: [],
          },
        },
        execution: executionOf(EXE_MAIN_C, ROOT),
        context: executionContext(EXE_MAIN_C),
      });
      const specialistId = parse(ExecutionId)(
        spawnOutcome._tag === "Observation"
          ? (idFromText(spawnOutcome.observation.text, "exe_") ?? "")
          : "",
      );
      const boundedExecutions = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );
      const scopedSessions = yield* countRows(
        "sessions",
        "WHERE binding_kind = 'ExecutionScoped'",
      );

      const sessionsBefore = yield* countRows("sessions");
      const inbox = yield* InboxProjectionStore;
      const tx = yield* TransactionPort;
      const settlement: ExecutionSettlement = {
        _tag: "Completed",
        result: {
          _tag: "CompletionClaimed",
          workRevision: parse(WorkRevision)(1),
          claimRef: "claim://specialist/1",
        },
      };
      const firstAdmission = yield* tx.transact(
        admitSpecialistSettlement(
          {
            specialistExecutionId: specialistId,
            parentWorkspaceId: ROOT,
            settlement,
            summary: "specialist finished the slice",
            occurredAt: "t",
          },
          { inbox },
        ),
      );
      const replayAdmission = yield* tx.transact(
        admitSpecialistSettlement(
          {
            specialistExecutionId: specialistId,
            parentWorkspaceId: ROOT,
            settlement,
            summary: "specialist finished the slice (replayed)",
            occurredAt: "t2",
          },
          { inbox },
        ),
      );
      const sessionsAfter = yield* countRows("sessions");
      const parentInbox = yield* inboxOf(ROOT);
      const expectedKey = specialistSettlementEntryKey(
        specialistId,
        settlementFingerprint(settlement),
      );

      const quiescenceOutcome = yield* spawnHandler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: {
            mission: "too late to spawn",
            constraints: [],
            skillIds: [],
          },
        },
        execution: executionOf(EXE_MAIN_C, ROOT, "2026-09-21T00:00:00.000Z"),
        context: executionContext(EXE_MAIN_C),
      });
      const boundedAfterQuiescence = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );

      return {
        spawnOutcome,
        specialistId,
        boundedExecutions,
        scopedSessions,
        firstAdmission,
        replayAdmission,
        sessionsBefore,
        sessionsAfter,
        parentInbox,
        expectedKey,
        quiescenceOutcome,
        boundedAfterQuiescence,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.spawnOutcome._tag).toBe("Observation");
    if (result.spawnOutcome._tag === "Observation") {
      expect(result.spawnOutcome.observation.text).toContain(
        "specialist admitted",
      );
    }
    expect(result.boundedExecutions).toBe(1);
    expect(result.scopedSessions).toBe(1);

    expect(result.firstAdmission.deduplicated).toBe(false);
    expect(result.firstAdmission.wakeReason).toEqual({ _tag: "InputArrived" });
    expect(result.firstAdmission.entryKey).toBe(result.expectedKey);
    expect(result.replayAdmission.deduplicated).toBe(true);
    expect(result.replayAdmission.entryKey).toBe(result.expectedKey);
    expect(result.parentInbox).toHaveLength(1);
    expect(result.parentInbox[0]?.kind).toBe("SpecialistSettled");
    expect(result.parentInbox[0]?.entryKey).toBe(result.expectedKey);
    expect(result.sessionsAfter).toBe(result.sessionsBefore);

    expect(result.quiescenceOutcome._tag).toBe("Observation");
    if (result.quiescenceOutcome._tag === "Observation") {
      expect(result.quiescenceOutcome.observation.text).toContain("quiescence");
    }
    expect(result.boundedAfterQuiescence).toBe(1);
  });

  it("Story D: Report does not preempt, Reply closes correlation, illegal Query denied (D2)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_D,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_D_SESSION,
        },
        {
          workspaceId: GRANDCHILD_D,
          parentWorkspaceId: CHILD_D,
          sessionId: GRANDCHILD_D_SESSION,
        },
        {
          workspaceId: CHILD_B_D,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_D_SESSION,
        },
      ]);
      const admitted = yield* admitMain({
        commandId: PARENT_ADMIT_D,
        executionId: EXE_PARENT_D,
        workspaceId: CHILD_D,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const gw = yield* CommandGateway;
      const tx = yield* TransactionPort;
      const messages = yield* MessageStore;
      const inbox = yield* InboxProjectionStore;

      const executionsBefore = yield* countRows("executions");
      const turnsBefore = yield* countRows("provider_turns");
      const report = yield* submitSend(gw, {
        commandId: REPORT_COMMAND,
        payload: {
          messageId: REPORT_MSG,
          senderWorkspaceId: GRANDCHILD_D,
          message: {
            kind: "Report",
            recipientWorkspaceId: CHILD_D,
            bodyRef: "art-acceptance-report",
            correlationId: CORRELATION_D,
            urgency: "Normal",
          },
        },
      });
      const executionsAfterReport = yield* countRows("executions");
      const turnsAfterReport = yield* countRows("provider_turns");
      const dependencyEventsAfterReport = yield* countRows(
        "domain_events",
        "WHERE event_type LIKE 'Dependency%'",
      );
      const parentInboxAfterReport = yield* inboxOf(CHILD_D);

      const consumed = yield* tx.transact(
        consumeInboxEntry(
          {
            workspaceId: CHILD_D,
            entryKey: `msg:${REPORT_MSG}`,
            now: "t",
          },
          { inbox },
        ),
      );
      const reply = yield* submitSend(gw, {
        commandId: REPLY_COMMAND,
        payload: {
          messageId: REPLY_MSG,
          senderWorkspaceId: CHILD_D,
          message: {
            kind: "Reply",
            recipientWorkspaceId: GRANDCHILD_D,
            bodyRef: "art-acceptance-reply",
            correlationId: CORRELATION_D,
            causationId: REPORT_MSG,
            urgency: "Normal",
          },
        },
      });
      const correlationClosed = yield* tx.transact(
        messages.isCorrelationClosed(CORRELATION_D),
      );

      const illegalQuery = yield* submitSend(gw, {
        commandId: ILLEGAL_QUERY_COMMAND,
        payload: {
          messageId: ILLEGAL_QUERY_MSG,
          senderWorkspaceId: GRANDCHILD_D,
          message: {
            kind: "Query",
            recipientWorkspaceId: CHILD_B_D,
            bodyRef: "art-acceptance-illegal-query",
            urgency: "Normal",
          },
        },
      });

      return {
        report,
        executionsBefore,
        executionsAfterReport,
        turnsBefore,
        turnsAfterReport,
        dependencyEventsAfterReport,
        parentInboxAfterReport,
        consumed,
        reply,
        correlationClosed,
        illegalQuery,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.report.resolution._tag).toBe("Committed");
    if (result.report.resolution._tag === "Committed") {
      expect(result.report.resolution.result.promotion).toEqual({
        closesCorrelation: null,
        triggersReevaluation: false,
      });
    }
    expect(result.executionsAfterReport).toBe(result.executionsBefore);
    expect(result.turnsAfterReport).toBe(result.turnsBefore);
    expect(result.dependencyEventsAfterReport).toBe(0);
    expect(result.parentInboxAfterReport).toHaveLength(1);
    expect(result.parentInboxAfterReport[0]?.kind).toBe("Message");
    expect(result.parentInboxAfterReport[0]?.entryKey).toBe(
      `msg:${REPORT_MSG}`,
    );

    expect(result.consumed.consumed?.entryKey).toBe(`msg:${REPORT_MSG}`);

    expect(result.reply.resolution._tag).toBe("Committed");
    if (result.reply.resolution._tag === "Committed") {
      expect(result.reply.resolution.result.promotion.closesCorrelation).toBe(
        CORRELATION_D,
      );
      expect(
        result.reply.resolution.result.promotion.triggersReevaluation,
      ).toBe(false);
    }
    expect(result.correlationClosed).toBe(true);

    expect(result.illegalQuery.resolution._tag).toBe("TerminalRejected");
    if (result.illegalQuery.resolution._tag === "TerminalRejected") {
      expect(result.illegalQuery.resolution.error._tag).toBe("AuthorityDenied");
      if (result.illegalQuery.resolution.error._tag === "AuthorityDenied") {
        expect(result.illegalQuery.resolution.error.reason).toContain(
          "ancestor",
        );
      }
    }
  });

  it("Story E: Normal steer never interrupts; Critical steer stops atomically", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_E,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_E_SESSION,
        },
        {
          workspaceId: CHILD_B_E,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_E_SESSION,
        },
      ]);

      const gw = yield* CommandGateway;
      const assignPayload = {
        workId: WORK_E,
        workspaceId: CHILD_E,
        expectedWorkspaceRevision: parse(Revision)(0),
        objective: "ship the acceptance slice",
        why: "P6-014",
        constraints: [],
        completionExpectation: "green",
        verificationMission: {
          goal: "g",
          criteria: [],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "initial" },
        revision: parse(WorkRevision)(0),
      };
      const assigned = yield* gw.execute(
        {
          commandType: "AssignWork",
          commandId: ASSIGN_E,
          projectId: PROJECT,
          actor: ACTOR,
          issuedAt: "t",
          payload: assignPayload,
        },
        { _tag: "External", principal: PRINCIPAL },
        {
          _tag: "AssignWorkAuthority",
          principal: PRINCIPAL,
          commandId: ASSIGN_E,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AssignWork",
            projectId: PROJECT,
            actor: ACTOR,
            schemaVersion: "1",
            payload: assignPayload,
          }),
          projectId: PROJECT,
          targetWorkspaceId: CHILD_E,
        },
      );
      expect(assigned.resolution._tag).toBe("Committed");

      const admitted = yield* admitMain({
        commandId: ADMIT_E,
        executionId: EXE_MAIN_E,
        workspaceId: CHILD_E,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const steerPayload = (
        overrides: Partial<SteerWorkPayload> = {},
      ): SteerWorkPayload => ({
        workId: WORK_E,
        workspaceId: CHILD_E,
        steer: {
          severity: "Normal",
          guidance: "cnt-acceptance-guidance-001",
        },
        expectedWorkRevision: parse(WorkRevision)(0),
        provenance: { source: "HumanInput" as const },
        ...overrides,
      });

      const tx = yield* TransactionPort;
      const normal = yield* submitSteer(gw, {
        commandId: NORMAL_STEER_E,
        payload: steerPayload(),
      });
      const workAfterNormal = yield* scalar<string>(
        "SELECT lifecycle AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const workRevisionAfterNormal = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const steeredEventsAfterNormal = yield* countRows(
        "domain_events",
        "WHERE event_type = 'WorkSteered'",
      );
      const stopEventsAfterNormal = yield* countRows(
        "domain_events",
        "WHERE event_type = 'ExecutionStopRequested'",
      );
      const executionAfterNormal = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );
      const inboxAfterNormal = yield* inboxOf(CHILD_E);

      const sibling = yield* submitSteer(gw, {
        commandId: SIBLING_STEER_E,
        payload: steerPayload(),
        authorityTargetWorkspaceId: CHILD_B_E,
      });

      const handlers = yield* steerHandlers;
      const staleOutcome = yield* tx
        .transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: STALE_STEER_E,
              stopCommandId: STALE_STOP_E,
              payload: steerPayload({
                steer: {
                  severity: "Critical",
                  guidance: "cnt-acceptance-guidance-stale",
                },
                expectedWorkRevision: parse(WorkRevision)(9),
              }),
              executionId: EXE_MAIN_E,
            }),
          ),
        )
        .pipe(
          Effect.catchTag("CriticalSteerRejected", (failure) =>
            Effect.succeed(failure),
          ),
        );
      const workRevisionAfterStale = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const executionAfterStale = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );
      const inboxAfterStale = yield* inboxOf(CHILD_E);

      const criticalOutcome = yield* tx.transact(
        submitCriticalSteer(
          criticalSteerSubmission(handlers, {
            steerCommandId: CRITICAL_STEER_E,
            stopCommandId: CRITICAL_STOP_E,
            payload: steerPayload({
              steer: {
                severity: "Critical",
                guidance: "cnt-acceptance-guidance-002",
              },
              expectedWorkRevision: parse(WorkRevision)(1),
            }),
            executionId: EXE_MAIN_E,
          }),
        ),
      );
      const workLifecycleAfterCritical = yield* scalar<string>(
        "SELECT lifecycle AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const workRevisionAfterCritical = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const executionAfterCritical = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );

      return {
        normal,
        workAfterNormal,
        workRevisionAfterNormal,
        steeredEventsAfterNormal,
        stopEventsAfterNormal,
        executionAfterNormal,
        inboxAfterNormal,
        sibling,
        staleOutcome,
        workRevisionAfterStale,
        executionAfterStale,
        inboxAfterStale,
        criticalOutcome,
        workLifecycleAfterCritical,
        workRevisionAfterCritical,
        executionAfterCritical,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.normal.resolution._tag).toBe("Committed");
    expect(result.workAfterNormal).toBe("Open");
    expect(result.workRevisionAfterNormal).toBe(1);
    expect(result.steeredEventsAfterNormal).toBe(1);
    expect(result.stopEventsAfterNormal).toBe(0);
    expect(result.executionAfterNormal).toBeNull();
    expect(result.inboxAfterNormal).toHaveLength(1);
    expect(result.inboxAfterNormal[0]?.kind).toBe("HumanInput");
    expect(result.inboxAfterNormal[0]?.entryKey).toBe(`steer:${WORK_E}:1`);

    expect(result.sibling.resolution._tag).toBe("TerminalRejected");
    if (result.sibling.resolution._tag === "TerminalRejected") {
      expect(result.sibling.resolution.error._tag).toBe("AuthorityDenied");
    }

    expect(result.staleOutcome._tag).toBe("CriticalSteerRejected");
    if (result.staleOutcome._tag === "CriticalSteerRejected") {
      expect(result.staleOutcome.stage).toBe("SteerWork");
      expect(result.staleOutcome.rejection._tag).toBe("RevisionConflict");
    }
    expect(result.workRevisionAfterStale).toBe(1);
    expect(result.executionAfterStale).toBeNull();
    expect(result.inboxAfterStale).toHaveLength(1);

    expect(result.criticalOutcome._tag).toBe("CriticalSteerCommitted");
    if (result.criticalOutcome._tag === "CriticalSteerCommitted") {
      expect(result.criticalOutcome.steer.result.severity).toBe("Critical");
      expect(result.criticalOutcome.steer.result.fromRevision).toBe(1);
      expect(result.criticalOutcome.steer.result.toRevision).toBe(2);
      expect(result.criticalOutcome.steer.events).toHaveLength(1);
      expect(result.criticalOutcome.steer.events[0]?.eventType).toBe(
        "WorkSteered",
      );
      expect(result.criticalOutcome.stop.result.stopRequestedAt).toBe("t");
      expect(result.criticalOutcome.stop.events).toHaveLength(1);
      expect(result.criticalOutcome.stop.events[0]?.eventType).toBe(
        "ExecutionStopRequested",
      );
    }
    expect(result.workLifecycleAfterCritical).toBe("Open");
    expect(result.workRevisionAfterCritical).toBe(2);
    expect(result.executionAfterCritical).toBe("t");
  });

  it("Story F: prompt program version discipline (D4)", async () => {
    // P8-010: the shared registry now also hosts the P8 program families;
    // this story stays scoped to the four P6 families.
    const results = (await Effect.runPromise(evalAllPrograms())).filter(
      (result) => result.familyId.startsWith("p6-"),
    );
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.missingClauses).toEqual([]);
      expect(result.presentForbidden).toEqual([]);
      expect(result.versionGate).toBe(true);
      expect(result.hashMatches).toBe(true);
    }

    for (const entry of PROGRAM_REGISTRY.filter((candidate) =>
      candidate.familyId.startsWith("p6-"),
    )) {
      const program = await Effect.runPromise(loadProgram(entry.familyId));
      expect(program.meta.familyId).toBe(entry.familyId);
      expect(program.meta.contractRevision).toBe("P6-05@1");
      expect(program.meta.textVersion).toBe(entry.textVersion);
      expect(program.meta.textHash).toMatch(/^[0-9a-f]{64}$/);
      const fileContent = readFileSync(programFilePath(entry), "utf8");
      expect(fileContent).toMatch(/^contractRevision:/m);
      expect(fileContent).toMatch(/^textVersion:/m);
      expect(fileContent).toMatch(/^textHash:/m);
    }

    const gate = await Effect.runPromise(assertProgramGate());
    expect(gate.passed).toBe(true);
    expect(
      gate.results.filter((r) => r.familyId.startsWith("p6-")),
    ).toHaveLength(4);

    const formation = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p6-formation",
    ) as ProgramRegistryEntry;
    const bumped: ProgramRegistryEntry = {
      ...formation,
      textVersion: formation.textVersion + 1,
    };
    const bumpedResult = evaluateProgramContent(
      bumped,
      readFileSync(programFilePath(formation), "utf8"),
    );
    expect(bumpedResult.versionGate).toBe(false);
    expect(bumpedResult.passed).toBe(false);

    const communication = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p6-communication",
    ) as ProgramRegistryEntry;
    const tampered = readFileSync(programFilePath(communication), "utf8")
      .split("\n")
      .filter((line) => !line.includes("A Report is not a delivery"))
      .join("\n");
    const tamperedResult = evaluateProgramContent(communication, tampered);
    expect(tamperedResult.missingClauses).toContain(
      "A Report is not a delivery",
    );
    expect(tamperedResult.passed).toBe(false);
  });
});
