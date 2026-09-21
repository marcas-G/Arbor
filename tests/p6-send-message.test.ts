import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
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
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeSendMessageHandler,
  type SendMessagePayload,
  type SendMessageResult,
  sendMessagePlan,
} from "../packages/application/src/commands/send-message.js";
import {
  CommandGateway,
  type CommandGatewayError,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  type CommandRejection,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  CommandId,
  type CommandReceipt,
  MessageId,
  type OutboundMessage,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  InboxProjectionStore,
  MessageStore,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
} from "./support/p6-app.js";

const CHILD = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789d2");
const GRANDCHILD = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const OTHER_PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c4",
);
const OTHER_ROOT = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f4",
);
const unknownWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
);
const CORRELATION = "corr-p6-009-001";

const msg = (suffix: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

const reportMessageId = msg("a1");
const queryMessageId = msg("a2");
const replyMessageId = msg("a3");
const decisionMessageId = msg("a4");
const reportCommandId = cmd("b1");
const queryCommandId = cmd("b2");
const replyCommandId = cmd("b3");
const decisionCommandId = cmd("b4");
const rejectCommandIds = ["e1", "e2", "e3", "e4", "e5", "e6"].map((suffix) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`),
) as ReadonlyArray<CommandId>;

const SendRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | MessageStore
  | InboxProjectionStore
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const messages = yield* MessageStore;
    const inbox = yield* InboxProjectionStore;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      makeSendMessageHandler({
        workspaces,
        messages,
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

/** Self-contained SendMessage harness (p6-app.ts assembly copied; that file is
 * frozen for this task). Fixed clock keeps replayed receipts byte-identical. */
const makeSendApp = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | MessageStore
  | InboxProjectionStore
  | WorkspaceRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const registry = Layer.provide(
    SendRegistryLive,
    Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
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
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | MessageStore
    | InboxProjectionStore
    | WorkspaceRepository
  >;
};

const runSend = <A, R>(
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

const workspaceRow = (
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  parentWorkspaceId: WorkspaceId | null,
  sessionId: string,
) => [
  workspaceId,
  projectId,
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

/** Three-layer lineage (root → child → grandchild) plus a second project for
 * the cross-project rejection. One transaction: workspace→session and
 * project→workspace FKs are DEFERRABLE; sessions has no updated_at column. */
const seedLineage = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        workspaceRow(
          CHILD,
          p6Project,
          p6RootWorkspace,
          "ses_018f2b3c-4d5e-7abc-8def-0123456789d2",
        ),
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [
          "ses_018f2b3c-4d5e-7abc-8def-0123456789d2",
          "WorkspacePrimary",
          CHILD,
          null,
          0,
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        workspaceRow(
          GRANDCHILD,
          p6Project,
          CHILD,
          "ses_018f2b3c-4d5e-7abc-8def-0123456789e3",
        ),
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [
          "ses_018f2b3c-4d5e-7abc-8def-0123456789e3",
          "WorkspacePrimary",
          GRANDCHILD,
          null,
          0,
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          OTHER_PROJECT,
          "other",
          OTHER_ROOT,
          JSON.stringify({}),
          0,
          JSON.stringify({}),
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        workspaceRow(
          OTHER_ROOT,
          OTHER_PROJECT,
          null,
          "ses_018f2b3c-4d5e-7abc-8def-0123456789f4",
        ),
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [
          "ses_018f2b3c-4d5e-7abc-8def-0123456789f4",
          "WorkspacePrimary",
          OTHER_ROOT,
          null,
          0,
          "t",
        ],
      );
    }),
  );
});

const seed = Effect.gen(function* () {
  yield* runMigrations(P6_MIGRATIONS);
  yield* p6SeedProject;
  yield* seedLineage;
});

const payloadOf = (
  messageId: MessageId,
  senderWorkspaceId: WorkspaceId,
  message: OutboundMessage,
): SendMessagePayload => ({
  messageId,
  senderWorkspaceId,
  message,
});

/** Submits via the Communicate directive factory (`sendMessagePlan`): the
 * authority fingerprint is computed over the exact payload the envelope
 * carries, so any drift would surface as AuthorityDenied. */
const submitSend = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: SendMessagePayload;
  },
): Effect.Effect<
  CommandReceipt<SendMessageResult, CommandRejection>,
  CommandGatewayError
> => {
  const plan = sendMessagePlan({
    messageId: args.payload.messageId,
    commandId: args.commandId,
    projectId: p6Project,
    senderWorkspaceId: args.payload.senderWorkspaceId,
    principal: p6TestPrincipal,
    actor: p6TestActor,
    message: args.payload.message,
  });
  const envelope: GatewayEnvelope<SendMessagePayload> = {
    commandType: "SendMessage",
    commandId: args.commandId,
    projectId: p6Project,
    actor: p6TestActor,
    issuedAt: "t",
    payload: args.payload,
  };
  return gw.execute(
    envelope,
    { _tag: "External", principal: p6TestPrincipal },
    plan.authority,
  );
};

const sentEventPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ payload_json: string }>(
    "SELECT payload_json FROM domain_events WHERE event_type = 'MessageSent'",
  );
  return rows.map(
    (row) => JSON.parse(row.payload_json) as Record<string, unknown>,
  );
});

const dependencyEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type LIKE 'Dependency%'",
  );
  return Number(rows[0]?.count ?? 0);
});

const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

const storedMessage = (messageId: MessageId) =>
  Effect.gen(function* () {
    const messages = yield* MessageStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(messages.findById(messageId));
  });

const correlationClosed = Effect.gen(function* () {
  const messages = yield* MessageStore;
  const tx = yield* TransactionPort;
  return yield* tx.transact(messages.isCorrelationClosed(CORRELATION));
});

const correlationMessageCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM messages WHERE correlation_id = ?",
    [CORRELATION],
  );
  return Number(rows[0]?.count ?? 0);
});

describe("p6-send-message", () => {
  it("Report to parent commits: MessageSent event, MessageStore row, exactly one Inbox entry, zero Dependency events (D2)", async () => {
    const payload = payloadOf(reportMessageId, GRANDCHILD, {
      kind: "Report",
      recipientWorkspaceId: CHILD,
      bodyRef: "art-report-body-001",
      urgency: "Normal",
    });
    const program = Effect.gen(function* () {
      yield* seed;
      const gw = yield* CommandGateway;
      const receipt = yield* submitSend(gw, {
        commandId: reportCommandId,
        payload,
      });
      return {
        receipt,
        events: yield* sentEventPayloads,
        stored: yield* storedMessage(reportMessageId),
        entries: yield* inboxOf(CHILD),
        dependencyEvents: yield* dependencyEventCount,
      };
    });
    const result = await runSend(program, makeSendApp());
    expect(result.receipt.resolution._tag).toBe("Committed");
    if (result.receipt.resolution._tag === "Committed") {
      expect(result.receipt.resolution.result).toEqual({
        messageId: reportMessageId,
        admitted: true,
        promotion: { closesCorrelation: null, triggersReevaluation: false },
      });
      expect(result.receipt.semanticRequestFingerprint).toBe(
        semanticRequestFingerprint({
          commandType: "SendMessage",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "1",
          payload,
        }),
      );
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      messageId: reportMessageId,
      kind: "Report",
      sender: GRANDCHILD,
      recipient: CHILD,
      correlationId: null,
      causationId: null,
    });
    expect(Option.isSome(result.stored)).toBe(true);
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.senderWorkspaceId).toBe(GRANDCHILD);
      expect(result.stored.value.message.kind).toBe("Report");
      expect(result.stored.value.message.recipientWorkspaceId).toBe(CHILD);
    }
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entryKey).toBe(`msg:${reportMessageId}`);
    expect(result.entries[0]?.kind).toBe("Message");
    expect(result.entries[0]?.summary).toContain("Report");
    expect(result.entries[0]?.summary).toContain(GRANDCHILD);
    expect(result.dependencyEvents).toBe(0);
  });

  it("rejects the frozen rejection table (02 §3)", async () => {
    const program = Effect.gen(function* () {
      yield* seed;
      const gw = yield* CommandGateway;
      const notFound = yield* submitSend(gw, {
        commandId: rejectCommandIds[0]!,
        payload: payloadOf(msg("f1"), GRANDCHILD, {
          kind: "Report",
          recipientWorkspaceId: unknownWorkspace,
          bodyRef: "art-x",
          urgency: "Normal",
        }),
      });
      const crossProject = yield* submitSend(gw, {
        commandId: rejectCommandIds[1]!,
        payload: payloadOf(msg("f2"), GRANDCHILD, {
          kind: "Report",
          recipientWorkspaceId: OTHER_ROOT,
          bodyRef: "art-x",
          urgency: "Normal",
        }),
      });
      const queryNonAncestor = yield* submitSend(gw, {
        commandId: rejectCommandIds[2]!,
        payload: payloadOf(msg("f3"), CHILD, {
          kind: "Query",
          recipientWorkspaceId: GRANDCHILD,
          bodyRef: "art-x",
          urgency: "Normal",
        }),
      });
      const reportNonParent = yield* submitSend(gw, {
        commandId: rejectCommandIds[3]!,
        payload: payloadOf(msg("f4"), GRANDCHILD, {
          kind: "Report",
          recipientWorkspaceId: p6RootWorkspace,
          bodyRef: "art-x",
          urgency: "Normal",
        }),
      });
      const replyWithoutCorrelation = yield* submitSend(gw, {
        commandId: rejectCommandIds[4]!,
        payload: payloadOf(msg("f5"), CHILD, {
          kind: "Reply",
          recipientWorkspaceId: p6RootWorkspace,
          bodyRef: "art-x",
          urgency: "Normal",
        }),
      });
      const quota = yield* submitSend(gw, {
        commandId: rejectCommandIds[5]!,
        payload: payloadOf(msg("f6"), GRANDCHILD, {
          kind: "Report",
          recipientWorkspaceId: CHILD,
          bodyRef: "x".repeat(4097),
          urgency: "Normal",
        }),
      });
      return {
        notFound,
        crossProject,
        queryNonAncestor,
        reportNonParent,
        replyWithoutCorrelation,
        quota,
      };
    });
    const result = await runSend(program, makeSendApp());
    const rejectedTags: ReadonlyArray<
      [
        keyof typeof result,
        "WorkspaceNotFound" | "AuthorityDenied" | "ResourceExhausted",
      ]
    > = [
      ["notFound", "WorkspaceNotFound"],
      ["crossProject", "AuthorityDenied"],
      ["queryNonAncestor", "AuthorityDenied"],
      ["reportNonParent", "AuthorityDenied"],
      ["replyWithoutCorrelation", "AuthorityDenied"],
      ["quota", "ResourceExhausted"],
    ];
    for (const [key, tag] of rejectedTags) {
      const receipt = result[key];
      expect(receipt.resolution._tag).toBe("TerminalRejected");
      if (receipt.resolution._tag === "TerminalRejected") {
        expect(receipt.resolution.error._tag).toBe(tag);
      }
    }
  });

  it("Query→Reply closes the correlation; replayed Reply is idempotent; DecisionRequest flags reevaluation only", async () => {
    const queryPayload = payloadOf(queryMessageId, GRANDCHILD, {
      kind: "Query",
      recipientWorkspaceId: p6RootWorkspace,
      bodyRef: "art-query-001",
      correlationId: CORRELATION,
      urgency: "Normal",
    });
    const replyPayload = payloadOf(replyMessageId, p6RootWorkspace, {
      kind: "Reply",
      recipientWorkspaceId: GRANDCHILD,
      bodyRef: "art-reply-001",
      correlationId: CORRELATION,
      causationId: queryMessageId,
      urgency: "Normal",
    });
    const decisionPayload = payloadOf(decisionMessageId, CHILD, {
      kind: "DecisionRequest",
      recipientWorkspaceId: p6RootWorkspace,
      bodyRef: "art-decision-001",
      urgency: "Normal",
    });
    const program = Effect.gen(function* () {
      yield* seed;
      const gw = yield* CommandGateway;
      const query = yield* submitSend(gw, {
        commandId: queryCommandId,
        payload: queryPayload,
      });
      const closedAfterQuery = yield* correlationClosed;
      const reply = yield* submitSend(gw, {
        commandId: replyCommandId,
        payload: replyPayload,
      });
      const replay = yield* submitSend(gw, {
        commandId: replyCommandId,
        payload: replyPayload,
      });
      const decision = yield* submitSend(gw, {
        commandId: decisionCommandId,
        payload: decisionPayload,
      });
      const events = yield* sentEventPayloads;
      return {
        query,
        closedAfterQuery,
        reply,
        replay,
        decision,
        closed: yield* correlationClosed,
        correlationMessages: yield* correlationMessageCount,
        replyEvents: events.filter(
          (event) => event.messageId === replyMessageId,
        ),
        dependencyEvents: yield* dependencyEventCount,
        entries: yield* inboxOf(GRANDCHILD),
      };
    });
    const result = await runSend(program, makeSendApp());
    expect(result.query.resolution._tag).toBe("Committed");
    if (result.query.resolution._tag === "Committed") {
      expect(result.query.resolution.result.promotion).toEqual({
        closesCorrelation: null,
        triggersReevaluation: false,
      });
    }
    expect(result.closedAfterQuery).toBe(false);
    expect(result.reply.resolution._tag).toBe("Committed");
    if (result.reply.resolution._tag === "Committed") {
      expect(result.reply.resolution.result.promotion).toEqual({
        closesCorrelation: CORRELATION,
        triggersReevaluation: false,
      });
    }
    expect(result.replay).toEqual(result.reply);
    expect(result.closed).toBe(true);
    expect(result.correlationMessages).toBe(2);
    expect(result.replyEvents).toHaveLength(1);
    expect(result.decision.resolution._tag).toBe("Committed");
    if (result.decision.resolution._tag === "Committed") {
      expect(result.decision.resolution.result.promotion).toEqual({
        closesCorrelation: null,
        triggersReevaluation: true,
      });
    }
    expect(result.dependencyEvents).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entryKey).toBe(`msg:${replyMessageId}`);
  });
});
