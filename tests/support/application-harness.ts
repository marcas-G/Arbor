import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  ConversationResponseJobStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  ProjectRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
  makeP15CommandHandlers,
  P1CommandHandlerRegistryLive,
} from "../../packages/application/src/index.js";
import {
  Actor,
  type CommandId,
  Principal,
  type ProjectId,
  parse,
  type SessionId,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  ConversationResponseJobStore,
  ExecutionRepository,
  InboxProjectionStore,
  ProjectRepository,
  SessionRepository,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import {
  gatewayEventTypes,
  seedProjectViaGateway,
} from "./gateway-fixtures.js";
import { ensureLegacyProjectResourceSourceFixture } from "./legacy-project-resource-source.js";

export const testActor = parse(Actor)("user:test");
export const testPrincipal = parse(Principal)("user:test");

export const makeP1App = (
  filename = ":memory:",
  transaction?: Layer.Layer<TransactionPort, never, SqlClient>,
  includeP15 = false,
): Layer.Layer<CommandGateway | SqlClient> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const transactionLayer =
    transaction === undefined
      ? Layer.provide(TransactionPortLive, infra)
      : Layer.provide(transaction, infra);
  const deps = Layer.mergeAll(
    transactionLayer,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(ConversationResponseJobStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
  );
  const combinedRegistry = Layer.effect(
    CommandHandlerRegistry,
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const sessions = yield* SessionRepository;
      const works = yield* WorkRepository;
      const executions = yield* ExecutionRepository;
      const responseJobs = yield* ConversationResponseJobStore;
      const inbox = yield* InboxProjectionStore;
      const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
        ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
        ...makeP15CommandHandlers({
          projects,
          executions,
          responseJobs,
          inbox,
          executableApprovals: {
            cancelForExecution: () => Effect.succeed([]),
          },
        }),
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
  );
  const registry = includeP15
    ? Layer.provide(combinedRegistry, deps)
    : Layer.provide(P1CommandHandlerRegistryLive, deps);
  const all = Layer.mergeAll(infra, deps, FenceStopCheckInertLive, registry);
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<CommandGateway | SqlClient>;
};

export const runP1 = <A>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const eventTypes = gatewayEventTypes;

export const ensureProjectResourceSourceTestColumn =
  ensureLegacyProjectResourceSourceFixture;

export const seedProject = (args: {
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
}) =>
  seedProjectViaGateway({
    name: "Arbor",
    ...args,
    actor: testActor,
    principal: testPrincipal,
  });

/**
 * Fault-injecting `TransactionPort` for recovery-matrix tests.
 *
 * - `fail-on-begin`: the first `transact` fails before any write (C2/C9).
 * - `rollback-after-body`: the first `transact` runs the body (canonical writes
 *   happen), then ROLLBACKs and fails (C3/C4/C8).
 *
 * Later `transact` calls behave normally so the retryable-attempt trace can be
 * recorded in its own scope.
 */
export const faultingTransaction = (
  mode: "fail-on-begin" | "rollback-after-body",
  injectOn = 1,
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
      const operational: TransactionOperationalFailure = {
        _tag: "TransactionOperationalFailure",
        cause: "injected",
      };
      let calls = 0;
      const transact: TransactionPortService["transact"] = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          calls += 1;
          const injected = calls === injectOn;
          if (injected && mode === "fail-on-begin") {
            return yield* Effect.fail(operational);
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isSuccess(exit)) {
            if (injected) {
              yield* run("ROLLBACK");
              return yield* Effect.fail(operational);
            }
            yield* run("COMMIT");
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact });
    }),
  );
