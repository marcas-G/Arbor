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
  type ProducerBinding,
  type ProjectId,
  parse,
  type VerificationId,
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
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import { sqlCount } from "./support.js";

// ---------------------------------------------------------------------------
// Stories F/G shared: consumer-loop helpers (p9-consumer-crash /
// p9-workflow-interruption construction patterns).
// ---------------------------------------------------------------------------

export const F_WORK_C = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000f1",
);
export const F_WORK_P = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000f2",
);
export const F_ASSIGN_CMD_C = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
export const F_ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f2",
);
export const F_DEP = parse(DependencyId)(
  "dep_00000000-0000-7000-8000-0000000000f1",
);
export const F_DEL = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000f2",
);
const F_ART = parse(ArtifactId)("art_00000000-0000-7000-8000-0000000000f3");

export const G_WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000b1");
export const G_WORK_P = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-0000000000b2",
);
export const G_ASSIGN_CMD = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b4",
);
export const G_ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b5",
);
export const G_DEP = parse(DependencyId)(
  "dep_00000000-0000-7000-8000-0000000000b1",
);
export const G_DEL = parse(DeliverableId)(
  "del_00000000-0000-7000-8000-0000000000b2",
);
// biome-ignore lint/correctness/noUnusedVariables: destructured for interface symmetry
const G_ART = parse(ArtifactId)("art_00000000-0000-7000-8000-0000000000b3");
export const G_ACC = parse(AcceptanceId)(
  "acc_00000000-0000-7000-8000-0000000000a5",
);

export const WREV = (n: number) => parse(WorkRevision)(n);
export const REV = (n: number) => parse(DependencyRevision)(n);

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

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
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
      [consumerId, p7Project],
    );
    return Number(rows[0]?.last_sequence ?? 0);
  });

export const journalEvent = (
  eventType: string,
  payload: unknown,
  eventVersion = 1,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    const event = {
      projectId: p7Project,
      eventType: eventType as EventTypeName,
      eventVersion,
      occurredAt: "t",
      aggregateRef: p7Project,
      actor: p7TestActor,
      payload,
    };
    if (eventVersion !== 1) {
      const writerResult = yield* Effect.result(
        tx.transact(journal.append([event])),
      );
      expect(writerResult._tag).toBe("Failure");
      const sql = yield* SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `INSERT INTO project_event_sequences (project_id,last_sequence)
               VALUES (?,1)
               ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1`,
            [p7Project],
          );
          const rows = yield* sql.unsafe<{ last_sequence: number }>(
            "SELECT last_sequence FROM project_event_sequences WHERE project_id = ?",
            [p7Project],
          );
          const sequence = Number(rows[0]?.last_sequence ?? 0);
          yield* sql.unsafe(
            `INSERT INTO domain_events (
              event_id,project_id,sequence,event_type,event_version,occurred_at,
              aggregate_ref,actor,caused_by_command_id,caused_by_event_id,
              correlation_ref,payload_json
            ) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)`,
            [
              `evt_018f2b3c-4d5e-7abc-8def-${String(sequence).padStart(12, "0")}`,
              p7Project,
              sequence,
              eventType,
              eventVersion,
              "t",
              p7Project,
              p7TestActor,
              JSON.stringify(payload),
            ],
          );
        }),
      );
    } else {
      yield* tx.transact(journal.append([event]));
    }
  });

export const countEvents = (eventType: string) =>
  sqlCount("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?", [
    eventType,
  ]);

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

export const seedDependencyAndDeliverable = (
  dep: DependencyId,
  del: DeliverableId,
  consumerWork: WorkId,
  producerWork: WorkId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId: dep,
          consumerWorkId: consumerWork,
          producerBinding: { _tag: "AnyProducer" } as ProducerBinding,
          revision: REV(0),
          expectedDeliverable: expectedOf("report", ["summary"]),
        }),
        p7Project,
      ),
    );
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId: del,
          sourceWorkId: producerWork,
          sourceWorkRevision: 0,
          kind: "report",
        },
        [{ role: "summary", artifactId: F_ART }],
        p7Project,
      ),
    );
  });

export const producedPayload = (del: DeliverableId, producerWork: WorkId) => ({
  deliverableId: del,
  sourceWorkId: producerWork,
  sourceWorkRevision: 0,
  kind: "report",
  artifactRoles: ["summary"],
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
        listUnsatisfiedByProject: (projectId: ProjectId) =>
          tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
      },
      deliverables: {
        findById: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.findById(deliverableId)),
        listArtifactRoles: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.listArtifactRoles(deliverableId)),
        deliverablesByProject: (projectId: ProjectId) =>
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

/** One-shot pre-commit interruption at the gateway (WF1/WF3): the first
 * matching submission dies with the transient operational class. */
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

/** Gateway wrapper: arm the commit gate after the handler's command
 * transaction landed (CC mid-batch injection point). */
export const armingGateway = (
  gateway: CommandGatewayService,
  gate: { armed: boolean },
): CommandGatewayService => ({
  execute: (envelope, context, authority) =>
    gateway.execute(envelope, context, authority).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          gate.armed = true;
        }),
      ),
    ) as never,
});

export const INSERT_EXECUTION_G = (executionId: string) =>
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

export const settleCompletedG = (executionId: string) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    const lease = yield* tx.transact(
      leases.acquire(
        executionId as never as ExecutionId,
        "worker:story-g",
        "inc-story-g",
      ),
    );
    const payload: SettleExecutionPayload = {
      executionId: executionId as never as ExecutionId,
      settlement: {
        ...yieldedSettlement,
      },
      expectedFencingGeneration: lease.generation,
    };
    const commandId = `cmd_settle_p9ag_${executionId}` as never as CommandId;
    return yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: p7Project,
        actor: p7TestActor,
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
          actor: p7TestActor,
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
