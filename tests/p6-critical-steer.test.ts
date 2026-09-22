import { Cause, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
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
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeSteerWorkHandler,
  type SteerWorkPayload,
  type SteerWorkResult,
} from "../packages/application/src/commands/steer-work.js";
import {
  type CriticalSteerCommitted,
  type SubmitCriticalSteerArgs,
  submitCriticalSteer,
} from "../packages/application/src/critical-steer.js";
import {
  type AssignWorkPayload,
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  CommandId,
  type ExecutionId,
  ExecutionId as ExeId,
  parse,
  Revision,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  makeP2CommandHandlers,
  makeStopExecutionHandler,
  type StopExecutionPayload,
  type StopExecutionResult,
} from "../packages/execution-runtime/src/index.js";
import {
  ExecutionRepository,
  InboxProjectionStore,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
} from "./support/p6-app.js";

const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");
const mainExecutionId = parse(ExeId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const assignCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const admitCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
const commitSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const commitStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const staleSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e2",
);
const staleStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const normalSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const normalStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d4",
);

const CriticalSteerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const workWaits = yield* WorkWaitStore;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
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

/** Self-contained Critical Steer harness (p6-steer/p6-app assembly copied;
 * those files are frozen for this task). Fixed clock keeps issuedAt="t". */
const makeCriticalSteerApp = (
  filename = ":memory:",
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
  const registry = Layer.provide(CriticalSteerRegistryLive, storeDeps);
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

const assignWorkPayload: AssignWorkPayload = {
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

const seedWork = Effect.gen(function* () {
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

const admitMainExecution = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const payload = {
    _tag: "WorkspaceMain" as const,
    executionId: mainExecutionId,
    workspaceId: p6RootWorkspace,
    focus: { _tag: "Coordination" as const },
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

const buildHandlers = Effect.gen(function* () {
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

const criticalPayload = (
  overrides: Partial<SteerWorkPayload> = {},
): SteerWorkPayload => ({
  workId,
  workspaceId: p6RootWorkspace,
  steer: { severity: "Critical", guidance: "cnt-critical-guidance-001" },
  expectedWorkRevision: parse(WorkRevision)(0),
  provenance: { source: "HumanInput" },
  ...overrides,
});

const criticalSteerSubmission = (
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
        schemaVersion: "1",
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

const workRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ lifecycle: string; revision: number }>(
    "SELECT lifecycle, revision FROM works WHERE work_id = ?",
    [workId],
  );
});

const executionRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ stop_requested_at: string | null }>(
    "SELECT stop_requested_at FROM executions WHERE execution_id = ?",
    [mainExecutionId],
  );
});

const inboxEntries = Effect.gen(function* () {
  const inbox = yield* InboxProjectionStore;
  const tx = yield* TransactionPort;
  return yield* tx.transact(inbox.listUnconsumed(p6RootWorkspace));
});

describe("p6-critical-steer", () => {
  it("commits WorkSteered and stopRequestedAt in the same transaction (04 §4)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const outcome = yield* tx.transact(
        submitCriticalSteer(
          criticalSteerSubmission(handlers, {
            steerCommandId: commitSteerCommandId,
            stopCommandId: commitStopCommandId,
            payload: criticalPayload(),
            executionId,
          }),
        ),
      );
      return {
        outcome,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    const outcome: CriticalSteerCommitted<StopExecutionResult> = result.outcome;
    expect(outcome._tag).toBe("CriticalSteerCommitted");
    expect(outcome.steer.result.severity).toBe("Critical");
    expect(outcome.steer.result.fromRevision).toBe(0);
    expect(outcome.steer.result.toRevision).toBe(1);
    // P10 `06` §2 back-fill: a committed human steer pairs WorkSteered
    // with HumanInterventionApplied(CriticalSteer) in the same events
    // array (the P6 primary event stays first).
    expect(outcome.steer.events).toHaveLength(2);
    expect(outcome.steer.events[0]?.eventType).toBe("WorkSteered");
    expect(outcome.steer.events[0]?.payload).toEqual({
      workId,
      fromRevision: 0,
      toRevision: 1,
      severity: "Critical",
    });
    expect(outcome.steer.events[1]?.eventType).toBe("HumanInterventionApplied");
    expect(outcome.stop.result.stopRequestedAt).toBe("t");
    expect(outcome.stop.events).toHaveLength(1);
    expect(outcome.stop.events[0]?.eventType).toBe("ExecutionStopRequested");
    expect(result.work[0]?.lifecycle).toBe("Open");
    expect(result.work[0]?.revision).toBe(1);
    expect(result.execution[0]?.stop_requested_at).toBe("t");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("HumanInput");
  });

  it("rejects the stale-revision steer without stopping the execution (atomicity)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const outcome = yield* tx
        .transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: staleSteerCommandId,
              stopCommandId: staleStopCommandId,
              payload: criticalPayload({
                expectedWorkRevision: parse(WorkRevision)(5),
              }),
              executionId,
            }),
          ),
        )
        .pipe(
          Effect.catchTag("CriticalSteerRejected", (failure) =>
            Effect.succeed(failure),
          ),
        );
      return {
        outcome,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.outcome._tag).toBe("CriticalSteerRejected");
    if (result.outcome._tag === "CriticalSteerRejected") {
      expect(result.outcome.stage).toBe("SteerWork");
      expect(result.outcome.rejection._tag).toBe("RevisionConflict");
    }
    expect(result.work[0]?.revision).toBe(0);
    expect(result.execution[0]?.stop_requested_at).toBeNull();
    expect(result.entries).toHaveLength(0);
  });

  it("defects on Normal severity (this path is Critical-only) and mutates nothing", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const exit = yield* Effect.exit(
        tx.transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: normalSteerCommandId,
              stopCommandId: normalStopCommandId,
              payload: criticalPayload({
                steer: {
                  severity: "Normal",
                  guidance: "cnt-normal-guidance-001",
                },
              }),
              executionId,
            }),
          ),
        ),
      );
      return { exit, work: yield* workRow, execution: yield* executionRow };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) {
      expect(
        result.exit.cause.reasons.some((reason) => Cause.isDieReason(reason)),
      ).toBe(true);
    }
    expect(result.work[0]?.revision).toBe(0);
    expect(result.execution[0]?.stop_requested_at).toBeNull();
  });
});
