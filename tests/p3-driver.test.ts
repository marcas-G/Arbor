import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentLoopStepStoreLive,
  ClockLive,
  EnvironmentRevisionStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  P17_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  RuntimeClockLive,
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
  AgentLoopStepStore,
  type CanonicalProviderEvent,
  ControlToolCatalogPort,
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  type ProviderExecutionPolicyOverrides,
  type ProviderRunInput,
  ProviderRuntime,
  type RuntimeSafetyGateService,
  SessionRepository,
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
    readonly providerRuntime?: Layer.Layer<ProviderRuntime>;
    readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
    readonly failFirstSourcedAppend?: boolean;
    readonly failFirstOutputAcceptedTransition?: boolean;
  } = {},
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const provider = FakeProviderLive({ turns });
  const providerTurnStore = Layer.provide(ProviderTurnStoreLive, infra);
  const liveAgentLoopSteps = Layer.provide(AgentLoopStepStoreLive, infra);
  const agentLoopSteps =
    options.failFirstOutputAcceptedTransition === true
      ? Layer.provide(
          Layer.effect(
            AgentLoopStepStore,
            Effect.gen(function* () {
              const delegate = yield* AgentLoopStepStore;
              let fail = true;
              return AgentLoopStepStore.of({
                ...delegate,
                transition: (input, fence) => {
                  if (fail && input.next.state === "OutputAccepted") {
                    fail = false;
                    return Effect.fail({
                      _tag: "AgentLoopStepInvariantConflict" as const,
                      reason: "injected-after-session-write",
                    });
                  }
                  return delegate.transition(input, fence);
                },
              });
            }),
          ),
          liveAgentLoopSteps,
        )
      : liveAgentLoopSteps;
  const liveSessions = Layer.provide(SessionRepositoryLive, infra);
  const sessions =
    options.failFirstSourcedAppend === true
      ? Layer.provide(
          Layer.effect(
            SessionRepository,
            Effect.gen(function* () {
              const delegate = yield* SessionRepository;
              let fail = true;
              const rejectOnce = <A, E, R>(
                fallback: Effect.Effect<A, E, R>,
              ) => {
                if (!fail) return fallback;
                fail = false;
                return Effect.fail({
                  _tag: "LeaseFencingRejected" as const,
                  executionId,
                  generation: 0 as never,
                });
              };
              return SessionRepository.of({
                ...delegate,
                appendEntry: (...args) =>
                  rejectOnce(delegate.appendEntry(...args)),
                appendEntryIdempotent: (...args) =>
                  rejectOnce(delegate.appendEntryIdempotent(...args)),
              });
            }),
          ),
          liveSessions,
        )
      : liveSessions;
  const defaultProviderRuntime = Layer.provide(
    ProviderRuntimeLive(),
    Layer.mergeAll(
      provider,
      providerTurnStore,
      Layer.provide(TransactionPortLive, infra),
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const providerRuntime = options.providerRuntime ?? defaultProviderRuntime;
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
      ...(options.executionPolicyOverrides !== undefined
        ? { executionPolicyOverrides: options.executionPolicyOverrides }
        : {}),
    }),
    Layer.mergeAll(
      infra,
      modelContext,
      providerRuntime,
      capability,
      sessions,
      providerTurnStore,
      agentLoopSteps,
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
  workerId: "worker",
  workerIncarnationId: "",
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

const drive = (
  gate: RuntimeSafetyGateService,
  submissionContext: CommandSubmissionContext = context,
) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    return yield* driver.drive({
      execution,
      agentExecutionState: state,
      wakeReason: { _tag: "WorkSelected" },
      context: submissionContext,
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
  it("persists a control settlement in the action ledger before returning", async () => {
    const app = makeApp([sendMessageTurn("settle now")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{
        state: string;
        settlement_ref: string | null;
      }>(
        "SELECT state, settlement_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, actions, stepState: steps[0]?.state };
    });

    const result = await run(program, app);
    expect(result.settlement._tag).toBe("Completed");
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "Applied",
        settlement_ref: expect.stringMatching(/^settlement_/),
      }),
    ]);
    expect(result.stepState).toBe("SettlementProposed");
  });

  it("keeps an OutcomeUnknown action pending reconciliation instead of marking it applied", async () => {
    const app = makeApp([readToolTurn], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "NonIdempotent",
        },
      ],
      executableHandler: {
        handle: () =>
          Effect.succeed({
            _tag: "Settle" as const,
            settlement: {
              _tag: "OutcomeUnknown" as const,
              reconciliation: {
                _tag: "ReconciliationRequired" as const,
                invocationRefs: ["tin_unknown"],
              },
            },
          }),
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ?",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        state: string;
        settlement_json: string | null;
      }>(
        "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, actions, step: steps[0] };
    });

    const result = await run(program, app);
    expect(result.settlement._tag).toBe("OutcomeUnknown");
    expect(result.actions).toEqual([{ state: "ReconciliationPending" }]);
    expect(result.step).toEqual(
      expect.objectContaining({
        state: "SettlementProposed",
        settlement_json: expect.stringContaining("OutcomeUnknown"),
      }),
    );
  });

  it("replays a settled Provider result after the first sourced Session handoff is fenced", async () => {
    const app = makeApp([textTurn], { failFirstSourcedAppend: true });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL)",
        [
          "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
          projectId,
          workspaceId,
          "user:local",
          "hello",
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
          "fp",
          "Claimed",
          executionId,
          "t",
        ],
      );
      const first = yield* Effect.exit(drive(allowGate));
      const second = yield* drive(allowGate);
      const attempts = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_attempts",
      );
      const outputs = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn' AND entry_kind = 'ModelOutput'",
      );
      const steps = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return {
        first,
        second,
        attemptCount: Number(attempts[0]?.count ?? 0),
        outputCount: Number(outputs[0]?.count ?? 0),
        stepState: steps[0]?.state,
      };
    });

    const result = await run(program, app);
    expect(result.first._tag).toBe("Failure");
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "QueryCompleted" },
    });
    expect(result.attemptCount).toBe(1);
    expect(result.outputCount).toBe(1);
    expect(result.stepState).toBe("SettlementProposed");
  });

  it("rolls back the sourced answer when the OutputAccepted step transition is interrupted", async () => {
    const app = makeApp([textTurn], {
      failFirstOutputAcceptedTransition: true,
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL)",
        [
          "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
          projectId,
          workspaceId,
          "user:local",
          "atomic handoff",
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
          "fp-atomic",
          "Claimed",
          executionId,
          "t",
        ],
      );
      const first = yield* Effect.exit(drive(allowGate));
      const afterFirst = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn'",
      );
      const second = yield* drive(allowGate);
      const afterSecond = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn'",
      );
      const attempts = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_attempts",
      );
      return {
        first,
        afterFirst: Number(afterFirst[0]?.count ?? 0),
        second,
        afterSecond: Number(afterSecond[0]?.count ?? 0),
        attempts: Number(attempts[0]?.count ?? 0),
      };
    });

    const result = await run(program, app);
    expect(result.first._tag).toBe("Failure");
    expect(result.afterFirst).toBe(0);
    expect(result.second._tag).toBe("Completed");
    expect(result.afterSecond).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("adopts a legacy settled no-action result after migration without another Provider request", async () => {
    const app = makeApp([textTurn], { failFirstSourcedAppend: true });
    const legacyContext: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal,
      executionId,
      fencingGeneration: 0 as never,
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P16_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL)",
        [
          "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
          projectId,
          workspaceId,
          "user:local",
          "legacy hello",
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
          "fp-legacy",
          "Claimed",
          executionId,
          "t",
        ],
      );
      const first = yield* Effect.exit(drive(allowGate, legacyContext));
      yield* runMigrations(P17_MIGRATIONS);
      const second = yield* drive(allowGate);
      const attempts = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_attempts",
      );
      const outputs = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn' AND entry_kind = 'ModelOutput'",
      );
      const steps = yield* sql.unsafe<{
        state: string;
        migration_provenance_json: string | null;
      }>(
        "SELECT state, migration_provenance_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      const evidence = yield* sql.unsafe<{
        success_evidence_version: string | null;
      }>(
        "SELECT success_evidence_version FROM provider_attempts WHERE provider_turn_id = ?",
        [`ptn_${executionId}_0`],
      );
      return {
        first,
        second,
        attemptCount: Number(attempts[0]?.count ?? 0),
        outputCount: Number(outputs[0]?.count ?? 0),
        step: steps[0],
        evidenceVersion: evidence[0]?.success_evidence_version,
      };
    });

    const result = await run(program, app);
    expect(result.first._tag).toBe("Failure");
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "QueryCompleted" },
    });
    expect(result.attemptCount).toBe(1);
    expect(result.outputCount).toBe(1);
    expect(result.step?.state).toBe("SettlementProposed");
    expect(result.step?.migration_provenance_json).toContain(
      "LegacySettledProviderSuccess",
    );
    expect(result.evidenceVersion).toBe("provider-success-v1");
  });

  it("settles from a durable failed ProviderTurn without calling the provider again", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () => Effect.die("provider must not be called"),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
        [
          `ptn_${executionId}_0`,
          executionId,
          sessionId,
          0,
          "model-a",
          "tool-invocation-v1",
          "mft_failed",
          "t",
          "t2",
          "Failed",
          "{}",
          "t",
        ],
      );
      const settlement = yield* drive(allowGate);
      const steps = yield* sql.unsafe<{
        state: string;
        settlement_json: string | null;
      }>(
        "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, step: steps[0] };
    });

    const result = await run(program, app);
    expect(result.settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderTurnSettled:Failed",
      },
    });
    expect(result.step?.state).toBe("SettlementProposed");
  });

  it("runs text then routes a registered control invocation to settlement", async () => {
    const app = makeApp([textTurn, sendMessageTurn("question")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
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
      yield* runMigrations(P17_MIGRATIONS);
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

  it("settles the execution when a persisted ProviderTurn belongs to a different binding", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "provider-turn-resume-binding-invalid",
          }),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      failure?: { _tag: string; reason?: string };
    };
    expect(settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderTurnBindingChanged",
      },
    });
  });

  it("settles the execution when the ProviderTurn exceeds its stream idle timeout", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderExecutionTimeout",
            phase: "StreamIdleTimeout",
          }),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      failure?: { _tag: string; reason?: string };
    };
    expect(settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderExecutionTimedOut:StreamIdleTimeout",
      },
    });
  });

  it("passes deployment execution-policy overrides to every Provider turn", async () => {
    let received: ProviderRunInput | undefined;
    const overrides = {
      streamIdleTimeoutMs: 90_000,
      turnTimeoutMs: 600_000,
    };
    const app = makeApp([], {
      executionPolicyOverrides: overrides,
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          received = input;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...sendMessageTurn("policy received"),
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = await run(program, app);
    expect(settlement._tag).toBe("Completed");
    expect(received?.executionPolicyOverrides).toEqual(overrides);
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
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const steps = yield* sql.unsafe<{
        repair_attempt: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT repair_attempt, state, successor_json FROM agent_loop_steps WHERE execution_id = ? AND logical_step_no = 0 ORDER BY repair_attempt",
        [executionId],
      );
      return { ...driven, steps };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(result.turns).toBe(2);
    expect(
      (
        result as typeof result & {
          steps: ReadonlyArray<{
            repair_attempt: number;
            state: string;
            successor_json: string | null;
          }>;
        }
      ).steps,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repair_attempt: 0,
          state: "OutputRejected",
          successor_json: expect.stringContaining("repairAttempt"),
        }),
        expect.objectContaining({ repair_attempt: 1 }),
      ]),
    );
  });

  it("settles Failed after bounded repair attempts are exhausted", async () => {
    const app = makeApp([invalidTurn, invalidTurn, invalidTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        logical_step_no: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT logical_step_no, state, successor_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no",
        [executionId],
      );
      return { ...driven, actions, steps };
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
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        logical_step_no: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT logical_step_no, state, successor_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no",
        [executionId],
      );
      return { ...driven, actions, steps };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(invoked).toBe(1);
    expect(result.turns).toBe(2);
    expect(
      (result as typeof result & { actions: ReadonlyArray<{ state: string }> })
        .actions,
    ).toEqual([{ state: "SkippedStale" }]);
    expect(
      (
        result as typeof result & {
          steps: ReadonlyArray<{
            logical_step_no: number;
            state: string;
            successor_json: string | null;
          }>;
        }
      ).steps,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_step_no: 0,
          state: "NextStepReady",
          successor_json: expect.stringContaining("logicalStepNo"),
        }),
        expect.objectContaining({ logical_step_no: 1 }),
      ]),
    );
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
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{
        state: string;
        result_ref: string | null;
        observation_source_ref: string | null;
      }>(
        "SELECT state, result_ref, observation_source_ref FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const observations = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'",
      );
      return {
        ...driven,
        actions,
        observationCount: Number(observations[0]?.count ?? 0),
      };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(invoked).toBe(1);
    expect(result.turns).toBeGreaterThan(0);
    expect(
      (
        result as typeof result & {
          actions: ReadonlyArray<{
            state: string;
            result_ref: string | null;
            observation_source_ref: string | null;
          }>;
          observationCount: number;
        }
      ).actions,
    ).toEqual([
      expect.objectContaining({
        state: "Applied",
        result_ref: expect.stringMatching(/^result_/),
        observation_source_ref: expect.stringMatching(/^observation_/),
      }),
    ]);
    expect(
      (result as typeof result & { observationCount: number }).observationCount,
    ).toBe(1);
  });
});
