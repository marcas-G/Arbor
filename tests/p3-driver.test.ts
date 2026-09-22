import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  P3_MIGRATIONS,
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { FakeProviderLive } from "../adapters/provider-fake/src/index.js";
import {
  AgentDriverLive,
  type DirectiveHandler,
} from "../packages/agent-runtime/src/index.js";
import {
  type AgentExecutionState,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ModelContext,
  ModelContextLive,
} from "../packages/model-context/src/index.js";
import {
  type CanonicalProviderEvent,
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  ModelCapabilityPort,
  type RuntimeSafetyGateService,
  SkillRegistry,
  ToolCatalogPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../packages/testkit/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const principal = parse(Principal)("worker:a");

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const state: AgentExecutionState = {
  executionId,
  focus: { _tag: "Coordination" },
  wakeReason: { _tag: "WorkSelected" },
  currentMode: "execute",
  activeSkillRefs: [],
  turnNo: 0,
  recentDirectiveRefs: [],
  recentActionFingerprints: [],
  updatedAt: "t",
};

const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});
const skills = Layer.succeed(SkillRegistry, {
  available: () => Effect.succeed([]),
  load: () => Effect.die("x"),
});
const tools = Layer.succeed(ToolCatalogPort, {
  visibleRefs: () => Effect.succeed([]),
  resolveForModel: () => Effect.die("no tools in test"),
});

const makeApp = (
  turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>,
  options: {
    readonly environmentRevisions?: Layer.Layer<EnvironmentRevisionStore>;
    readonly handlers?: ReadonlyArray<DirectiveHandler>;
  } = {},
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const provider = FakeProviderLive({ turns });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills, tools),
  );
  const environmentRevisions =
    options.environmentRevisions ??
    Layer.provide(EnvironmentRevisionStoreLive, infra);
  const driver = Layer.provide(
    AgentDriverLive(options.handlers ?? []),
    Layer.mergeAll(
      modelContext,
      providerRuntime,
      capability,
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(TransactionPortLive, infra),
      environmentRevisions,
    ),
  );
  return Layer.mergeAll(
    infra,
    driver,
    providerRuntime,
    modelContext,
    capability,
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "coordination",
          sessionId,
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?)",
        [executionId, "worker", 0, "9999-12-31T00:00:00.000Z", "t"],
      );
    }),
  );
});

const context: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
};
const allowGate: RuntimeSafetyGateService = {
  admitActivity: () => Effect.succeed("Continue" as const),
};

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
) =>
  Effect.runPromise(
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

const drive = (gate: RuntimeSafetyGateService) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    return yield* driver.drive({
      execution,
      agentExecutionState: state,
      wakeReason: { _tag: "WorkSelected" },
      context,
      safetyGate: gate,
    });
  });

/** B-9: the drive plus the durable ProviderTurn count, so tests can prove that
 * bounded repair really re-prepared (a new ProviderTurn) and that a stale
 * decision re-prepared rather than executed. */
const driveAndCount = (gate: RuntimeSafetyGateService) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    const settlement = yield* driver.drive({
      execution,
      agentExecutionState: state,
      wakeReason: { _tag: "WorkSelected" },
      context,
      safetyGate: gate,
    });
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM provider_turns",
    );
    return { settlement, turns: Number(rows[0]?.count ?? 0) };
  });

/** B-9: a scripted `EnvironmentRevisionStore` whose `current` face advances
 * through `revisions`, holding the last value afterwards. The driver reads the
 * environment revision to build the turn's ControlBasis and re-reads it at
 * effectful-directive admission, so a change between the two is a real
 * `DecisionStale`. */
const scriptedEnvironmentRevisions = (
  revisions: ReadonlyArray<string>,
): Layer.Layer<EnvironmentRevisionStore> =>
  Layer.effect(
    EnvironmentRevisionStore,
    Effect.sync(() => {
      let calls = 0;
      return EnvironmentRevisionStore.of({
        current: () =>
          Effect.sync(() => {
            const value =
              revisions[Math.min(calls, revisions.length - 1)] ?? "0";
            calls += 1;
            return Option.some(value);
          }),
        record: () => Effect.void,
        lazyInitAnchor: () => Effect.void,
      });
    }),
  );

const textTurn = [
  { _tag: "TextDelta" as const, text: "thinking" },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];
const claimTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "CompletionClaim",
      claim: { claimRef: "claim-1", workRevision: 0 },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

describe("P3-013 agent driver", () => {
  it("runs multiple turns and settles on a CompletionClaim", async () => {
    const app = makeApp([textTurn, claimTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string; claimRef?: string };
    };
    expect(settlement._tag).toBe("Completed");
    expect(settlement.result?._tag).toBe("CompletionClaimed");
    expect(settlement.result?.claimRef).toBe("claim-1");
  });

  it("stops at the P2 safety gate", async () => {
    const app = makeApp([textTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* drive({
        admitActivity: () => Effect.succeed("Stop" as const),
      });
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string; reason?: string };
    };
    expect(settlement._tag).toBe("Interrupted");
    expect(settlement.result?.reason).toBe("RuntimeSafetyStop");

    void ModelContext;
  });
});

const invalidTurn: ReadonlyArray<CanonicalProviderEvent> = [];
const communicateTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "Communicate",
      message: { text: "working" },
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];
const invokeToolTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "InvokeTool",
      intent: { callRef: "c1", toolName: "noop", argumentsJson: "{}" },
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

describe("P3-013 recovery — bounded repair + DecisionStale (B-9)", () => {
  it("repairs a ModelOutputContractViolation and continues the loop to completion", async () => {
    const app = makeApp([invalidTurn, claimTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CompletionClaimed");
    expect(result.turns).toBe(2);
  });

  it("settles Failed after bounded repair attempts are exhausted", async () => {
    const app = makeApp([invalidTurn, invalidTurn, invalidTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; failure?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Failed");
    expect(result.settlement.failure?._tag).toBe("ExecutionFailure");
    expect(result.turns).toBe(3);
  });

  it("does not execute a DecisionStale action and re-prepares instead", async () => {
    let invoked = false;
    const invokeHandler: DirectiveHandler = {
      kind: "InvokeTool",
      handle: () =>
        Effect.sync(() => {
          invoked = true;
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: { text: "ran", truncated: false },
          };
        }),
    };
    const app = makeApp([invokeToolTurn, claimTurn], {
      environmentRevisions: scriptedEnvironmentRevisions(["0", "1", "1", "1"]),
      handlers: [invokeHandler],
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CompletionClaimed");
    expect(invoked).toBe(false);
    expect(result.turns).toBe(2);
  });

  it("recovers after a repair and continues to a later turn", async () => {
    const app = makeApp([invalidTurn, communicateTurn, claimTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CompletionClaimed");
    expect(result.turns).toBe(3);
  });
});
