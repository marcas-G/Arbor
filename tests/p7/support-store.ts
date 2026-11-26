import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import type { DeliverDependencies } from "../../packages/application/src/commands/deliver-command.js";
import { makeSendMessageHandler } from "../../packages/application/src/commands/send-message.js";
import { runDependencyCoordinator } from "../../packages/application/src/dependency-coordinator.js";
import {
  CommandGateway,
  sendMessagePlan,
  type WakeSinkDependencies,
} from "../../packages/application/src/index.js";
import {
  type ArtifactId,
  type CommandId,
  type DeliverableId,
  type DependencyId,
  declareDependency,
  type ExpectedDeliverable,
  type ProducerBinding,
  parse,
  Revision,
  type WakeCondition,
  type WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  ExecutionScheduler,
  InboxProjectionStore,
  MessageStore,
  RunnableWorkSource,
  type SchedulerDecision,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import {
  CHILD_C,
  CMD_C_REPORT,
  externalContext,
  fingerprintOf,
  MSG_C_REPORT,
  REV,
} from "./support.js";

export const seedWorks = (
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
export const seedWorkOn = (
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

export const insertWait = (
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

export const depChanged = (dependencyId: DependencyId): WakeCondition => ({
  _tag: "DependencyChanged",
  dependencyId,
  observedRevision: parse(Revision)(0),
});

export const timeReached: WakeCondition = {
  _tag: "TimeReached",
  instant: "2099-01-01T00:00:00.000Z",
};

export const setCurrentWork = (
  workId: WorkId | null,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

export const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

export const countDependencyEvents = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ readonly n: number }>(
    "SELECT COUNT(*) AS n FROM domain_events WHERE event_type LIKE 'Dependency%'",
  );
  return Number(rows[0]?.n ?? 0);
});

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? 0);
  });

export const eventPayloads = (eventType: string) =>
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

export const receiptResolution = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly resolution: string }>(
      "SELECT resolution FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1 ? rows[0]?.resolution : null;
  });

export const storedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
  });

export const seedDependency = (
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

export const seedDeliverable = (
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

export const journalEvents = Effect.gen(function* () {
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

export const producedEvents = Effect.map(journalEvents, (events) =>
  events.filter((event) => event.eventType === "DeliverableProduced"),
);

export const classifyRoot: Effect.Effect<
  { current: Option.Option<WorkId>; runnable: ReadonlyArray<WorkId> },
  unknown,
  RunnableWorkSource
> = Effect.gen(function* () {
  const source = yield* RunnableWorkSource;
  return yield* source.classify(p7RootWorkspace);
});

export const decideFromTable = (
  current: Option.Option<WorkId>,
  runnable: ReadonlyArray<WorkId>,
): SchedulerDecision =>
  Option.isSome(current)
    ? { _tag: "AdmitWork", workId: current.value }
    : runnable.length === 0
      ? { _tag: "Idle" }
      : runnable.length === 1
        ? { _tag: "SelectCurrentWork", workId: runnable[0] as WorkId }
        : { _tag: "RequestWorkSelection", candidateWorkIds: runnable };

export const makeCoordinatorDeps = Effect.gen(function* () {
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

export const runCoordinatorOverProducedEvents = Effect.gen(function* () {
  const events = yield* producedEvents;
  const deps = yield* makeCoordinatorDeps;
  return yield* runDependencyCoordinator(
    events.map((event) => ({
      ...event,
      occurredAt: "2026-01-01T00:00:00.000Z",
    })),
    deps,
    p7Project,
    p7TestPrincipal,
  );
});

export const makeSinkDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies WakeSinkDependencies;
});

export const makeDeliverDeps = Effect.gen(function* () {
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

export const inboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const inbox = yield* InboxProjectionStore;
    const tx = yield* TransactionPort;
    return yield* tx.transact(inbox.listUnconsumed(workspaceId));
  });

export const submitReport = Effect.gen(function* () {
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
