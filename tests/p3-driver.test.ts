import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  layer,
  P15_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { FakeProviderLive } from "../adapters/provider-fake/src/index.js";
import {
  type AgentActionHandler,
  AgentDriverLive,
  type ExecutableInvocationHandler,
  makeControlToolRegistry,
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
  ControlToolCatalogPort,
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
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
const makeApp = (
  turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>,
  options: {
    readonly environmentRevisions?: Layer.Layer<EnvironmentRevisionStore>;
    readonly controlHandlers?: ReadonlyArray<AgentActionHandler>;
    readonly executableHandler?: ExecutableInvocationHandler;
    readonly toolDefinitions?: ReadonlyArray<ModelFacingToolDefinition>;
  } = {},
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const provider = FakeProviderLive({ turns });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const definitions = options.toolDefinitions ?? [];
  const tools = Layer.succeed(ToolCatalogPort, {
    visibleRefs: () =>
      Effect.succeed(
        definitions.map(({ name, version, hash }) => ({ name, version, hash })),
      ),
    resolveForModel: (ref) => {
      const tool = definitions.find(
        (candidate) =>
          candidate.name === ref.name &&
          candidate.version === ref.version &&
          candidate.hash === ref.hash,
      );
      return tool === undefined
        ? Effect.die(`no tool definition for ${ref.name}`)
        : Effect.succeed(tool);
    },
  });
  const defaultSendHandler: AgentActionHandler = {
    action: "SendMessage",
    handle: () =>
      Effect.succeed({
        _tag: "Settle",
        settlement: {
          _tag: "Completed",
          result: { _tag: "CoordinationCompleted" },
        },
      }),
  };
  const controlRegistry = makeControlToolRegistry(
    options.controlHandlers ?? [defaultSendHandler],
  );
  const controlToolCatalog = Layer.succeed(ControlToolCatalogPort, {
    visibleDefinitions: controlRegistry.visibleDefinitions,
  });
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills, tools, controlToolCatalog),
  );
  const environmentRevisions =
    options.environmentRevisions ??
    Layer.provide(EnvironmentRevisionStoreLive, infra);
  const driver = Layer.provide(
    AgentDriverLive([], {
      controlRegistry,
      ...(options.executableHandler !== undefined
        ? { executableInvocationHandler: options.executableHandler }
        : {}),
    }),
    Layer.mergeAll(
      modelContext,
      providerRuntime,
      capability,
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(HumanMessageStoreLive, infra),
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
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
) =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
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
const sendMessageTurn = (body: string) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_send_message",
    argumentsJson: JSON.stringify({
      kind: "Query",
      body,
      recipientWorkspaceId: String(workspaceId),
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

describe("P3-013 agent driver", () => {
  it("runs text then routes a registered control invocation to settlement", async () => {
    const app = makeApp([textTurn, sendMessageTurn("question")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string };
    };
    expect(settlement._tag).toBe("Completed");
    expect(settlement.result?._tag).toBe("CoordinationCompleted");
  });

  it("stops at the P2 safety gate", async () => {
    const app = makeApp([textTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
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

const invalidTurn: ReadonlyArray<CanonicalProviderEvent> = [
  { _tag: "TurnCompleted", finishReason: "Stop" },
];
const readToolTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "read",
    argumentsJson: JSON.stringify({ path: "README.md" }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

describe("P3-013 recovery — bounded repair + DecisionStale (B-9)", () => {
  it("repairs an empty provider turn and continues to a registered control action", async () => {
    const app = makeApp([invalidTurn, sendMessageTurn("recovered")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(result.turns).toBe(2);
  });

  it("settles Failed after bounded repair attempts are exhausted", async () => {
    const app = makeApp([invalidTurn, invalidTurn, invalidTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
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
    let invoked = 0;
    const sendHandler: AgentActionHandler = {
      action: "SendMessage",
      handle: () => {
        invoked += 1;
        return Effect.succeed({
          _tag: "Settle",
          settlement: {
            _tag: "Completed",
            result: { _tag: "CoordinationCompleted" },
          },
        });
      },
    };
    const app = makeApp(
      [sendMessageTurn("stale then fresh"), sendMessageTurn("fresh")],
      {
        environmentRevisions: scriptedEnvironmentRevisions([
          "0",
          "1",
          "1",
          "1",
        ]),
        controlHandlers: [sendHandler],
      },
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(invoked).toBe(1);
    expect(result.turns).toBe(2);
  });

  it("routes executable invocations to the executable handler", async () => {
    let invoked = 0;
    const app = makeApp([readToolTurn, sendMessageTurn("read completed")], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "ReadOnly",
        },
      ],
      executableHandler: {
        handle: () => {
          invoked += 1;
          return Effect.succeed({
            _tag: "Observation",
            source: "Tool",
            observation: { text: "read", truncated: false },
          });
        },
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      return yield* driveAndCount(allowGate);
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(invoked).toBe(1);
    expect(result.turns).toBeGreaterThan(0);
  });
});
