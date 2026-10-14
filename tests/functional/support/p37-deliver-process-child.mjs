import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import {
  ClockLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../../../adapters/persistence-sqlite/dist/index.js";
import { deliverHandler } from "../../../apps/single-workspace/dist/control-actions.js";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import {
  Clock,
  DeliverableRepository,
  DomainEventJournal,
  IdGenerator,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../../../packages/ports/dist/index.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";

// This entry is used only by P37 functional child processes. Production
// composition never reads these environment variables and leaves every probe
// absent. Each pause is inside the current process; killing this child models
// an OS-process crash against the shared file-backed SQLite database.
const role = process.env.ARBOR_P37_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("P37 test child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined)
  throw new Error("P37 test child needs ARBOR_DB");

const gateDirectory = join(dirname(databaseFile), "p37-gates");
const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ tag: "P37_DELIVER_PROBE", role, ...event })}\n`,
  );

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `P37 gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const holdConfiguredBoundary = async (boundary, event) => {
  if (
    process.env.ARBOR_P37_PAUSE_ROLE !== role ||
    !process.env.ARBOR_P37_PAUSE_BOUNDARY?.split(",").includes(boundary)
  ) {
    return;
  }
  emit({ ...event, boundary });
  await waitForGate(`boundary-${boundary}`, event);
};

const readActionKind = (logicalActionId) => {
  if (logicalActionId === undefined) return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT action_kind FROM agent_loop_step_actions WHERE logical_action_id = ?",
      )
      .get(logicalActionId)?.action_kind;
  } finally {
    db.close();
  }
};

const readLeaseOwner = (executionId) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT worker_id, worker_incarnation_id, generation
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(executionId);
  } finally {
    db.close();
  }
};

const executeLegacyDirectDeliver = async (event) => {
  const deliverableId = process.env.ARBOR_P37_LEGACY_DELIVERABLE_ID;
  const summary = process.env.ARBOR_P37_LEGACY_SUMMARY;
  if (
    deliverableId === undefined ||
    summary === undefined ||
    event.executionId === undefined ||
    event.providerTurnId === undefined ||
    event.logicalActionId === undefined ||
    event.callRef === undefined ||
    event.actionIndex === undefined
  ) {
    throw new Error(
      "P37 legacy direct-write test child is missing pinned action data",
    );
  }
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  let execution;
  try {
    execution = db
      .prepare(
        `SELECT execution_id, project_id, workspace_id, episode_ref,
                episode_revision, session_id, admitted_at, stop_requested_at,
                settlement_kind
           FROM executions WHERE execution_id = ?`,
      )
      .get(event.executionId);
  } finally {
    db.close();
  }
  if (execution === undefined || execution.settlement_kind !== null) {
    throw new Error(
      "P37 legacy direct-write test child found no Active Execution",
    );
  }
  const sqlite = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(sqlite, ClockLive, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const repositories = Layer.mergeAll(
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
  );
  const app = Layer.mergeAll(infra, journal, repositories);
  return Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const handler = deliverHandler({
            deliverables: yield* DeliverableRepository,
            journal: yield* DomainEventJournal,
            ids: yield* IdGenerator,
            works: yield* WorkRepository,
            workspaces: yield* WorkspaceRepository,
            messages: yield* MessageStore,
            inbox: yield* InboxProjectionStore,
            clock: yield* Clock,
            tx: yield* TransactionPort,
          });
          return yield* handler.handle({
            action: { _tag: "Deliver", deliverableId, summary },
            invocation: {
              providerTurnId: event.providerTurnId,
              outputPosition: event.actionIndex,
              callRef: event.callRef,
              toolName: "deliver",
              argumentsJson: JSON.stringify({ deliverableId, summary }),
            },
            execution: {
              executionId: execution.execution_id,
              projectId: execution.project_id,
              workspaceId: execution.workspace_id,
              sessionId: execution.session_id,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId: execution.workspace_id,
                episode: {
                  _tag: "WorkEpisode",
                  workId: execution.episode_ref,
                  targetWorkRevision: Number(execution.episode_revision),
                },
              },
              admittedAt: execution.admitted_at,
              stopRequestedAt: execution.stop_requested_at,
              state: { status: "Active", settlement: null },
            },
            context: {
              _tag: "ExecutionOrigin",
              principal: "agent:deliver-child",
              executionId: execution.execution_id,
              fencingGeneration: 0,
            },
            logicalActionId: event.logicalActionId,
          });
        }),
        app,
      ),
    ),
  );
};

const qualificationProbe = async (event) => {
  if (
    event.boundary === "AH7AfterActionIntentCommit" &&
    event.actionIndex === 0
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    const configuredKind = process.env.ARBOR_P37_GATE_ACTION_KIND;
    if (configuredKind === undefined || configuredKind === actionKind) {
      if (
        role === process.env.ARBOR_P37_LEGACY_DIRECT_ROLE &&
        actionKind === "deliver"
      ) {
        const legacyObservation = await executeLegacyDirectDeliver(event);
        emit({
          boundary: "P37LegacyDirectObservationReturned",
          executionId: event.executionId,
          providerTurnId: event.providerTurnId,
          logicalActionId: event.logicalActionId,
          callRef: event.callRef,
          actionKind,
          legacyObservationText: legacyObservation.observation.text,
        });
        await holdConfiguredBoundary(event.boundary, event);
        return;
      }
      emit({ ...event, actionKind });
      await holdConfiguredBoundary(event.boundary, event);
    }
  }
  if (
    event.boundary === "AH10AfterControlHandlerReturnBeforeObservationCommit"
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    const configuredKind = process.env.ARBOR_P37_GATE_ACTION_KIND;
    if (configuredKind === undefined || configuredKind === actionKind) {
      emit({ ...event, actionKind });
      await holdConfiguredBoundary(event.boundary, { ...event, actionKind });
    }
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (event.boundary === "AH10AfterLeaseAcquired") {
    const owner = readLeaseOwner(event.executionId);
    if (
      owner === undefined ||
      Number(owner.generation) !== Number(event.fencingGeneration)
    ) {
      throw new Error(
        `P37 lease owner tuple was unavailable at acquisition: ${JSON.stringify({ event, owner })}`,
      );
    }
    emit({
      ...event,
      processId: process.pid,
      workerId: owner.worker_id,
      workerIncarnationId: owner.worker_incarnation_id,
    });
  }
  if (event.boundary === "AH10BeforeLeaseRenewal") {
    emit({ ...event, processId: process.pid });
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const gatewayQualificationProbe = async (event) => {
  if (event.boundary === "AH10BeforeFencedReceiptCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const deliverReplayQualificationProbe = async (event) => {
  if (event.boundary === "BeforeDeliverReplayAttentionCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
    return;
  }
  if (event.boundary === "AfterDeliverReplayAttentionCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const attentionProjectionQualificationProbe = async (event) => {
  if (event.boundary === "P10AfterAttentionRowWriteBeforeConsumerCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const attentionPollQualificationProbe = async (event) => {
  if (event.boundary === "P10AfterDeliverAttentionConsumerCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};

const config = {
  tickIntervalMs: 25,
  onWebTransportListening: createFunctionalDaemonListenReporter(),
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  qualificationProbe,
  gatewayQualificationProbe,
  executionLeaseQualificationProbe,
  deliverReplayQualificationProbe,
  attentionProjectionQualificationProbe,
  // This test-only child installs the post-commit probe explicitly;
  // production startup omits it.
  attentionPollQualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
