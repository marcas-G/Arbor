import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  P12_MIGRATIONS,
  runMigrations,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { deliverHandler } from "../../../apps/single-workspace/src/control-actions.js";
import type { AgentActionHandlerInput } from "../../../packages/agent-runtime/src/index.js";
import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
} from "../../../packages/application/src/index.js";
import {
  CommandId,
  DeliverableId,
  ExecutionId,
  type LeaseGeneration,
  MessageId,
  Principal,
  parse,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  Clock,
  DeliverableRepository,
  DomainEventJournal,
  ExecutionRepository,
  IdGenerator,
  InboxProjectionStore,
  LeaseService,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../../../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "../../support/p7-app.js";

const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const childSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const childWorkId = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000a1");
const deliverableId = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000b1",
);
const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-0000000000a1",
);
const childAssignCommandId = parse(CommandId)(
  "cmd_00000000-0000-7000-8000-0000000000a1",
);
const providerTurnId = "ptn_00000000-0000-7000-8000-0000000000a1";
const outputPosition = 0;
const occurrence = `${providerTurnId}:${outputPosition}`;
const messageId = parse(MessageId)(
  `msg_${newUuid7("deliver-message", occurrence)}`,
);
const principal = parse(Principal)("agent:deliver-child");

const workspaceRow = [
  childWorkspaceId,
  p7Project,
  p7RootWorkspace,
  "AH10 child",
  JSON.stringify({
    purpose: "deliver audit",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  }),
  1,
  JSON.stringify({ basisResponsibilityRevision: 1, addresses: [] }),
  1,
  JSON.stringify({
    _tag: "ResponsibilityBound",
    workspaceId: childWorkspaceId,
  }),
  childSessionId,
  JSON.stringify({}),
  0,
  0,
  "Active",
  "t",
  "t",
];

const app = () => {
  const base = makeP7App();
  const journal = Layer.provide(
    DomainEventJournalLive,
    base as unknown as Layer.Layer<SqlClient | IdGenerator>,
  );
  return Layer.mergeAll(base, journal);
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P12_MIGRATIONS);
  yield* p7SeedProject;
  const tx = yield* TransactionPort;
  const sql = yield* SqlClient;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        workspaceRow,
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
        [childSessionId, "WorkspacePrimary", childWorkspaceId, null, 0, "t"],
      );
    }),
  );

  const gateway = yield* CommandGateway;
  const workPayload = {
    workId: childWorkId,
    workspaceId: childWorkspaceId,
    expectedWorkspaceRevision: 0,
    objective: "AH10 Deliver stale generation test",
    why: "seed canonical source Work",
    constraints: [],
    completionExpectation: "one Deliver handover",
    verificationMission: {
      goal: "verify Deliver handover",
      criteria: [
        {
          criterionId: "handover",
          requirement: "one canonical Message is written",
          required: true,
        },
      ],
      riskRequirements: [],
    },
    provenance: { predecessorWorkId: null, reason: "pending AH10 test seed" },
    revision: 0,
  };
  const workReceipt = yield* gateway.execute(
    {
      commandType: "AssignWork",
      commandId: childAssignCommandId,
      projectId: p7Project,
      actor: p7TestActor,
      issuedAt: "t",
      payload: workPayload,
    },
    { _tag: "External", principal: p7TestPrincipal },
    {
      _tag: "AssignWorkAuthority",
      principal: p7TestPrincipal,
      commandId: childAssignCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AssignWork",
        projectId: p7Project,
        actor: p7TestActor,
        schemaVersion: "1",
        payload: workPayload,
      }),
      projectId: p7Project,
      targetWorkspaceId: childWorkspaceId,
    },
  );
  if (workReceipt.resolution._tag !== "Committed") {
    throw new Error("failed to seed source Work");
  }

  const deliverables = yield* DeliverableRepository;
  yield* tx.transact(
    deliverables.insert(
      {
        deliverableId,
        sourceWorkId: childWorkId,
        sourceWorkRevision: 0,
        kind: "report",
      },
      [],
      p7Project,
    ),
  );

  const executions = yield* ExecutionRepository;
  yield* tx.transact(
    executions.admitExecution({
      executionId,
      projectId: p7Project,
      workspaceId: childWorkspaceId,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId: childWorkspaceId,
        episode: {
          _tag: "WorkEpisode",
          workId: childWorkId,
          targetWorkRevision: parse(WorkRevision)(0),
        },
      },
      sessionId: childSessionId,
      admittedAt: "t",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    }),
  );
  const leases = yield* LeaseService;
  const firstOwner = yield* tx.transact(
    leases.acquire(executionId, "worker:old", "incarnation:old"),
  );
  yield* tx.transact(
    leases.release(
      executionId,
      "worker:old",
      "incarnation:old",
      firstOwner.generation,
    ),
  );
  const newOwner = yield* tx.transact(
    leases.acquire(executionId, "worker:new", "incarnation:new"),
  );
  return {
    firstGeneration: Number(firstOwner.generation),
    currentGeneration: Number(newOwner.generation),
  };
});

const makeInput = (generation: number): AgentActionHandlerInput =>
  ({
    action: {
      _tag: "Deliver",
      deliverableId,
      summary: "The child result is ready.",
    },
    invocation: {
      providerTurnId: providerTurnId as never,
      outputPosition,
      callRef: "call-ah10-deliver",
      toolName: "deliver",
      argumentsJson: "{}",
    },
    execution: {
      executionId,
      projectId: p7Project,
      workspaceId: childWorkspaceId,
      sessionId: childSessionId,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId: childWorkspaceId,
        episode: {
          _tag: "WorkEpisode",
          workId: childWorkId,
          targetWorkRevision: parse(WorkRevision)(0),
        },
      },
      admittedAt: "t",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    },
    context: {
      _tag: "ExecutionOrigin",
      principal,
      executionId,
      fencingGeneration: generation as LeaseGeneration,
    },
  }) as AgentActionHandlerInput;

const deliverCounts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const messages = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM messages WHERE message_id = ?",
    [messageId],
  );
  const events = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'MessageSent' AND aggregate_ref = ?",
    [messageId],
  );
  const inbox = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
    [p7RootWorkspace, `msg:${messageId}`],
  );
  const lease = yield* sql.unsafe<{ generation: number; worker_id: string }>(
    "SELECT generation, worker_id FROM execution_leases WHERE execution_id = ?",
    [executionId],
  );
  return {
    messages: Number(messages[0]?.count ?? 0),
    messageSentEvents: Number(events[0]?.count ?? 0),
    inboxEntries: Number(inbox[0]?.count ?? 0),
    currentLease: lease[0],
  };
});

const runHandler = (generation: number) =>
  Effect.gen(function* () {
    const deliverables = yield* DeliverableRepository;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    const messages = yield* MessageStore;
    const inbox = yield* InboxProjectionStore;
    const clock = yield* Clock;
    const tx = yield* TransactionPort;
    const handler = deliverHandler({
      deliverables,
      journal,
      ids,
      works,
      workspaces,
      messages,
      inbox,
      clock,
      tx,
    });
    const exit = yield* Effect.exit(handler.handle(makeInput(generation)));
    return { exit, counts: yield* deliverCounts };
  });

describe("pending AH10 Deliver generation fence and MessageId replay", () => {
  it("rejects the previous lease generation before it can write the first handover", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        const generations = yield* seed;
        const stale = yield* runHandler(generations.firstGeneration);
        return { generations, stale };
      }),
      app(),
    );

    expect(result.generations).toEqual({
      firstGeneration: 0,
      currentGeneration: 1,
    });
    expect({
      outcome: result.stale.exit._tag,
      messages: result.stale.counts.messages,
      messageSentEvents: result.stale.counts.messageSentEvents,
      inboxEntries: result.stale.counts.inboxEntries,
      currentLeaseGeneration: result.stale.counts.currentLease?.generation,
      currentLeaseWorker: result.stale.counts.currentLease?.worker_id,
    }).toEqual({
      outcome: "Failure",
      messages: 0,
      messageSentEvents: 0,
      inboxEntries: 0,
      currentLeaseGeneration: 1,
      currentLeaseWorker: "worker:new",
    });
  });

  it("fails closed on committed MessageId replay without duplicating Message, Event, or Inbox facts", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        const generations = yield* seed;
        const first = yield* runHandler(generations.currentGeneration);
        const replay = yield* runHandler(generations.currentGeneration);
        return { generations, first, replay };
      }),
      app(),
    );

    expect(result.generations).toEqual({
      firstGeneration: 0,
      currentGeneration: 1,
    });
    expect(Exit.isSuccess(result.first.exit)).toBe(true);
    expect(Exit.isFailure(result.replay.exit)).toBe(true);
    expect(result.replay.counts).toMatchObject({
      messages: 1,
      messageSentEvents: 1,
      inboxEntries: 1,
      currentLease: { generation: 1, worker_id: "worker:new" },
    });
  });
});
