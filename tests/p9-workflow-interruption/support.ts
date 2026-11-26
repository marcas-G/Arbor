import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  type ConsumerLoopStores,
  pollOnce,
} from "../../packages/application/src/consumer-loop.js";
import type { CommandGatewayService } from "../../packages/application/src/gateway.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  AcceptanceId,
  ArtifactId,
  type ArtifactRole,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  type EventTypeName,
  type ExecutionId,
  type ExpectedDeliverable,
  type Principal,
  parse,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import type { SettleExecutionPayload } from "../../packages/execution-runtime/src/index.js";
import {
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  LeaseService,
  ProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkerDispatchPort,
  WorkRepository,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import { yieldedSettlement } from "../support/execution-episode-fixtures.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import { p9Boot } from "../support/consumer-app-support.js";

/** P9-012 — P7/P8 workflow interruption replay (WF1–WF3, 02 §8) +
 * dispatch failure / lost dispatch (DF1–DF2, 02 §9 / 04 §4) + D5.
 * Interruptions are injected at the wired consumer path (P9-010 loops)
 * and at the dispatch port; convergence is asserted as identical
 * canonical state. Every case is labeled crash-injected (GQ5). */

export const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
export const WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
export const EXE_DF1 = "exe_00000000-0000-7000-8000-00000000df01";
export const EXE_DF2 = "exe_00000000-0000-7000-8000-00000000df02";
export const ASSIGN_CMD_1 = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
export const ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e2",
);

export const VER = (n: number) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-0000000000${n}`);
export const ACC = (n: number) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-0000000000${n}`);
export const WREV = (n: number) => parse(WorkRevision)(n);
export const DEP_W1 = parse(DependencyId)(
  "dep_00000000-0000-7000-8000-0000000000a1",
);
export const DEL_W1 = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000a2",
);
export const ART_W1 = parse(ArtifactId)(
  "art_00000000-0000-7000-8000-0000000000a3",
);
export const REV = (n: number) => parse(DependencyRevision)(n);

export const MISSION: VerificationMission = {
  goal: "verify the completed outcome",
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: false },
  ],
  riskRequirements: [],
};

export const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

export const seedProjectAndWork = Effect.gen(function* () {
  yield* p9Boot;
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD_1);
  expect(receipt.resolution._tag).toBe("Committed");
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "UPDATE works SET verification_mission = ? WHERE work_id = ?",
    [JSON.stringify(MISSION), WORK_1],
  );
});

export const journalEvent = (eventType: string, payload: unknown) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(
      journal.append([
        {
          projectId: p7Project,
          eventType: eventType as EventTypeName,
          eventVersion: 1,
          occurredAt: "t",
          aggregateRef: p7Project,
          actor: p7TestActor,
          payload,
        },
      ]),
    );
  });

export const loopStores: Effect.Effect<
  ConsumerLoopStores,
  never,
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
> = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  const offsets = yield* ConsumerOffsetStore;
  const deadLetters = yield* ConsumerDeadLetterStore;
  const projection = yield* ProjectionStore;
  return {
    tx: { transact: tx.transact },
    journal: {
      readAfterRaw: journal.readAfterRaw,
      decodeRaw: journal.decodeRaw,
    },
    offsets,
    deadLetters,
    projection,
  };
});

export const journalHead = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  return yield* tx.transact(journal.lastSequence(p7Project));
});

export const preconsume = (consumerId: string) =>
  Effect.gen(function* () {
    const stores = yield* loopStores;
    const head = yield* journalHead;
    yield* pollOnce(consumerId, p7Project, 1000, {
      ...stores,
      handlers: () => Effect.succeed([]),
    });
    return head;
  });

export const offsetOf = (consumerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    return yield* tx.transact(offsets.read(consumerId, p7Project));
  });

export const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

export const countRows = (
  table: string,
  where = "1=1",
  params: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  });

/** One-shot pre-commit interruption at the gateway (WF1/WF3): the first
 * matching submission dies with the transient operational class — the
 * loop aborts the batch (offset stays), redelivery retries. */
export const transientOnceGateway = (
  gateway: CommandGatewayService,
  commandType: string,
): { gateway: CommandGatewayService; fired: () => boolean } => {
  let fired = false;
  return {
    fired: () => fired,
    gateway: {
      execute: (envelope, context, authority) =>
        Effect.suspend(() => {
          if (!fired && envelope.commandType === commandType) {
            fired = true;
            return Effect.die({
              _tag: "TransactionOperationalFailure",
              cause: "harness-kill:pre-commit",
            }) as never;
          }
          return gateway.execute(envelope, context, authority);
        }) as never,
    },
  };
};

export const makeVerificationDeps = (gateway: CommandGatewayService) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    return {
      gateway,
      verifications: {
        findOpenByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
          tx.transact(
            verifications.findOpenByWorkRevision(workId, targetWorkRevision),
          ),
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
        listByWork: (workId: WorkId) =>
          tx.transact(verifications.listByWork(workId)),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
      workspaces: {
        findById: (workspaceId: WorkspaceId) =>
          tx.transact(workspaces.findById(workspaceId)),
      },
    };
  });

export const makeCompletionDeps = () =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    return {
      gateway,
      verifications: {
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      acceptances: {
        findByWorkRevision: () => Effect.succeed(Option.none()),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

/** p7-coordinator test deps shape (repositories + direct-SQL listing). */
export const makeCoordinatorDeps = (
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const works = yield* WorkRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
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

export const seedDependencyAndDeliverable = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const dependencies = yield* DependencyRepository;
  const deliverables = yield* DeliverableRepository;
  yield* tx.transact(
    dependencies.insert(
      declareDependency({
        dependencyId: DEP_W1,
        consumerWorkId: WORK_1,
        producerBinding: { _tag: "AnyProducer" },
        revision: REV(0),
        expectedDeliverable: expectedOf("report", ["summary"]),
      }),
      p7Project,
    ),
  );
  yield* tx.transact(
    deliverables.insert(
      {
        deliverableId: DEL_W1,
        sourceWorkId: WORK_P,
        sourceWorkRevision: 0,
        kind: "report",
      },
      [{ role: "summary", artifactId: ART_W1 }],
      p7Project,
    ),
  );
});

/** Raw Active execution fixture (p9-recovery-driver precedent). */
export const INSERT_EXECUTION = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${executionId.slice(4)}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${executionId.slice(4)}`],
    );
  });

/** Raw Active MAIN execution fixture: the DF2 reevaluate face keys on
 * binding_kind 'workspace' (P2 `05` §8 single-flight conflict). */
export const INSERT_MAIN_EXECUTION = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${executionId.slice(4)}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${executionId.slice(4)}`],
    );
  });

export const executionSettlement = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
      "SELECT settlement_kind FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows.length === 0 ? "missing" : (rows[0]?.settlement_kind ?? null);
  });

export const dispatchRound = (
  executionId: string,
  port: Layer.Layer<WorkerDispatchPort>,
) =>
  Effect.provide(
    Effect.gen(function* () {
      const dispatch = yield* WorkerDispatchPort;
      yield* dispatch.dispatch({
        executionId: executionId as never as ExecutionId,
        workspaceId: p7RootWorkspace,
        workerKind: "Agent",
      });
    }),
    port,
  );

export const dyingDispatch = (): Layer.Layer<WorkerDispatchPort> =>
  Layer.succeed(WorkerDispatchPort, {
    dispatch: () => Effect.die(new Error("harness-kill:dispatch")),
  });

export const recordingDispatch = (
  sink: Array<string>,
): Layer.Layer<WorkerDispatchPort> =>
  Layer.succeed(WorkerDispatchPort, {
    dispatch: (request) =>
      Effect.sync(() => {
        sink.push(request.executionId as string);
        return { dispatchId: `tkt_${sink.length}`, acceptedAt: "t" };
      }),
  });

export const settleCompleted = (executionId: string) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    const lease = yield* tx.transact(
      leases.acquire(
        executionId as never as ExecutionId,
        "worker:p9df",
        "inc-p9df",
      ),
    );
    const payload: SettleExecutionPayload = {
      executionId: executionId as never as ExecutionId,
      settlement: {
        ...yieldedSettlement,
      },
      expectedFencingGeneration: lease.generation,
    };
    const commandId = `cmd_settle_p9df_${executionId}` as never as CommandId;
    return yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: p7Project,
        actor: p7TestPrincipal as never,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: p7Project,
          actor: p7TestPrincipal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        commandKind: "SettleExecution",
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      },
    );
  });
