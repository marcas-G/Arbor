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
  P19_MIGRATIONS,
  P20_MIGRATIONS,
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
  AgentLoopDriverLive,
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
  type TurnProfileResolverService,
} from "../packages/model-context/src/index.js";
import {
  AgentLoopStepStore,
  type CanonicalProviderEvent,
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  type ModelCapability,
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  type PortableModelRequest,
  type ProviderExecutionPolicyOverrides,
  type ProviderFailureKind,
  type ProviderRunInput,
  ProviderRuntime,
  portableInputItems,
  type RuntimeSafetyGateService,
  SessionRepository,
  SkillRegistry,
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
    episode: {
      _tag: "InboxEpisode",
      entryKey: "p3-driver-fixture",
      inputKind: "TestInput",
    },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const state: AgentExecutionState = {
  executionId,
  episode: {
    _tag: "InboxEpisode",
    entryKey: "p3-driver-fixture",
    inputKind: "TestInput",
  },
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
    readonly turnProfileResolver?: TurnProfileResolverService;
    readonly modelCapability?: ModelCapability;
    readonly providerFailures?: ReadonlyArray<ProviderFailureKind>;
  } = {},
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const provider = FakeProviderLive({
    turns,
    ...(options.providerFailures === undefined
      ? {}
      : { failures: options.providerFailures }),
  });
  const capabilityLayer =
    options.modelCapability === undefined
      ? capability
      : Layer.succeed(ModelCapabilityPort, {
          resolve: () =>
            Effect.succeed(options.modelCapability as ModelCapability),
        });
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
  const turnProfileResolver =
    options.turnProfileResolver ??
    ({
      resolve: () =>
        Effect.map(controlRegistry.visibleDefinitions(), (controlTools) => ({
          purpose: "WorkspaceInput" as const,
          profileVersion: "turn-profile-v1" as const,
          outputContractRef: "tool-invocation-v1",
          executableTools: definitions,
          controlTools,
          contextPolicyRef: "p3-driver-test-context-v1",
          fingerprint: "tpf_p3_driver_test",
        })),
    } satisfies TurnProfileResolverService);
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capabilityLayer, skills),
  );
  const environmentRevisions =
    options.environmentRevisions ??
    Layer.provide(EnvironmentRevisionStoreLive, infra);
  const driver = Layer.provide(
    AgentLoopDriverLive({
      controlRegistry,
      turnProfileResolver,
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
      capabilityLayer,
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
    capabilityLayer,
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
  executionOverride: Execution = execution,
) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    const episode =
      executionOverride.binding._tag === "WorkspaceExecution"
        ? executionOverride.binding.episode
        : undefined;
    return yield* driver.drive({
      execution: executionOverride,
      agentExecutionState:
        episode === undefined ? state : { ...state, episode },
      wakeReason: { _tag: "WorkSelected" },
      context: submissionContext,
      safetyGate: gate,
    });
  });

const conversationExecution = (messageId: string): Execution => ({
  ...execution,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "ConversationResponseEpisode",
      messageId: messageId as never,
      responseJobRevision: 0,
    },
  },
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
const sendMessageTurn = (body: string, callRef = "c1") => [
  {
    _tag: "ToolCallProposed" as const,
    callRef,
    toolName: "send_message",
    argumentsJson: JSON.stringify({
      kind: "Query",
      body,
      recipientWorkspaceId: String(workspaceId),
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];
const invalidSendMessageTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c0",
    toolName: "send_message",
    argumentsJson: JSON.stringify({
      kind: "Query",
      recipientWorkspaceId: String(workspaceId),
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];
const proposeWorkspaceTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "proposal-call",
    toolName: "propose_workspace",
    argumentsJson: JSON.stringify({
      name: "research-child",
      rationale: "independent long-lived research responsibility",
      responsibilityDraft: {
        purpose: "own the research stream",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      resourceBoundaryDraft: {
        addresses: [{ _tag: "FileTree", path: "." }],
      },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

describe("P3-013 agent driver", () => {
  it("runs an ordinary Prepared step against the P17 schema without reading overflow links", async () => {
    const app = makeApp([textTurn]);
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(allowGate);
      }),
      app,
    );

    expect(settlement._tag).toBe("Completed");
  });

  it("uses the terminal attempt classification for an ordinary failure under P19", async () => {
    const app = makeApp([], { providerFailures: ["RequestRejected"] });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* Effect.exit(drive(allowGate));
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "Failed",
        failure: {
          _tag: "ExecutionFailure",
          reason: "ProviderFailure:RequestRejected",
        },
      },
    });
    expect(result.step?.state).toBe("SettlementProposed");
  });

  it("reads classification from the highest terminal attempt, not an earlier attempt", async () => {
    const app = makeApp([]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_mixed_failure",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "RetryableFailure",
            "ContextLimitExceeded",
            "phase1-v2",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            1,
            "t2",
            "t3",
            "TerminalFailure",
            "RequestRejected",
            "phase1-v2",
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "Failed",
        failure: {
          _tag: "ExecutionFailure",
          reason: "ProviderTurnSettled:Failed",
        },
      },
    });
  });

  it.each([
    { label: "missing kind", failureKind: null, taxonomy: "phase1-v2" },
    {
      label: "unsupported legacy taxonomy",
      failureKind: "ContextLimitExceeded",
      taxonomy: "legacy-v1",
    },
  ])("fails closed for a terminal attempt with $label", async (input) => {
    const app = makeApp([]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_unclassified_failure",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "TerminalFailure",
            input.failureKind,
            input.taxonomy,
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain('"stage":"ProviderReplay"');
  });

  it.each([
    {
      label: "retry-budget-exhausted RetryableFailure",
      finishReason: "Failed",
      outcome: "RetryableFailure",
      failureKind: "RateLimited",
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:Failed",
    },
    {
      label: "Cancelled attempt",
      finishReason: "Cancelled",
      outcome: "Cancelled",
      failureKind: "Cancelled",
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:Cancelled",
    },
    {
      label: "TimedOut attempt without provider error kind",
      finishReason: "TurnDeadline",
      outcome: "TimedOut",
      failureKind: null,
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:TurnDeadline",
    },
  ])("preserves settled ProviderTurn semantics for $label", async (input) => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () => Effect.die("a settled ProviderTurn must not be called"),
      }),
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const providerTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            providerTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_terminal_attempt",
            "t",
            "t2",
            input.finishReason,
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            providerTurnId,
            0,
            "t",
            "t2",
            input.outcome,
            input.failureKind,
            input.taxonomy,
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Success");
    expect(JSON.stringify(result)).toContain(input.expectedReason);
  });

  it("fails closed when explicit overflow evidence has no P20 chain table", async () => {
    const app = makeApp([], { providerFailures: ["ContextLimitExceeded"] });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain('"stage":"LoopStepStore"');
    expect(JSON.stringify(result)).toContain(
      '"sourceTag":"PersistenceUnavailable"',
    );
  });

  it("carries a conversation-safe control result into the next turn before answering", async () => {
    const requests: PortableModelRequest[] = [];
    const observationMarker = "ProposalRecorded(fpr_test); awaiting approval";
    let call = 0;
    const proposalHandler: AgentActionHandler = {
      action: "ProposeChildWorkspace",
      handle: () =>
        Effect.succeed({
          _tag: "Observation",
          source: "Runtime",
          observation: { text: observationMarker, truncated: false },
        }),
    };
    const app = makeApp([], {
      controlHandlers: [proposalHandler],
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          requests.push(input.request);
          const events = call === 0 ? proposeWorkspaceTurn : textTurn;
          call += 1;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...events,
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    const messageId = "msg_018f2b3c-4d5e-7abc-8def-0123456789a4";
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no, provider_reasoning_json) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL)",
          [
            messageId,
            projectId,
            workspaceId,
            "user:local",
            "创建子工作区",
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
            "fp-conversation-action",
            "Claimed",
            executionId,
            "t",
          ],
        );
        return yield* drive(
          allowGate,
          context,
          conversationExecution(messageId),
        );
      }),
      app,
    );

    expect(settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "ConversationResponseProduced", messageId },
    });
    expect(requests).toHaveLength(2);
    expect(
      requests[1] === undefined ? [] : portableInputItems(requests[1]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Message",
          role: "tool",
          text: observationMarker,
        }),
      ]),
    );
  });

  it("uses one persisted overflow chain and replacement inference", async () => {
    const operations: string[] = [];
    const providerRuntime = Layer.succeed(ProviderRuntime, {
      runTurn: (input) => {
        const operation =
          input.request.requestVersion === 2
            ? input.request.operationKind
            : "Inference";
        operations.push(operation);
        if (operations.length === 1) {
          return Effect.fail({
            _tag: "ProviderFailure" as const,
            kind: "ContextLimitExceeded" as const,
          });
        }
        if (operation === "CompactionSummary") {
          return Effect.succeed({
            attemptNo: 0,
            retryDecisions: [],
            events: [
              { _tag: "TextDelta" as const, text: "compact state" },
              { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
            ],
          });
        }
        return Effect.succeed({
          attemptNo: 0,
          retryDecisions: [],
          events: [
            {
              _tag: "TurnStarted" as const,
              providerTurnId: input.providerTurnId,
              attemptNo: 0,
              modelRef: input.modelRef,
            },
            ...sendMessageTurn("replacement complete"),
          ],
        });
      },
    });
    const app = makeApp([], { providerRuntime });
    const program = Effect.gen(function* () {
      yield* runMigrations(P20_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const links = yield* sql.unsafe<{
        role: string;
        overflow_ordinal: number;
      }>(
        "SELECT role, overflow_ordinal FROM agent_loop_step_provider_turns ORDER BY role",
      );
      return { settlement, links };
    });
    const result = await run(program, app);
    expect(result.settlement, JSON.stringify(result)).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(operations).toEqual(["Inference", "CompactionSummary", "Inference"]);
    expect(result.links).toHaveLength(3);
    expect(new Set(result.links.map((link) => link.role))).toEqual(
      new Set(["Inference", "OverflowCompaction", "OverflowReplacement"]),
    );
    expect(result.links.every((link) => link.overflow_ordinal === 0)).toBe(
      true,
    );
  });

  it("reconstructs an empty ordinal-0 chain from durable ContextLimit evidence", async () => {
    const app = makeApp([
      [
        { _tag: "TextDelta", text: "recovered compact state" },
        { _tag: "TurnCompleted", finishReason: "Stop" },
      ],
      sendMessageTurn("replacement complete"),
    ]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P20_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_context_overflow",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "TerminalFailure",
            "ContextLimitExceeded",
            "phase1-v2",
          ],
        );
        const settlement = yield* Effect.exit(drive(allowGate));
        const links = yield* sql.unsafe<{
          role: string;
          overflow_ordinal: number;
          provider_turn_id: string;
          predecessor_provider_turn_id: string | null;
          context_epoch: number;
        }>(
          "SELECT role, overflow_ordinal, provider_turn_id, predecessor_provider_turn_id, context_epoch FROM agent_loop_step_provider_turns WHERE execution_id = ? ORDER BY CASE role WHEN 'Inference' THEN 0 WHEN 'OverflowCompaction' THEN 1 ELSE 2 END",
          [executionId],
        );
        const turns = yield* sql.unsafe<{
          provider_turn_id: string;
        }>(
          "SELECT provider_turn_id FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
          [executionId],
        );
        const attempts = yield* sql.unsafe<{
          attempt_no: number;
        }>(
          "SELECT attempt_no FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
          [inferenceProviderTurnId],
        );
        return { settlement, links, turns, attempts };
      }),
      app,
    );

    const inferenceProviderTurnId = `ptn_${executionId}_0`;
    const compactionProviderTurnId = `ptn_${executionId}_0_compact_0`;
    const replacementProviderTurnId = `ptn_${executionId}_0_overflow_0`;
    expect(result.settlement._tag).toBe("Success");
    expect(JSON.stringify(result.settlement)).toContain(
      '"_tag":"CoordinationCompleted"',
    );
    expect(result.links).toEqual([
      {
        role: "Inference",
        overflow_ordinal: 0,
        provider_turn_id: inferenceProviderTurnId,
        predecessor_provider_turn_id: null,
        context_epoch: 0,
      },
      {
        role: "OverflowCompaction",
        overflow_ordinal: 0,
        provider_turn_id: compactionProviderTurnId,
        predecessor_provider_turn_id: inferenceProviderTurnId,
        context_epoch: 0,
      },
      {
        role: "OverflowReplacement",
        overflow_ordinal: 0,
        provider_turn_id: replacementProviderTurnId,
        predecessor_provider_turn_id: compactionProviderTurnId,
        context_epoch: 1,
      },
    ]);
    expect(result.turns.map((turn) => turn.provider_turn_id)).toEqual([
      inferenceProviderTurnId,
      compactionProviderTurnId,
      replacementProviderTurnId,
    ]);
    expect(result.attempts).toEqual([{ attempt_no: 0 }]);
  });

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
      const exactExecution = conversationExecution(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a1",
      );
      const first = yield* Effect.exit(
        drive(allowGate, context, exactExecution),
      );
      const second = yield* drive(allowGate, context, exactExecution);
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
      result: { _tag: "ConversationResponseProduced" },
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
      const exactExecution = conversationExecution(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a3",
      );
      const first = yield* Effect.exit(
        drive(allowGate, context, exactExecution),
      );
      const afterFirst = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind = 'ProviderTurn'",
      );
      const second = yield* drive(allowGate, context, exactExecution);
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

  it("adopts a settled no-action result after migration without another Provider request", async () => {
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
      const exactExecution = conversationExecution(
        "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
      );
      const first = yield* Effect.exit(
        drive(allowGate, legacyContext, exactExecution),
      );
      yield* runMigrations(P17_MIGRATIONS);
      const second = yield* drive(allowGate, context, exactExecution);
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
      result: { _tag: "ConversationResponseProduced" },
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

  it("settles an exact InboxEpisode on its first text-only response", async () => {
    const app = makeApp([textTurn, sendMessageTurn("question")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string; entryKey?: string };
    };
    expect(settlement._tag).toBe("Completed");
    expect(settlement.result).toEqual({
      _tag: "InboxInputHandled",
      entryKey: "p3-driver-fixture",
    });
  });

  it("returns invalid control arguments to the model and accepts a corrected action", async () => {
    const app = makeApp([
      invalidSendMessageTurn,
      sendMessageTurn("corrected question"),
    ]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const driven = yield* driveAndCount(allowGate);
        const sql = yield* SqlClient;
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence",
        );
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY logical_step_no, action_index",
          [executionId],
        );
        return { ...driven, results, actions };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.turns).toBe(2);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c0",
      actionKind: "send_message",
      status: "Failed",
      disposition: "ModelCorrectable:InvalidControlArguments",
    });
    expect(result.actions[0]).toMatchObject({
      state: "Applied",
      disposition_json: expect.stringContaining(
        "ModelCorrectable:InvalidControlArguments",
      ),
    });
  });

  it("returns a semantic action rejection to the model without hiding it as an exception", async () => {
    let attempts = 0;
    const handler: AgentActionHandler = {
      action: "SendMessage",
      handle: () => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail({
              _tag: "AgentActionRejected" as const,
              code: "action/target-unavailable" as const,
              safeMessage: "the selected recipient is not currently available",
              correction: "ChooseAlternative" as const,
            })
          : Effect.succeed({
              _tag: "Settle" as const,
              settlement: {
                _tag: "Completed" as const,
                result: { _tag: "CoordinationCompleted" as const },
              },
            });
      },
    };
    const app = makeApp(
      [
        sendMessageTurn("unavailable target", "c0"),
        sendMessageTurn("alternative target", "c1"),
      ],
      { controlHandlers: [handler] },
    );
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const driven = yield* driveAndCount(allowGate);
        const sql = yield* SqlClient;
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence",
        );
        return { ...driven, results };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.turns).toBe(2);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c0",
      status: "Failed",
      disposition: "ModelUsable:action/target-unavailable",
      outputText: expect.stringContaining("selected recipient"),
    });
  });

  it("closes a rejected control call with a durable ControlResult before interruption", async () => {
    const rejectingHandler: AgentActionHandler = {
      action: "SendMessage",
      handle: () =>
        Effect.fail({
          _tag: "AgentActionOperationalFailure" as const,
          operation: "test.injected-handler-failure",
          cause: "not applicable to this execution",
        }),
    };
    const app = makeApp([sendMessageTurn("cannot route")], {
      controlHandlers: [rejectingHandler],
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
          [executionId],
        );
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        const timeline = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
        }>(
          "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ControlResult') ORDER BY sequence",
        );
        return { settlement, actions, steps, timeline };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { reason: "ControlActionHandlerRejected" },
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "TerminalRejected",
        disposition_json: expect.stringContaining("HandlerRejected"),
      }),
    ]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        state: "SettlementProposed",
        settlement_json: expect.stringContaining(
          "ControlActionHandlerRejected",
        ),
      }),
    ]);
    expect(result.timeline.map((entry) => entry.item_type)).toEqual([
      "ToolCall",
      "ControlResult",
    ]);
    expect(JSON.parse(result.timeline[1]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c1",
      status: "Denied",
      disposition: "HandlerRejected",
    });
  });

  it("turns a changed control registration into a typed stale result", async () => {
    const app = makeApp([sendMessageTurn("stale")], {
      turnProfileResolver: {
        resolve: () =>
          Effect.succeed({
            purpose: "WorkspaceWork",
            profileVersion: "turn-profile-v1",
            outputContractRef: "tool-invocation-v1",
            executableTools: [],
            controlTools: [
              {
                stableId: "core.control.send-message",
                name: "send_message",
                description: "stale registration",
                schemaJson: "{}",
                version: "1",
                hash: "stale-hash",
                requiredCapability: "agent:communicate",
              },
            ],
            contextPolicyRef: "workspace-coordination-context-v1",
            fingerprint: "tpf_stale",
          }),
      },
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ?",
          [executionId],
        );
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult'",
        );
        return { settlement, actions, results };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { reason: "StaleToolRegistration" },
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "TerminalRejected",
        disposition_json: expect.stringContaining("StaleToolRegistration"),
      }),
    ]);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      status: "Denied",
      disposition: "StaleToolRegistration",
    });
  });

  it("pairs every call when the first control action settles and later calls are skipped", async () => {
    const twoCalls = [
      ...sendMessageTurn("first").slice(0, 1),
      {
        _tag: "ToolCallProposed" as const,
        callRef: "c2",
        toolName: "send_message",
        argumentsJson: JSON.stringify({
          kind: "Query",
          body: "second",
          recipientWorkspaceId: String(workspaceId),
        }),
      },
      { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
    ];
    const app = makeApp([twoCalls]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
          [executionId],
        );
        const timeline = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
        }>(
          "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ControlResult') ORDER BY sequence",
        );
        return { settlement, actions, timeline };
      }),
      app,
    );

    expect(result.settlement._tag).toBe("Completed");
    expect(result.actions).toEqual([
      { state: "Applied" },
      { state: "SkippedEarlySettlement" },
    ]);
    const results = result.timeline
      .filter((entry) => entry.item_type === "ControlResult")
      .map((entry) => JSON.parse(entry.payload_json));
    expect(results).toEqual([
      expect.objectContaining({ callRef: "c1", status: "Succeeded" }),
      expect.objectContaining({
        callRef: "c2",
        status: "Interrupted",
        disposition: "SkippedEarlySettlement",
      }),
    ]);
  });

  it("repairs a dangling call from an ended execution before the next Provider turn", async () => {
    const app = makeApp([sendMessageTurn("frontier repaired")]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            sessionId,
            0,
            "ModelOutput",
            "ToolCall",
            2,
            0,
            JSON.stringify({
              _tag: "ToolCall",
              providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
              callRef: "dangling",
              toolRef: "read",
              argumentsRef: "inline:test",
              argumentsJson: "{}",
            }),
            "t",
            "ProviderTurnCall",
            "dangling",
            "hash-dangling",
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
        const repaired = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
          source_kind: string | null;
        }>(
          "SELECT item_type, payload_json, source_kind FROM session_entries WHERE session_id = ? AND item_type = 'ToolResult' ORDER BY sequence",
          [sessionId],
        );
        return { settlement, step: steps[0], repaired };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("CoordinationCompleted"),
    });
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]?.source_kind).toBe("SessionFrontierRepair");
    expect(JSON.parse(result.repaired[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ToolResult",
      callRef: "dangling",
      status: "Interrupted",
    });
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

  it("settles a terminal Provider failure and durably proposes the settlement", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderFailure",
            kind: "QuotaExceeded",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "quota-exhausted",
          }),
      }),
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );
    expect(result.settlement).toEqual({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderFailure:QuotaExceeded",
      },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("ProviderFailure:QuotaExceeded"),
    });
  });

  it("settles ContextUnsatisfiable instead of leaking it as a driver exception", async () => {
    const app = makeApp([], {
      modelCapability: {
        modelRef: "model-tiny",
        family: "tiny",
        contextWindow: 64,
        outputCeiling: 16,
        toolProtocol: "json",
      },
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );
    expect(result.settlement).toEqual({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ContextUnsatisfiable",
      },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("ContextUnsatisfiable"),
    });
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

  it("captures live project and workspace revisions in the ControlBasis", async () => {
    let received: ProviderRunInput | undefined;
    const app = makeApp([], {
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
              ...sendMessageTurn("basis captured"),
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE projects SET project_policy_revision = 3 WHERE project_id = ?",
          [projectId],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET workspace_policy_revision = 5, responsibility_revision = 7, resource_boundary_revision = 9 WHERE workspace_id = ?",
          [workspaceId],
        );
        return yield* drive(allowGate);
      }),
      app,
    );

    const manifest = JSON.parse(received?.manifestJson ?? "{}") as {
      readonly controlBasis?: Record<string, unknown>;
    };
    expect(manifest.controlBasis).toMatchObject({
      projectPolicyRevision: 3,
      workspacePolicyRevision: 5,
      responsibilityRevision: 7,
      resourceBoundaryRevision: 9,
      environmentRevision: "0",
    });
    expect(manifest.controlBasis?.authorizationDigest).not.toBe("digest");
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
      yield* runMigrations(P19_MIGRATIONS);
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
      const timeline = yield* sql.unsafe<{
        item_type: string;
        payload_json: string;
      }>(
        "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ToolResult','ControlResult','LegacyObservation') ORDER BY sequence",
      );
      return {
        ...driven,
        actions,
        timeline,
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
          timeline: ReadonlyArray<{
            item_type: string;
            payload_json: string;
          }>;
        }
      ).actions,
    ).toEqual([
      expect.objectContaining({
        state: "Applied",
        result_ref: expect.stringMatching(/^result_/),
        observation_source_ref: expect.stringMatching(/^observation_/),
      }),
    ]);
    const timeline = (
      result as typeof result & {
        timeline: ReadonlyArray<{
          item_type: string;
          payload_json: string;
        }>;
      }
    ).timeline;
    expect(timeline.map((entry) => entry.item_type)).not.toContain(
      "LegacyObservation",
    );
    const callEntry = timeline.find((entry) => {
      if (entry.item_type !== "ToolCall") return false;
      const payload = JSON.parse(entry.payload_json) as { toolRef?: string };
      return payload.toolRef === "read";
    });
    const call = JSON.parse(callEntry?.payload_json ?? "{}") as {
      callRef?: string;
    };
    const resultEntry = timeline.find(
      (entry) => entry.item_type === "ToolResult",
    );
    const toolResult = JSON.parse(resultEntry?.payload_json ?? "{}") as {
      callRef?: string;
      status?: string;
    };
    expect(toolResult).toMatchObject({
      callRef: call.callRef,
      status: "Succeeded",
    });
  });

  it("returns a durable executable observation to the next model turn", async () => {
    const requests: ProviderRunInput["request"][] = [];
    let call = 0;
    const observationMarker = "OBSERVATION_RETURN_MARKER";
    const app = makeApp([], {
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
        handle: () =>
          Effect.succeed({
            _tag: "Observation",
            source: "Tool",
            observation: { text: observationMarker, truncated: false },
          }),
      },
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          requests.push(input.request);
          const events =
            call === 0 ? readToolTurn : sendMessageTurn("observation received");
          call += 1;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...events,
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(allowGate);
      }),
      app,
    );

    expect(settlement._tag).toBe("Completed");
    expect(requests).toHaveLength(2);
    expect(
      requests[1] === undefined ? [] : portableInputItems(requests[1]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Message",
          role: "tool",
          text: observationMarker,
        }),
      ]),
    );
  });
});
