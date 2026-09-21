import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { makeRequestGovernanceHandler } from "../apps/single-workspace/src/governance-directive.js";
import {
  type SendMessagePayload,
  type SendMessageResult,
  sendMessagePlan,
} from "../packages/application/src/commands/send-message.js";
import { consumeInboxEntry } from "../packages/application/src/inbox-consumption.js";
import {
  CommandGateway,
  type CommandGatewayError,
  type CommandGatewayService,
  type CommandRejection,
  type GatewayEnvelope,
  newUuid7,
} from "../packages/application/src/index.js";
import {
  admitFormationProposal,
  CommandId,
  type CommandReceipt,
  type Execution,
  ExecutionId,
  FormationProposalId,
  LeaseGeneration,
  MessageId,
  type ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import { FPR_1, minimalProposal } from "./harness/p6-fixtures.js";
import {
  makeP6App,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
  runP6,
} from "./support/p6-app.js";

const CHILD = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789d2");
const GRANDCHILD = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const UNKNOWN_PROPOSAL = parse(FormationProposalId)(
  "fpr_00000000-0000-7000-8000-0000000000ff",
);
const EXECUTION_ID = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const GOV_CORRELATION = "corr-p6-010-gov-001";

const msg = (suffix: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

const executionOf = (workspaceId: WorkspaceId): Execution => ({
  executionId: EXECUTION_ID,
  projectId: p6Project,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    focus: { _tag: "Coordination" as const },
  },
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789c1" as never,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
});

const executionContext = {
  _tag: "ExecutionOrigin" as const,
  principal: p6TestPrincipal,
  executionId: EXECUTION_ID,
  fencingGeneration: parse(LeaseGeneration)(0),
};

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

/** Three-layer lineage (root → child → grandchild), copied small from the
 * p6-send-message harness. One transaction: workspace→session and
 * project→workspace FKs are DEFERRABLE; sessions has no updated_at column. */
const seedLineage = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const [workspaceId, parent, sessionId] of [
        [CHILD, p6RootWorkspace, "ses_018f2b3c-4d5e-7abc-8def-0123456789d2"],
        [GRANDCHILD, CHILD, "ses_018f2b3c-4d5e-7abc-8def-0123456789e3"],
      ] as const) {
        yield* sql.unsafe(
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          workspaceRow(workspaceId, p6Project, parent, sessionId),
        );
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
          [sessionId, "WorkspacePrimary", workspaceId, null, 0, "t"],
        );
      }
    }),
  );
});

const seed = Effect.gen(function* () {
  yield* runMigrations(P6_MIGRATIONS);
  yield* p6SeedProject;
  yield* seedLineage;
});

const makeHandler = Effect.gen(function* () {
  return makeRequestGovernanceHandler({
    gateway: yield* CommandGateway,
    proposals: yield* FormationProposalStore,
    inbox: yield* InboxProjectionStore,
    tx: yield* TransactionPort,
    clock: yield* Clock,
    workspaces: yield* WorkspaceRepository,
    messages: yield* MessageStore,
  });
});

const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

const messageRows = (where = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM messages ${where}`,
    );
  }).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

const sentEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'MessageSent'",
  );
  return Number(rows[0]?.count ?? 0);
});

/** Copied small from the p6-send-message submit helper: submits via the
 * Communicate directive factory so any payload/authority drift surfaces as
 * AuthorityDenied. */
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

describe("p6-inbox-promotion", () => {
  it("consumption marks one entry, keeps the other unconsumed, and replays idempotently as null (SD §7.4)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P6_MIGRATIONS);
      const inbox = yield* InboxProjectionStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        inbox.admitUpsert({
          recipientWorkspaceId: p6RootWorkspace,
          entryKey: "msg:one",
          kind: "Message",
          summary: "first entry",
          admittedAt: "t",
        }),
      );
      yield* tx.transact(
        inbox.admitUpsert({
          recipientWorkspaceId: p6RootWorkspace,
          entryKey: "msg:two",
          kind: "Message",
          summary: "second entry",
          admittedAt: "t",
        }),
      );
      const first = yield* tx.transact(
        consumeInboxEntry(
          {
            workspaceId: p6RootWorkspace,
            entryKey: "msg:one",
            now: "2026-09-21T00:00:00.000Z",
          },
          { inbox },
        ),
      );
      const remaining = yield* tx.transact(
        inbox.listUnconsumed(p6RootWorkspace),
      );
      const replay = yield* tx.transact(
        consumeInboxEntry(
          {
            workspaceId: p6RootWorkspace,
            entryKey: "msg:one",
            now: "2026-09-21T00:00:01.000Z",
          },
          { inbox },
        ),
      );
      return { first, remaining, replay };
    });
    const result = await runP6(program, makeP6App());
    expect(result.first.consumed).not.toBeNull();
    expect(result.first.consumed?.entryKey).toBe("msg:one");
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0]?.entryKey).toBe("msg:two");
    expect(result.replay.consumed).toBeNull();
  });

  it("FormationApproval routes a Governance Inbox reference to the proposing parent workspace (02 §6, 01 §4.2)", async () => {
    const program = Effect.gen(function* () {
      yield* seed;
      const proposals = yield* FormationProposalStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        proposals.insert(
          admitFormationProposal({
            proposalId: FPR_1,
            parentWorkspaceId: p6RootWorkspace,
            proposal: minimalProposal(),
          }),
        ),
      );
      const handler = yield* makeHandler;
      const outcome = yield* handler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "FormationApproval",
            proposalId: FPR_1,
            proposalRevision: 1,
          },
        },
        execution: executionOf(p6RootWorkspace),
        context: executionContext,
      });
      return { outcome, entries: yield* inboxOf(p6RootWorkspace) };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain(
        "awaiting human decision",
      );
    }
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.kind).toBe("Governance");
    expect(entry?.entryKey).toBe(`gov:${FPR_1}:1`);
    expect(entry?.summary).toContain("child-1");
    expect(entry?.summary).toContain("revision 1");
  });

  it("FormationApproval for an unknown proposal is a no-op observation", async () => {
    const program = Effect.gen(function* () {
      yield* seed;
      const handler = yield* makeHandler;
      const outcome = yield* handler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "FormationApproval",
            proposalId: UNKNOWN_PROPOSAL,
            proposalRevision: 1,
          },
        },
        execution: executionOf(p6RootWorkspace),
        context: executionContext,
      });
      return { outcome, entries: yield* inboxOf(p6RootWorkspace) };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("unknown proposal");
      expect(result.outcome.observation.text).toContain("no-op");
    }
    expect(result.entries).toHaveLength(0);
  });

  it("DecisionRequest from a child routes SendMessage to the parent: Inbox entry, MessageStore row, MessageSent event", async () => {
    const question = "should we split the storage slice?";
    const program = Effect.gen(function* () {
      yield* seed;
      const handler = yield* makeHandler;
      const outcome = yield* handler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "DecisionRequest",
            question,
            correlationId: GOV_CORRELATION,
          },
        },
        execution: executionOf(CHILD),
        context: executionContext,
      });
      const messages = yield* MessageStore;
      const tx = yield* TransactionPort;
      // Same deterministic id derivation as the handler (DID G5).
      const messageId = parse(MessageId)(
        `msg_${newUuid7("gov-decision-message", `${EXECUTION_ID}:${GOV_CORRELATION}:${question}`)}`,
      );
      const stored = yield* tx.transact(messages.findById(messageId));
      return {
        outcome,
        entries: yield* inboxOf(p6RootWorkspace),
        stored,
        events: yield* sentEventCount,
      };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toBe(
        "governance: decision request routed to parent",
      );
    }
    const entry = result.entries.find(
      (candidate) => candidate.kind === "Message",
    );
    expect(entry?.summary).toContain("DecisionRequest");
    expect(entry?.summary).toContain(CHILD);
    expect(entry?.correlationId).toBe(GOV_CORRELATION);
    expect(Option.isSome(result.stored)).toBe(true);
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.senderWorkspaceId).toBe(CHILD);
      expect(result.stored.value.message.kind).toBe("DecisionRequest");
      expect(result.stored.value.message.recipientWorkspaceId).toBe(
        p6RootWorkspace,
      );
      expect(result.stored.value.message.correlationId).toBe(GOV_CORRELATION);
    }
    expect(result.events).toBe(1);
  });

  it("DecisionRequest from root has no parent: recorded only, no message row", async () => {
    const program = Effect.gen(function* () {
      yield* seed;
      const handler = yield* makeHandler;
      const before = yield* messageRows();
      const outcome = yield* handler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "DecisionRequest",
            question: "who guards the guards?",
          },
        },
        execution: executionOf(p6RootWorkspace),
        context: executionContext,
      });
      const after = yield* messageRows();
      return { outcome, before, after, events: yield* sentEventCount };
    });
    const result = await runP6(program, makeP6App());
    expect(result.outcome._tag).toBe("Observation");
    if (result.outcome._tag === "Observation") {
      expect(result.outcome.observation.text).toContain("no parent");
      expect(result.outcome.observation.text).toContain("recorded only");
    }
    expect(result.after).toBe(result.before); // message table unchanged
    expect(result.after).toBe(0);
    expect(result.events).toBe(0);
  });

  it("unknown governance request kinds keep the P5 observation-only behavior", async () => {
    const program = Effect.gen(function* () {
      yield* seed;
      const handler = yield* makeHandler;
      return yield* handler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: { _tag: "SomethingElse", note: "deferred" },
        },
        execution: executionOf(CHILD),
        context: executionContext,
      });
    });
    const outcome = await runP6(program, makeP6App());
    expect(outcome._tag).toBe("Observation");
    if (outcome._tag === "Observation") {
      expect(outcome.observation.text).toContain("SomethingElse");
    }
  });

  it("wake observability: DecisionRequest flags reevaluation, Report does not (02 §4)", async () => {
    const decisionPayload: SendMessagePayload = {
      messageId: msg("a1"),
      senderWorkspaceId: CHILD,
      message: {
        kind: "DecisionRequest",
        recipientWorkspaceId: p6RootWorkspace,
        bodyRef: "q:route-decision-wake",
        urgency: "Normal",
      },
    };
    const reportPayload: SendMessagePayload = {
      messageId: msg("a2"),
      senderWorkspaceId: CHILD,
      message: {
        kind: "Report",
        recipientWorkspaceId: p6RootWorkspace,
        bodyRef: "route-report-wake",
        urgency: "Normal",
      },
    };
    const program = Effect.gen(function* () {
      yield* seed;
      const gw = yield* CommandGateway;
      const decision = yield* submitSend(gw, {
        commandId: cmd("b1"),
        payload: decisionPayload,
      });
      const report = yield* submitSend(gw, {
        commandId: cmd("b2"),
        payload: reportPayload,
      });
      return { decision, report };
    });
    const result = await runP6(program, makeP6App());
    expect(result.decision.resolution._tag).toBe("Committed");
    expect(result.report.resolution._tag).toBe("Committed");
    if (result.decision.resolution._tag === "Committed") {
      expect(
        result.decision.resolution.result.promotion.triggersReevaluation,
      ).toBe(true);
    }
    if (result.report.resolution._tag === "Committed") {
      expect(
        result.report.resolution.result.promotion.triggersReevaluation,
      ).toBe(false);
    }
  });
});
