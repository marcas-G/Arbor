import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type DeliverDependencies,
  submitDeliver,
} from "../packages/application/src/commands/deliver-command.js";
import { makeSendMessageHandler } from "../packages/application/src/commands/send-message.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
  sendMessagePlan,
} from "../packages/application/src/index.js";
import {
  CommandId,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  MessageId,
  parse,
  Revision,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  type IdGenerator,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

const CHILD = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789d2");
const CHILD_SESSION = "ses_018f2b3c-4d5e-7abc-8def-0123456789d2";
const CHILD_WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a1");
const ROOT_WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a2");
const DEL_CHILD = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000b1",
);
const DEL_ROOT = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000b2",
);
const UNKNOWN_DELIVERABLE = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000ff",
);
const DEP_1 = parse(DependencyId)("dep_00000000-0000-7000-8000-0000000000c1");

const msg = (suffix: string) =>
  parse(MessageId)(`msg_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

const ASSIGN_CHILD_CMD = cmd("d1");
const ASSIGN_ROOT_CMD = cmd("d2");
const DELIVER_MSG = msg("e1");
const DELIVER_CMD = cmd("e1");
const REJECT_MSGS = [msg("e2"), msg("e3"), msg("e4")];
const REJECT_CMDS = [cmd("e2"), cmd("e3"), cmd("e4")];
const REPORT_MSG = msg("f1");
const REPORT_CMD = cmd("f1");

const KIND = "report" as never as DeliverableKind;

/** makeP7App runtime-includes IdGenerator; the journal service is added on
 * top of the same SqlClient so Deliver's journal append shares the DB (and
 * the caller's transaction). */
const makeDeliverApp = (
  filename = ":memory:",
): Layer.Layer<CommandGateway | SqlClient | DomainEventJournal> => {
  const base = makeP7App(filename);
  const journal = Layer.provide(
    DomainEventJournalLive,
    base as unknown as Layer.Layer<SqlClient | IdGenerator>,
  );
  return Layer.mergeAll(base, journal) as Layer.Layer<
    CommandGateway | SqlClient | DomainEventJournal
  >;
};

const workspaceRow = (
  workspaceId: WorkspaceId,
  projectId: typeof p7Project,
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

/** p6-deep-formation seedChildWorkspace pattern: deferrable
 * workspace→session / project→workspace FKs share one transaction. */
const seedChildWorkspace = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        workspaceRow(CHILD, p7Project, p7RootWorkspace, CHILD_SESSION),
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [CHILD_SESSION, "WorkspacePrimary", CHILD, null, 0, "t"],
      );
    }),
  );
});

const seedWorkOn = (
  workspaceId: WorkspaceId,
  workId: WorkId,
  commandId: CommandId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const payload = {
      workId,
      workspaceId,
      expectedWorkspaceRevision: parse(Revision)(0),
      objective: "p7-deliver",
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
        targetWorkspaceId: workspaceId,
      },
    );
    expect(receipt.resolution._tag).toBe("Committed");
  });

const seedDeliverables = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const deliverables = yield* DeliverableRepository;
  yield* tx.transact(
    deliverables.insert(
      {
        deliverableId: DEL_CHILD,
        sourceWorkId: CHILD_WORK,
        sourceWorkRevision: 0,
        kind: "report",
      },
      [],
      p7Project,
    ),
  );
  yield* tx.transact(
    deliverables.insert(
      {
        deliverableId: DEL_ROOT,
        sourceWorkId: ROOT_WORK,
        sourceWorkRevision: 0,
        kind: "report",
      },
      [],
      p7Project,
    ),
  );
});

/** AnyProducer + matching kind + no required roles: DEL_CHILD would match
 * structurally — the strongest form of "delivery is not matching". */
const seedDependency = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const dependencies = yield* DependencyRepository;
  yield* tx.transact(
    dependencies.insert(
      {
        dependencyId: DEP_1,
        consumerWorkId: ROOT_WORK,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: { kind: KIND, requiredArtifactRoles: [] },
        revision: parse(DependencyRevision)(0),
        state: "Unsatisfied",
        satisfiedByDeliverableId: null,
        satisfiedAtDependencyRevision: null,
      },
      p7Project,
    ),
  );
});

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  yield* seedChildWorkspace;
  yield* seedWorkOn(CHILD, CHILD_WORK, ASSIGN_CHILD_CMD);
  yield* seedWorkOn(p7RootWorkspace, ROOT_WORK, ASSIGN_ROOT_CMD);
  yield* seedDeliverables;
});

const makeDeps = Effect.gen(function* () {
  const workspaces = yield* WorkspaceRepository;
  const works = yield* WorkRepository;
  const deliverables = yield* DeliverableRepository;
  const dependencies = yield* DependencyRepository;
  const messages = yield* MessageStore;
  const inbox = yield* InboxProjectionStore;
  const journal = yield* DomainEventJournal;
  const sendMessage = makeSendMessageHandler({ workspaces, messages, inbox });
  const deps: DeliverDependencies = {
    deliverables,
    works,
    workspaces,
    sendMessage,
    inbox,
    journal,
    clock: { now: () => Effect.succeed("t") },
  };
  return { dependencies, deps, inbox, journal, messages };
});

const deliver = (
  deps: DeliverDependencies,
  args: Partial<Parameters<typeof submitDeliver>[0]> & {
    readonly senderWorkspaceId: WorkspaceId;
  },
) =>
  submitDeliver(
    {
      deliverableId: DEL_CHILD,
      bodyRef: "art-deliver-body-001",
      commandId: DELIVER_CMD,
      messageId: DELIVER_MSG,
      projectId: p7Project,
      actor: p7TestActor,
      principal: p7TestPrincipal,
      ...args,
    },
    deps,
  );

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

const messageRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM messages",
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

const dependencyState = Effect.gen(function* () {
  const dependencies = yield* DependencyRepository;
  const tx = yield* TransactionPort;
  return yield* tx.transact(dependencies.findById(DEP_1));
});

/** p6 submitSend pattern: the Report regression goes through the real
 * gateway via the Communicate directive factory plan. */
const submitReport = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const plan = sendMessagePlan({
    messageId: REPORT_MSG,
    commandId: REPORT_CMD,
    projectId: p7Project,
    senderWorkspaceId: CHILD,
    principal: p7TestPrincipal,
    actor: p7TestActor,
    message: {
      kind: "Report",
      recipientWorkspaceId: p7RootWorkspace,
      bodyRef: "art-report-body-001",
      urgency: "Normal",
    },
  });
  return yield* gateway.execute(
    {
      commandType: "SendMessage",
      commandId: REPORT_CMD,
      projectId: p7Project,
      actor: p7TestActor,
      issuedAt: "t",
      payload: plan.payload,
    },
    { _tag: "External", principal: p7TestPrincipal },
    plan.authority,
  );
});

describe("p7-deliver-primitive", () => {
  it("Deliver commits at one boundary: MessageSent(kind Deliver, deliverableId), exactly one parent Inbox 'Message' entry with a deliverable-referencing summary, ChildDelivered wake in the Result, MessageStore row", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const { deps } = yield* makeDeps;
        const submission = yield* tx.transact(
          deliver(deps, { senderWorkspaceId: CHILD }),
        );
        const events = yield* sentEventPayloads;
        const entries = yield* inboxOf(p7RootWorkspace);
        const stored = yield* storedMessage(DELIVER_MSG);
        return {
          submission,
          events,
          entries,
          stored,
          dependencyEvents: yield* dependencyEventCount,
        };
      }),
      makeDeliverApp(),
    ).then((result) => {
      expect(result.submission._tag).toBe("Delivered");
      if (result.submission._tag === "Delivered") {
        expect(result.submission.outcome.recipientWorkspaceId).toBe(
          p7RootWorkspace,
        );
        expect(result.submission.outcome.wakeSignal).toEqual({
          workspaceId: p7RootWorkspace,
          reason: { _tag: "ChildDelivered" },
          detail: { deliverableId: DEL_CHILD, messageId: DELIVER_MSG },
        });
        expect(result.submission.outcome.promotion).toEqual({
          closesCorrelation: null,
          triggersReevaluation: false,
        });
      }
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        messageId: DELIVER_MSG,
        kind: "Deliver",
        sender: CHILD,
        recipient: p7RootWorkspace,
        deliverableId: DEL_CHILD,
        correlationId: null,
        causationId: null,
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.entryKey).toBe(`msg:${DELIVER_MSG}`);
      expect(result.entries[0]?.kind).toBe("Message");
      expect(result.entries[0]?.summary).toBe(
        `Deliver ${DEL_CHILD} from ${CHILD}`,
      );
      expect(Option.isSome(result.stored)).toBe(true);
      if (Option.isSome(result.stored)) {
        expect(result.stored.value.senderWorkspaceId).toBe(CHILD);
        expect(result.stored.value.message.kind).toBe("Deliver");
        expect(result.stored.value.message.recipientWorkspaceId).toBe(
          p7RootWorkspace,
        );
      }
      expect(result.dependencyEvents).toBe(0);
    });
  });

  it("Deliver never satisfies a Dependency: a structurally matching AnyProducer dependency stays Unsatisfied (G2: delivery is not matching)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency;
        const tx = yield* TransactionPort;
        const { deps } = yield* makeDeps;
        const submission = yield* tx.transact(
          deliver(deps, { senderWorkspaceId: CHILD }),
        );
        return {
          submission,
          dependency: yield* dependencyState,
          dependencyEvents: yield* dependencyEventCount,
        };
      }),
      makeDeliverApp(),
    ).then((result) => {
      expect(result.submission._tag).toBe("Delivered");
      expect(Option.isSome(result.dependency)).toBe(true);
      if (Option.isSome(result.dependency)) {
        expect(result.dependency.value.state).toBe("Unsatisfied");
        expect(
          result.dependency.value.satisfiedByDeliverableId,
        ).toBeUndefined();
        expect(result.dependency.value.revision).toBe(0);
      }
      expect(result.dependencyEvents).toBe(0);
    });
  });

  it("rejects the frozen Deliver table (02 §4): deliverable not found / sender is not the source-work owner / root sender has no parent", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const { deps } = yield* makeDeps;
        const notFound = yield* tx.transact(
          deliver(deps, {
            senderWorkspaceId: CHILD,
            deliverableId: UNKNOWN_DELIVERABLE,
            commandId: REJECT_CMDS[0]!,
            messageId: REJECT_MSGS[0]!,
          }),
        );
        const notOwner = yield* tx.transact(
          deliver(deps, {
            senderWorkspaceId: p7RootWorkspace,
            commandId: REJECT_CMDS[1]!,
            messageId: REJECT_MSGS[1]!,
          }),
        );
        const rootSender = yield* tx.transact(
          deliver(deps, {
            senderWorkspaceId: p7RootWorkspace,
            deliverableId: DEL_ROOT,
            commandId: REJECT_CMDS[2]!,
            messageId: REJECT_MSGS[2]!,
          }),
        );
        return {
          notFound,
          notOwner,
          rootSender,
          events: yield* sentEventPayloads,
          entries: yield* inboxOf(p7RootWorkspace),
          messages: yield* messageRowCount,
        };
      }),
      makeDeliverApp(),
    ).then((result) => {
      expect(result.notFound._tag).toBe("Rejected");
      if (result.notFound._tag === "Rejected") {
        expect(result.notFound.rejection).toEqual({
          _tag: "DeliverableNotFound",
          deliverableId: UNKNOWN_DELIVERABLE,
        });
      }
      expect(result.notOwner._tag).toBe("Rejected");
      if (result.notOwner._tag === "Rejected") {
        expect(result.notOwner.rejection._tag).toBe("AuthorityDenied");
      }
      expect(result.rootSender._tag).toBe("Rejected");
      if (result.rootSender._tag === "Rejected") {
        expect(result.rootSender.rejection).toEqual({
          _tag: "AuthorityDenied",
          reason: "root has no parent to deliver to",
        });
      }
      expect(result.events).toHaveLength(0);
      expect(result.entries).toHaveLength(0);
      expect(result.messages).toBe(0);
    });
  });

  it("Report channel regression (P6 D2 continuation): Report to parent commits with zero Dependency events and no dependency-state change", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency;
        const receipt = yield* submitReport;
        return {
          receipt,
          dependency: yield* dependencyState,
          dependencyEvents: yield* dependencyEventCount,
        };
      }),
      makeDeliverApp(),
    ).then((result) => {
      expect(result.receipt.resolution._tag).toBe("Committed");
      expect(Option.isSome(result.dependency)).toBe(true);
      if (Option.isSome(result.dependency)) {
        expect(result.dependency.value.state).toBe("Unsatisfied");
      }
      expect(result.dependencyEvents).toBe(0);
    });
  });
});
