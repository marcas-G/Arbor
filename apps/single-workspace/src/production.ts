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
  type ParentUserGovernanceFacts,
  planSnapshotRetention,
  pruneSnapshots,
  type RetentionPolicy,
  runConversationSettlementSweep,
  runConversationTrigger,
  type SnapshotPruningResult,
  type SnapshotRetentionError,
  type SnapshotRetentionPlan,
  type VerificationConsumerDependencies,
} from "@arbor/application";
import type { Principal, ProjectId } from "@arbor/domain";
import { startupRecovery, sweepRecovery } from "@arbor/execution-runtime";
import { P14_MIGRATIONS, runMigrations } from "@arbor/persistence-sqlite";
import {
  AcceptanceRepository,
  BlobStorePort,
  Clock,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  EnvironmentResolverPort,
  EnvironmentRevisionStore,
  ExecutionRepository,
  type ExecutionScheduler,
  HumanMessageStore,
  type IdGenerator,
  type LeaseService,
  type PermissionGrantRepository,
  ProjectionQueryPort,
  ProjectionStore,
  ProjectRepository,
  type ReconciliationSource,
  RecordEnvironmentChange,
  type SchedulerTimerStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { T1RecoveryState } from "./health.js";
import { makeResponseBodyOf } from "./response-body.js";
import type { AuthenticatorService } from "./transport/auth.js";
import {
  type ConsumerLoopDaemon,
  completionConsumerDaemon,
  type DriftWatcherTrigger,
  driftWatcherFromDeps,
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
  | PermissionGrantRepository;

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
  | ReconciliationSource
  | ExecutionScheduler
  | SchedulerTimerStore
  | IdGenerator
  | VerificationRepository
  | AcceptanceRepository
  | WorkRepository
  | WorkspaceRepository
  | EnvironmentResolverPort
  | RecordEnvironmentChange
  | EnvironmentRevisionStore
  | BlobStorePort
  | T1RecoveryState
  | HumanMessageStore
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
      const journal = yield* DomainEventJournal;
      const offsets = yield* ConsumerOffsetStore;
      const deadLetters = yield* ConsumerDeadLetterStore;
      const projection = yield* ProjectionStore;
      const verifications = yield* VerificationRepository;
      const acceptances = yield* AcceptanceRepository;
      const works = yield* WorkRepository;
      const workspaces = yield* WorkspaceRepository;
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
      if (config.projectId !== undefined) {
        const projectId = config.projectId;
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
        consumers.push(
          verificationConsumerDaemon({
            consumerId: "verification",
            projectId,
            batchSize: config.batchSize ?? 50,
            stores,
            principal: config.principal,
            dependencies: verificationDeps,
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

      const conversationTick =
        config.projectId === undefined
          ? undefined
          : Effect.asVoid(
              Effect.gen(function* () {
                const messages = yield* HumanMessageStore;
                const projects = yield* ProjectRepository;
                const executions = yield* ExecutionRepository;
                const gateway = yield* CommandGateway;
                const clock = yield* Clock;
                const projectId = config.projectId as ProjectId;
                const sql = yield* SqlClient;
                const responseBodyOf = makeResponseBodyOf(sql);
                // Settle sweep first (Claimed → Answered / stale rollback),
                // then admit the FIFO-oldest pending message when idle.
                yield* tx.transact(
                  runConversationSettlementSweep(
                    { messages, executions, clock, responseBodyOf },
                    projectId,
                  ),
                );
                yield* runConversationTrigger(
                  {
                    gateway,
                    messages,
                    projects,
                    executions,
                    clock,
                    tx,
                    principal: config.principal,
                  },
                  projectId,
                );
              }),
            );

      const daemon = makeProductionDaemon({
        migrate: runMigrations(P14_MIGRATIONS),
        recovery,
        consumers,
        ...(conversationTick === undefined ? {} : { conversationTick }),
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
