import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthorityResolverPort,
  CommandGateway,
  type CommandHandlerRegistry,
  type CompletionConsumerDependencies,
  type ConsumerLoopStores,
  type EnvironmentDriftDeps,
  ensureVerifierSpawned,
  type ParentUserGovernanceFacts,
  planSnapshotRetention,
  pruneSnapshots,
  type RetentionPolicy,
  runConversationResponseSettlementSweep,
  runConversationResponseTrigger,
  runVerificationConsumer,
  type SnapshotPruningResult,
  type SnapshotRetentionError,
  type SnapshotRetentionPlan,
  type VerificationConsumerDependencies,
} from "@arbor/application";
import type { Principal, ProjectId } from "@arbor/domain";
import {
  runExecution,
  startupRecovery,
  sweepRecovery,
} from "@arbor/execution-runtime";
import { P22_MIGRATIONS, runMigrations } from "@arbor/persistence-sqlite";
import {
  AcceptanceRepository,
  type AgentExecutionStateStore,
  BlobStorePort,
  Clock,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  ConversationAttemptStore,
  ConversationResponseJobStore,
  DomainEventJournal,
  EnvironmentResolverPort,
  EnvironmentRevisionStore,
  type ExecutionDriverPort,
  ExecutionRepository,
  type ExecutionScheduler,
  FormationProposalStore,
  type IdGenerator,
  type LeaseService,
  type OwnershipWriteService,
  type PermissionGrantRepository,
  type ProjectEnvironmentPort,
  ProjectionQueryPort,
  ProjectionStore,
  ProjectRepository,
  ProviderDeploymentBreaker,
  type ReconciliationSource,
  RecordEnvironmentChange,
  type ResourceOwnershipRepository,
  type RuntimeSafetyGate,
  type SchedulerTimerStore,
  TransactionPort,
  VerificationRepository,
  type WorkerDispatchPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { T1RecoveryState } from "./health.js";
import { makeResponseBodyOf } from "./response-body.js";
import type { AuthenticatorService } from "./transport/auth.js";
import {
  publishConversationSettled,
  registerExecutionMessageLink,
} from "./transport/conversation-progress-bridge.js";
import {
  type ConsumerLoopDaemon,
  completionConsumerDaemon,
  type DriftWatcherTrigger,
  driftWatcherFromDeps,
  formationConsumerDaemon,
  makeProductionDaemon,
  type ProductionDaemon,
  type RecoveryDaemon,
  verificationConsumerDaemon,
} from "./transport/daemons.js";
import {
  type CliShell,
  type ExternalSubmissionPort,
  type HttpShell,
  makeCliShell,
  makeExternalSubmissionFromServices,
  makeHttpShell,
  makeTransportCore,
  makeWebShell,
  makeWebSocketShell,
  type TransportCore,
  viewQueryFaceFromPort,
  type WebShell,
  type WebSocketShell,
} from "./transport/index.js";

/**
 * B-7 — the production deployment surfaces (P12 `10` §5, F6).
 *
 * All wiring is composition-root wiring (`apps/*`): the transport boundary,
 * the production daemon (migrate + T1 startup recovery + offset-driven
 * consumer loops), the drift-watcher probe trigger, and the snapshot-retention
 * ops surface. No daemon is a new package and none mutates canonical state
 * directly — they submit through the `CommandGateway` / Application ports
 * (CI-1). No alternative parallel runtime is introduced.
 */

// --- transport boundary ----------------------------------------------------

export interface TransportBoundaryService {
  readonly submission: ExternalSubmissionPort;
  readonly core: TransportCore;
  readonly http: HttpShell;
  readonly webSocket: WebSocketShell;
  readonly cli: CliShell;
  readonly web: WebShell;
  /** The transport-boundary authenticator (P12 `10` §3) — exposed for
   * app-level transport surfaces (conversation-progress SSE ownership). */
  readonly authenticator: AuthenticatorService;
}

export class TransportBoundary extends Context.Service<
  TransportBoundary,
  TransportBoundaryService
>()("arbor/TransportBoundary") {}

export type TransportBoundaryServices =
  | ProjectionQueryPort
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkRepository
  | PermissionGrantRepository
  | Clock
  | IdGenerator
  | ExecutionScheduler
  | ProjectEnvironmentPort
  | OwnershipWriteService
  | ResourceOwnershipRepository;

/** The production transport boundary: the composition-root submission face
 * (resolver + canonicalFacts/grants loading) plus the P12 shells bound to the
 * frozen `ProjectionQueryPort` read face. */
export const TransportBoundaryLive = (
  authenticator: AuthenticatorService,
  governance: ParentUserGovernanceFacts,
): Layer.Layer<TransportBoundary, never, TransportBoundaryServices> =>
  Layer.effect(
    TransportBoundary,
    Effect.gen(function* () {
      const queryPort = yield* ProjectionQueryPort;
      const submission = yield* makeExternalSubmissionFromServices(governance);
      const core = makeTransportCore({
        views: viewQueryFaceFromPort(queryPort),
        authenticator,
        submission,
      });
      return TransportBoundary.of({
        submission,
        core,
        http: makeHttpShell(core),
        webSocket: makeWebSocketShell(core),
        cli: makeCliShell(core),
        authenticator,
        web: makeWebShell(core),
      });
    }),
  );

// --- production daemon -----------------------------------------------------

export interface ProductionDaemonServiceShape<R = never> {
  readonly daemon: ProductionDaemon<R>;
  readonly recovery: RecoveryDaemon<R>;
  readonly consumers: ReadonlyArray<ConsumerLoopDaemon<R>>;
  readonly driftWatcher: DriftWatcherTrigger;
}

export class ProductionDaemonService extends Context.Service<
  ProductionDaemonService,
  ProductionDaemonServiceShape<ProductionDaemonServices>
>()("arbor/ProductionDaemonService") {}

export interface ProductionDaemonConfig {
  readonly projectId?: ProjectId;
  readonly principal: Principal;
  readonly batchSize?: number;
  readonly bindingFingerprint: string;
  readonly configurationRevision: string;
}

export type ProductionDaemonServices =
  | SqlClient
  | Clock
  | CommandGateway
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
  | ExecutionRepository
  | LeaseService
  | AgentExecutionStateStore
  | ExecutionDriverPort
  | WorkerDispatchPort
  | RuntimeSafetyGate
  | ReconciliationSource
  | ExecutionScheduler
  | SchedulerTimerStore
  | IdGenerator
  | VerificationRepository
  | AcceptanceRepository
  | WorkRepository
  | WorkspaceRepository
  | FormationProposalStore
  | EnvironmentResolverPort
  | RecordEnvironmentChange
  | EnvironmentRevisionStore
  | BlobStorePort
  | T1RecoveryState
  | ConversationResponseJobStore
  | ConversationAttemptStore
  | ProviderDeploymentBreaker
  | ProjectRepository;

/** The production daemon assembly. `start` = migrations -> T1 startup recovery
 * -> mark readiness; `recoveryTick` = T2/T3 sweep; `pollConsumers` = one
 * offset-driven poll per consumer. */
export const ProductionDaemonServiceLive = (
  config: ProductionDaemonConfig,
): Layer.Layer<ProductionDaemonService, never, ProductionDaemonServices> =>
  Layer.effect(
    ProductionDaemonService,
    Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      const deadLetters = yield* ConsumerDeadLetterStore;
      const projection = yield* ProjectionStore;
      const verifications = yield* VerificationRepository;
      const acceptances = yield* AcceptanceRepository;
      const works = yield* WorkRepository;
      const proposals = yield* FormationProposalStore;
      const workspaces = yield* WorkspaceRepository;
      const executions = yield* ExecutionRepository;
      const gateway = yield* CommandGateway;
      const t1 = yield* T1RecoveryState;
      const resolver = yield* EnvironmentResolverPort;
      const changes = yield* RecordEnvironmentChange;
      const revisions = yield* EnvironmentRevisionStore;
      const blobs = yield* BlobStorePort;

      const stores: ConsumerLoopStores = {
        tx,
        journal,
        offsets,
        deadLetters,
        projection,
      };

      const consumers: Array<ConsumerLoopDaemon<ProductionDaemonServices>> = [];
      // Product shape: consumers run for EVERY open project, discovered at
      // TICK time (after migrations), incrementally registered — projects
      // created at runtime get consumers without a daemon restart. The
      // explicit config entry is always included first.
      const seenConsumerProjects = new Set<string>();
      const reconciledLegacyClaims = new Set<string>();
      const dynamicConsumers: Array<
        ConsumerLoopDaemon<ProductionDaemonServices>
      > = [];
      const verificationDeps: VerificationConsumerDependencies<never> = {
        gateway,
        verifications: {
          findOpenByWorkRevision: (workId, workRevision) =>
            tx.transact(
              verifications.findOpenByWorkRevision(workId, workRevision),
            ),
          findById: (verificationId) =>
            tx.transact(verifications.findById(verificationId)),
        },
        works: { findById: (workId) => tx.transact(works.findById(workId)) },
        workspaces: {
          findById: (workspaceId) =>
            tx.transact(workspaces.findById(workspaceId)),
        },
        executions: {
          findById: (executionId) =>
            tx.transact(executions.findById(executionId)),
        },
      };
      const completionDeps: CompletionConsumerDependencies = {
        gateway,
        verifications: {
          findById: (verificationId) =>
            tx.transact(verifications.findById(verificationId)),
        },
        acceptances: {
          findByWorkRevision: (workId, workRevision) =>
            tx.transact(acceptances.findByWorkRevision(workId, workRevision)),
        },
        works: { findById: (workId) => tx.transact(works.findById(workId)) },
      };

      const registerProjectConsumers = Effect.gen(function* () {
        const consumerSql = yield* SqlClient;
        const openRows = yield* Effect.orDie(
          consumerSql.unsafe<{ project_id: string }>(
            "SELECT project_id FROM projects WHERE lifecycle = 'Open'",
          ),
        );
        if (config.projectId !== undefined) {
          seenConsumerProjects.add(String(config.projectId));
        }
        for (const row of openRows) {
          seenConsumerProjects.add(row.project_id);
        }
        for (const projectIdValue of seenConsumerProjects) {
          const projectId = projectIdValue as never;
          if (!reconciledLegacyClaims.has(projectIdValue)) {
            let sequence = 0;
            while (true) {
              const historical = yield* tx.transact(
                journal.readAfter(projectId, sequence, 500),
              );
              if (historical.length === 0) break;
              const claimEvents = historical.filter(
                (event) => event.eventType === "ExecutionSettled",
              );
              if (claimEvents.length > 0) {
                yield* runVerificationConsumer(
                  claimEvents.map((event) => ({
                    eventType: event.eventType,
                    payload: event.payload,
                    eventId: String(event.eventId),
                  })),
                  verificationDeps,
                  projectId,
                  config.principal,
                );
              }
              sequence = historical.at(-1)?.sequence ?? sequence;
              if (historical.length < 500) break;
            }
            reconciledLegacyClaims.add(projectIdValue);
          }
          if (
            dynamicConsumers.some(
              (consumer) => String(consumer.projectId) === projectIdValue,
            )
          ) {
            continue;
          }
          dynamicConsumers.push(
            formationConsumerDaemon({
              consumerId: "formation",
              projectId,
              batchSize: config.batchSize ?? 50,
              stores,
              dependencies: {
                gateway,
                workspaces: {
                  findById: (workspaceId) =>
                    tx.transact(workspaces.findById(workspaceId)),
                },
                proposals: {
                  findById: (proposalId) =>
                    tx.transact(proposals.findById(proposalId)),
                },
              },
            }),
            verificationConsumerDaemon({
              consumerId: "verification",
              projectId,
              batchSize: config.batchSize ?? 50,
              stores,
              principal: config.principal,
              dependencies: verificationDeps as never,
            }),
            completionConsumerDaemon({
              consumerId: "completion",
              projectId,
              batchSize: config.batchSize ?? 50,
              stores,
              principal: config.principal,
              dependencies: completionDeps,
            }),
          );
        }
      }).pipe(Effect.asVoid);
      const spawnOpenVerifiers = Effect.gen(function* () {
        const consumerSql = yield* SqlClient;
        const rows = yield* consumerSql.unsafe<{
          verification_id: string;
          work_id: string;
          project_id: string;
        }>(
          "SELECT verification_id, work_id, project_id FROM verifications WHERE state = 'Open' ORDER BY created_at, verification_id",
        );
        for (const row of rows) {
          const verification = yield* tx.transact(
            verifications.findById(row.verification_id as never),
          );
          const work = yield* tx.transact(works.findById(row.work_id as never));
          if (Option.isNone(verification) || Option.isNone(work)) continue;
          const verifierExecutionId =
            verification.value.verificationExecutionIds[0];
          if (verifierExecutionId === undefined) continue;
          const mission = verification.value.missionSnapshot;
          const required = mission.criteria.filter(
            (criterion) => criterion.required,
          ).length;
          yield* ensureVerifierSpawned(
            {
              verification: verification.value,
              projectId: row.project_id as never,
              ownerWorkspaceId: work.value.workspaceId,
              verifierExecutionId,
              missionDigest: `${mission.goal} [criteria=${mission.criteria.length} required=${required}]`,
            },
            {
              gateway,
              verifications,
              executions,
              tx,
              clock,
              principal: config.principal,
            },
          );
        }
      }).pipe(Effect.asVoid);
      consumers.push({
        consumerId: "dynamic-project-consumers",
        projectId: config.projectId ?? ("" as never),
        batchSize: config.batchSize ?? 50,
        poll: Effect.flatMap(registerProjectConsumers, () =>
          Effect.flatMap(
            Effect.forEach(dynamicConsumers, (consumer) => consumer.poll, {
              concurrency: 1,
            }),
            () => spawnOpenVerifiers,
          ),
        ) as never,
      });

      const driftDeps: EnvironmentDriftDeps = {
        resolver,
        changes: {
          latestChange: (projectId) =>
            Effect.mapError(
              tx.transact(changes.latestChange(projectId)),
              (cause) => ({ _tag: "ChangeReadFailure" as const, cause }),
            ),
        },
        revisions: {
          current: (projectId) =>
            Effect.mapError(
              tx.transact(revisions.current(projectId)),
              (cause) => ({ _tag: "RevisionReadFailure" as const, cause }),
            ),
        },
        anchoredSnapshot: {
          readBlob: (blobRef) =>
            Effect.mapError(
              Effect.map(blobs.get(blobRef), (bytes) =>
                new TextDecoder().decode(bytes),
              ),
              (cause) => ({
                _tag: "AnchoredSnapshotReadFailure" as const,
                cause,
              }),
            ),
        },
      };

      const recovery: RecoveryDaemon<ProductionDaemonServices> = {
        startup: Effect.asVoid(
          Effect.flatMap(
            startupRecovery(config.principal),
            () => t1.markComplete,
          ),
        ),
        sweep: Effect.asVoid(sweepRecovery(config.principal)),
      };

      const conversationTick = Effect.asVoid(
        Effect.gen(function* () {
          const jobs = yield* ConversationResponseJobStore;
          const attempts = yield* ConversationAttemptStore;
          const breaker = yield* ProviderDeploymentBreaker;
          const projects = yield* ProjectRepository;
          const executions = yield* ExecutionRepository;
          const gateway = yield* CommandGateway;
          const clock = yield* Clock;
          const sql = yield* SqlClient;
          const responseBodyOf = makeResponseBodyOf(sql);
          // Product shape: the daemon drives EVERY project with conversation
          // work (any project a human submits to must be answered — a
          // single-project filter would silently orphan the rest). Per
          // project, the frozen P14 `02` step is unchanged: settle sweep
          // (Claimed → Answered / stale rollback) first, then admit the
          // FIFO-oldest pending message when idle.
          const activeProjects = yield* tx.transact(jobs.projectsWithWork());
          for (const projectId of activeProjects) {
            yield* tx.transact(
              runConversationResponseSettlementSweep(
                {
                  jobs,
                  attempts,
                  executions,
                  clock,
                  responseBodyOf,
                  breaker,
                  bindingFingerprint: config.bindingFingerprint,
                  configurationRevision: config.configurationRevision,
                },
                projectId,
              ),
            );
            yield* runConversationResponseTrigger(
              {
                gateway,
                jobs,
                attempts,
                breaker,
                bindingFingerprint: config.bindingFingerprint,
                configurationRevision: config.configurationRevision,
                projects,
                executions,
                clock,
                tx,
                principal: config.principal,
              },
              projectId,
            );
            // The P14 trigger admits a durable Coordination execution;
            // the local production composition must also hand that
            // execution to the existing fenced P2/P3 runner. Claims are
            // the exact correlation between a human turn and its main
            // execution, so ordinary Work mains are never selected here.
            const runningJobs = yield* tx.transact(jobs.listRunning(projectId));
            for (const job of runningJobs) {
              if (job.state._tag !== "Running") {
                continue;
              }
              const claimedExecutionId = job.state.executionId;
              const execution = yield* tx.transact(
                executions.findById(claimedExecutionId),
              );
              if (
                Option.isSome(execution) &&
                execution.value.state.status === "Active" &&
                execution.value.binding._tag === "WorkspaceExecution" &&
                execution.value.binding.focus._tag === "Coordination"
              ) {
                // Conversation streaming bridge: link execution → message for
                // the presentation tap, publish terminal at settlement.
                registerExecutionMessageLink(claimedExecutionId, job.messageId);
                const settlement = yield* runExecution(
                  claimedExecutionId,
                  { _tag: "Recovery" },
                  config.principal,
                );
                publishConversationSettled(
                  claimedExecutionId,
                  settlement as { readonly _tag: string },
                );
              }
            }
          }
        }),
      );

      const daemon = makeProductionDaemon({
        migrate: runMigrations(P22_MIGRATIONS),
        recovery,
        consumers,
        conversationTick,
      });

      return ProductionDaemonService.of({
        daemon,
        recovery,
        consumers,
        driftWatcher: driftWatcherFromDeps(driftDeps),
      });
    }),
  );

// --- snapshot retention (ops action) ---------------------------------------

export interface SnapshotRetentionService {
  readonly plan: (
    entries: ReadonlyArray<{
      readonly ref: string;
      readonly capturedAt: string;
    }>,
    policy: RetentionPolicy,
    now: string,
    referencedRefs: ReadonlySet<string>,
  ) => SnapshotRetentionPlan;
  readonly prune: (
    policy: RetentionPolicy,
    now: string,
  ) => Effect.Effect<SnapshotPruningResult, SnapshotRetentionError>;
}

export class SnapshotRetention extends Context.Service<
  SnapshotRetention,
  SnapshotRetentionService
>()("arbor/SnapshotRetention") {}

/** P12 `05` §5.3 — the explicit ops pruning surface over the canonical
 * `environment_changes` catalog and the content-addressed blob store. Pruning
 * is never inline in a canonical transaction and refuses a still-referenced
 * snapshot (typed); canonical records are untouched. */
export const SnapshotRetentionLive = (
  blobRoot: string = join(tmpdir(), "arbor-blobs"),
): Layer.Layer<SnapshotRetention, never, SqlClient> =>
  Layer.effect(
    SnapshotRetention,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const catalog = Effect.gen(function* () {
        const rows = yield* sql.unsafe<{
          snapshot_blob_ref: string;
          recorded_at: string;
        }>(
          "SELECT snapshot_blob_ref, recorded_at FROM environment_changes ORDER BY recorded_at DESC",
        );
        return rows.map((row) => ({
          ref: row.snapshot_blob_ref,
          capturedAt: row.recorded_at,
        }));
      });
      return SnapshotRetention.of({
        plan: planSnapshotRetention,
        prune: (policy, now) =>
          Effect.gen(function* () {
            const entries = yield* Effect.orDie(catalog);
            const referencedRefs = new Set(entries.map((entry) => entry.ref));
            return yield* pruneSnapshots(
              {
                listSnapshots: () => entries,
                listReferencedRefs: () => referencedRefs,
                deleteSnapshot: (ref) =>
                  rmSync(join(blobRoot, ref), { force: true }),
              },
              policy,
              now,
            );
          }),
      });
    }),
  );
