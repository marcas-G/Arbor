import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P8_MIGRATIONS,
  ProjectionStoreLive,
  ProjectRepositoryLive,
  runMigrations,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeCompleteWorkHandler } from "../../packages/application/src/commands/accept-complete.js";
import { makeSatisfyDependencyHandler } from "../../packages/application/src/commands/satisfy-dependency.js";
import { makeStartVerificationHandler } from "../../packages/application/src/commands/start-verification.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
} from "../../packages/application/src/index.js";
import {
  ExecutionSchedulerLive,
  makeP2CommandHandlers,
  RunnableWorkSourceStubLive,
} from "../../packages/execution-runtime/src/index.js";
import {
  AcceptanceRepository,
  type Clock,
  type ConsumerDeadLetterStore,
  type ConsumerOffsetStore,
  DeliverableRepository,
  type DeliverableRepositoryError,
  DependencyRepository,
  type DomainEventJournal,
  EnvironmentRevisionStore,
  ExecutionRepository,
  type ExecutionScheduler,
  type IdGenerator,
  type LeaseService,
  type ProjectionStore,
  ProjectRepository,
  type ReconciliationSource,
  type SchedulerTimerStore,
  SessionRepository,
  type ToolInvocationStore,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { ReconciliationSourceLive } from "../../packages/tool-runtime/src/index.js";

/** P9-010/P9-012 fixture: the P7/P8 consumers wired onto the P1 consumer
 * infrastructure. One app exposing the gateway (P1 + P2 + SatisfyDependency
 * + StartVerification + CompleteWork handlers), the consumer stores, the
 * repositories the loop dependencies read, and the recovery-drive faces
 * (sweep/scheduler/leases) — p7-app / p8-consumer mini-app precedents. */

export type P9ConsumerAppServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | SchedulerTimerStore
  | ExecutionScheduler
  | DependencyRepository
  | DeliverableRepository
  | VerificationRepository
  | AcceptanceRepository
  | EnvironmentRevisionStore
  | LeaseService
  | ToolInvocationStore
  | ReconciliationSource
  | IdGenerator
  | Clock;

export const P9_CONSUMER_MIGRATIONS = P8_MIGRATIONS;

/** Commit-injection gate (CC-1/RB-2): while armed, the NEXT successful
 * transaction body fails its COMMIT and rolls back (fail-once). Arming
 * between apply and advance — e.g. from a gateway wrapper after the
 * handler's command committed — makes the loop's apply+advance
 * transaction die exactly at the commit boundary. */
export interface CommitGate {
  armed: boolean;
}

export const commitGate = (): CommitGate => ({ armed: false });

export const gatedTransactionPort = (
  gate: CommitGate,
): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError(
            (cause): TransactionOperationalFailure => ({
              _tag: "TransactionOperationalFailure",
              cause,
            }),
          ),
        );
      const transact: TransactionPortService["transact"] = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isSuccess(exit)) {
            if (gate.armed) {
              gate.armed = false;
              yield* run("ROLLBACK");
              return yield* Effect.fail({
                _tag: "TransactionOperationalFailure",
                cause: "injected:fail-on-commit",
              } satisfies TransactionOperationalFailure);
            }
            const commitExit = yield* Effect.exit(run("COMMIT"));
            if (Exit.isFailure(commitExit)) {
              yield* run("ROLLBACK").pipe(Effect.ignore, Effect.orDie);
              return yield* Effect.fail({
                _tag: "TransactionOperationalFailure",
                cause: commitExit,
              } satisfies TransactionOperationalFailure);
            }
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact });
    }),
  );

export const makeP9ConsumerApp = (options?: {
  readonly filename?: string;
  readonly transaction?: Layer.Layer<TransactionPort, never, SqlClient>;
}): Layer.Layer<P9ConsumerAppServices> => {
  const base = layer({ filename: options?.filename ?? ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const transactionLayer =
    options?.transaction === undefined
      ? Layer.provide(TransactionPortLive, infra)
      : Layer.provide(options.transaction, infra);
  const executionRepo = Layer.provide(ExecutionRepositoryLive, infra);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    executionRepo,
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
  );
  const scheduler = Layer.provide(
    ExecutionSchedulerLive,
    Layer.mergeAll(repositories, RunnableWorkSourceStubLive, transactionLayer),
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const workspaces = yield* WorkspaceRepository;
        const sessions = yield* SessionRepository;
        const works = yield* WorkRepository;
        const executions = yield* ExecutionRepository;
        const workWaits = yield* WorkWaitStore;
        const dependencies = yield* DependencyRepository;
        const deliverableService = yield* DeliverableRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        const environmentRevisions = yield* EnvironmentRevisionStore;
        const sql = yield* SqlClient;
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
          ...makeP2CommandHandlers({
            projects,
            workspaces,
            sessions,
            executions,
            workWaits,
          }),
          makeSatisfyDependencyHandler({
            dependencies,
            deliverables: deliverableService,
            works,
          }) as unknown as CommandHandler<unknown, unknown>,
          makeStartVerificationHandler({
            works,
            verifications,
            environmentRevisions,
            deliverables: {
              ...deliverableService,
              // role→artifactId binding read (p8-consumer-a test seam
              // until the port grows an id lister).
              listArtifacts: (deliverableId) =>
                sql
                  .unsafe<{
                    readonly role: string;
                    readonly artifact_id: string;
                  }>(
                    "SELECT role, artifact_id FROM deliverable_artifacts WHERE deliverable_id = ?",
                    [deliverableId],
                  )
                  .pipe(
                    Effect.map((rows) =>
                      rows.map((row) => ({
                        role: row.role,
                        artifactId: row.artifact_id as never,
                      })),
                    ),
                    Effect.mapError(
                      (cause) =>
                        ({
                          _tag: "DeliverableRepositoryFailure",
                          cause,
                        }) as DeliverableRepositoryError,
                    ),
                  ),
            },
          }) as unknown as CommandHandler<unknown, unknown>,
          makeCompleteWorkHandler({
            works,
            workspaces,
            verifications,
            acceptances,
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
    ),
    Layer.mergeAll(repositories, infra),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    transactionLayer,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
    Layer.provide(LeaseServiceLive, Layer.merge(infra, executionRepo)),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.mergeAll(
        Layer.provide(ToolInvocationStoreLive, infra),
        transactionLayer,
      ),
    ),
    scheduler,
    repositories,
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<P9ConsumerAppServices>;
};

export const runP9Consumer = <A>(
  program: Effect.Effect<A, unknown, P9ConsumerAppServices>,
  app: Layer.Layer<P9ConsumerAppServices>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(program, app)));

export const p9Boot = Effect.gen(function* () {
  yield* runMigrations(P9_CONSUMER_MIGRATIONS);
});
