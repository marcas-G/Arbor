import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  P6_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
  type SteerWorkResult,
} from "../../packages/application/src/commands/steer-work.js";
import {
  type CriticalSteerActiveMain,
  type CriticalSteerCommitted,
  type CriticalSteerPreparation,
  makeCriticalSteerCommandHandler,
  type SubmitCriticalSteerArgs,
  submitCriticalSteer,
} from "../../packages/application/src/critical-steer.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  commandErr,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  CommandId,
  type CommandSubmissionContext,
  type ExecutionId,
  ExecutionId as ExeId,
  parse,
  Revision,
  WorkId,
  WorkRevision,
} from "../../packages/domain/dist/index.js";
import {
  makeP2CommandHandlers,
  makeStopExecutionHandler,
  type StopExecutionPayload,
  type StopExecutionResult,
} from "../../packages/execution-runtime/src/index.js";
import {
  ExecutionRepository,
  InboxProjectionStore,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import { workEpisode } from "../support/execution-episode-fixtures.js";
import {
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
} from "../support/workspace-harness.js";

export {
  type AssignWorkPayload,
  CommandGateway,
  type CommandHandler,
  CommandId,
  type CommandSubmissionContext,
  type CriticalSteerActiveMain,
  type CriticalSteerCommitted,
  type CriticalSteerPreparation,
  commandErr,
  Effect,
  type ExecutionId,
  InboxProjectionStore,
  Layer,
  mainExecutionId,
  makeCriticalSteerApp,
  makeCriticalSteerRegistryLive,
  makeStopExecutionHandler,
  Option,
  P6_MIGRATIONS,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
  parse,
  runCriticalSteer,
  runMigrations,
  SqlClient,
  type SteerWorkPayload,
  type SteerWorkResult,
  type StopExecutionPayload,
  type StopExecutionResult,
  type SubmitCriticalSteerArgs,
  semanticRequestFingerprint,
  submitCriticalSteer,
  TransactionPort,
  WorkRevision,
  workEpisode,
  workId,
};

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");
const mainExecutionId = parse(ExeId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);

const makeCriticalSteerRegistryLive = (
  stopHandlerOverride?: (
    handler: CommandHandler<StopExecutionPayload, StopExecutionResult>,
  ) => CommandHandler<StopExecutionPayload, StopExecutionResult>,
): Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | InboxProjectionStore
  | ExecutionRepository
  | WorkWaitStore
> =>
  Layer.effect(
    CommandHandlerRegistry,
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const sessions = yield* SessionRepository;
      const works = yield* WorkRepository;
      const inbox = yield* InboxProjectionStore;
      const executions = yield* ExecutionRepository;
      const workWaits = yield* WorkWaitStore;
      const p2Handlers = makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
        readmissionGate: NoHoldWorkReadmissionGateStoreService,
      }).filter((candidate) => candidate.commandType !== "StopExecution");
      const defaultStopHandler = makeStopExecutionHandler({
        executions,
        executableApprovals: { cancelForExecution: () => Effect.succeed([]) },
      });
      const stopHandler =
        stopHandlerOverride?.(defaultStopHandler) ?? defaultStopHandler;
      const steerHandler = makeSteerWorkHandler({ works, inbox });
      const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
        ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
        ...p2Handlers,
        stopHandler as unknown as CommandHandler<unknown, unknown>,
        makeCriticalSteerCommandHandler({
          steerHandler,
          stopHandler,
          executions,
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
  );

/** Self-contained Critical Steer harness (p6-steer/workspace-harness assembly copied;
 * those files are frozen for this task). Fixed clock keeps issuedAt="t". */
const makeCriticalSteerApp = (
  filename = ":memory:",
  stopHandlerOverride?: (
    handler: CommandHandler<StopExecutionPayload, StopExecutionResult>,
  ) => CommandHandler<StopExecutionPayload, StopExecutionResult>,
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | InboxProjectionStore
  | WorkRepository
  | ExecutionRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const storeDeps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
  );
  const registry = Layer.provide(
    makeCriticalSteerRegistryLive(stopHandlerOverride),
    storeDeps,
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    storeDeps,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | InboxProjectionStore
    | WorkRepository
    | ExecutionRepository
  >;
};

const runCriticalSteer = <A, R>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient | R>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, unknown, CommandGateway | SqlClient>,
        app,
      ),
    ),
  );

export const assignWorkPayload: AssignWorkPayload = {
  workId,
  workspaceId: p6RootWorkspace,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship critical steer",
  why: "P6-012",
  constraints: [],
  completionExpectation: "green",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

export const seedWork = Effect.gen(function* () {
  yield* runMigrations(P6_MIGRATIONS);
  yield* p6SeedProject;
  const gw = yield* CommandGateway;
  const receipt = yield* gw.execute(
    {
      commandType: "AssignWork",
      commandId: assignCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload: assignWorkPayload,
    },
    { _tag: "External", principal: p6TestPrincipal },
    {
      _tag: "AssignWorkAuthority",
      principal: p6TestPrincipal,
      commandId: assignCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AssignWork",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "1",
        payload: assignWorkPayload,
      }),
      projectId: p6Project,
      targetWorkspaceId: p6RootWorkspace,
    },
  );
  if (receipt.resolution._tag !== "Committed") {
    return yield* Effect.die(new Error("seed AssignWork did not commit"));
  }
});

export const admitMainExecution = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const payload = {
    _tag: "WorkspaceMain" as const,
    executionId: mainExecutionId,
    workspaceId: p6RootWorkspace,
    episode: workEpisode(workId),
  };
  const receipt = yield* gw.execute(
    {
      commandType: "AdmitExecution",
      commandId: admitCommandId,
      projectId: p6Project,
      actor: p6TestPrincipal as never,
      issuedAt: "t",
      payload,
    },
    { _tag: "System", principal: p6TestPrincipal, causationRef: "test" },
    {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal: p6TestPrincipal,
      commandId: admitCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId: p6Project,
        actor: p6TestPrincipal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId: p6Project,
      commandKind: "AdmitExecution",
      workspaceId: p6RootWorkspace,
      bindingKind: "WorkspaceMain",
    },
  );
  if (receipt.resolution._tag !== "Committed") {
    return yield* Effect.die(new Error("seed AdmitExecution did not commit"));
  }
  return mainExecutionId;
});

export const buildHandlers = Effect.gen(function* () {
  return {
    steerHandler: makeSteerWorkHandler({
      works: yield* WorkRepository,
      inbox: yield* InboxProjectionStore,
    }),
    stopHandler: makeStopExecutionHandler({
      executions: yield* ExecutionRepository,
    }),
  };
});

export const criticalPayload = (
  overrides: Partial<SteerWorkPayload> = {},
): SteerWorkPayload => ({
  workId,
  workspaceId: p6RootWorkspace,
  steer: { severity: "Critical", guidance: "cnt-critical-guidance-001" },
  expectedWorkRevision: parse(WorkRevision)(0),
  provenance: { source: "HumanInput" },
  ...overrides,
});

export const criticalSteerSubmission = (
  handlers: {
    readonly steerHandler: CommandHandler<SteerWorkPayload, SteerWorkResult>;
    readonly stopHandler: CommandHandler<
      StopExecutionPayload,
      StopExecutionResult
    >;
  },
  args: {
    readonly steerCommandId: CommandId;
    readonly stopCommandId: CommandId;
    readonly payload: SteerWorkPayload;
    readonly executionId: ExecutionId;
  },
): SubmitCriticalSteerArgs<StopExecutionPayload, StopExecutionResult> => {
  const stopPayload: StopExecutionPayload = { executionId: args.executionId };
  return {
    steerEnvelope: {
      commandType: "SteerWork",
      commandId: args.steerCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload: args.payload,
    },
    steerContext: { _tag: "External", principal: p6TestPrincipal },
    steerAuthority: {
      _tag: "SteerWorkAuthority",
      principal: p6TestPrincipal,
      commandId: args.steerCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SteerWork",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "2",
        payload: args.payload,
      }),
      projectId: p6Project,
      targetWorkspaceId: args.payload.workspaceId,
      workId: args.payload.workId,
    },
    stopEnvelope: {
      commandType: "StopExecution",
      commandId: args.stopCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload: stopPayload,
    },
    stopContext: {
      _tag: "System",
      principal: p6TestPrincipal,
      causationRef: `critical-steer:${args.steerCommandId}`,
    },
    stopAuthority: {
      _tag: "StopExecutionAuthority",
      submissionOrigin: "System",
      principal: p6TestPrincipal,
      commandId: args.stopCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "StopExecution",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "1",
        payload: stopPayload,
      }),
      projectId: p6Project,
      commandKind: "StopExecution",
      executionId: args.executionId,
    },
    deps: handlers,
  };
};

export const workRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ lifecycle: string; revision: number }>(
    "SELECT lifecycle, revision FROM works WHERE work_id = ?",
    [workId],
  );
});

export const executionRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ stop_requested_at: string | null }>(
    "SELECT stop_requested_at FROM executions WHERE execution_id = ?",
    [mainExecutionId],
  );
});

export const inboxEntries = Effect.gen(function* () {
  const inbox = yield* InboxProjectionStore;
  const tx = yield* TransactionPort;
  return yield* tx.transact(inbox.listUnconsumed(p6RootWorkspace));
});

const assignCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const admitCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
