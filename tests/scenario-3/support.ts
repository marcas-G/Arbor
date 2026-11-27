import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { BlobStorePortLive } from "../../adapters/blob-local/src/index.js";
import {
  AcceptanceRepositoryLive,
  AgentLoopStepStoreLive,
  runMigrations as applyMigrations,
  ClockLive,
  ConversationAttemptStoreLive,
  ConversationCheckpointStoreLive,
  ConversationResponseJobStoreLive,
  DecisionRequestStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  ExecutionRepositoryLive,
  FormationFulfillmentStoreLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LocalPlanStoreLive,
  layer,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  RecoveryAttentionFactStoreLive,
  RecoveryEvidenceStoreLive,
  RuntimeClockLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import type { MigrationFile } from "../../adapters/persistence-sqlite/src/migrate.js";
import { FakeProviderLive } from "../../adapters/provider-fake/src/index.js";
import { WorkspaceKnowledgePortLive } from "../../apps/single-workspace/src/workspace-knowledge.js";
import { WorkspacePlacementPortLive } from "../../apps/single-workspace/src/workspace-placement.js";
import {
  type AgentActionHandler,
  AgentLoopDriverLive,
  type AgentLoopDriverOptions,
  type AgentLoopQualificationProbe,
  type ControlActionAuthorizerService,
  ControlBasisResolverLive,
  type ExecutableInvocationHandler,
  ModelDecisionServiceLive,
  makeControlToolRegistry,
} from "../../packages/agent-runtime/src/index.js";
import { InputPromotionServiceLive } from "../../packages/application/src/index.js";
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
} from "../../packages/domain/dist/index.js";
import {
  ModelContextLive,
  TurnProfileResolver,
  type TurnProfileResolverService,
} from "../../packages/model-context/src/index.js";
import {
  AgentLoopStepStore,
  type CanonicalProviderEvent,
  type EnvironmentRevisionStore,
  ExecutionDriverPort,
  type ModelCapability,
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  type ProviderExecutionPolicyOverrides,
  type ProviderFailureKind,
  type ProviderRuntime,
  type RuntimeSafetyGateService,
  SessionRepository,
  SkillRegistry,
} from "../../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../packages/testkit/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";

/**
 * P3 keeps exercising historical P17/P19/P20 schemas, but the current
 * SessionRepository write contract also emits the additive P37 provenance
 * column. Add only that column after the historical migration set so these
 * tests retain the old focus/overflow schema semantics they are intended to
 * cover.
 */
export const runMigrations = (migrations: ReadonlyArray<MigrationFile>) =>
  Effect.gen(function* () {
    yield* applyMigrations(migrations);
    const sql = yield* SqlClient;
    const sessionTable = yield* sql.unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_entries'",
    );
    if (sessionTable.length === 0) {
      return;
    }
    const columns = yield* sql.unsafe<{ name: string }>(
      "PRAGMA table_info(session_entries)",
    );
    if (!columns.some((column) => column.name === "causal_binding_json")) {
      yield* sql.unsafe(
        "ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT",
      );
    }
  });
export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
export const principal = parse(Principal)("worker:a");
export const execution: Execution = {
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

export const state: AgentExecutionState = {
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
export const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});
export const skills = Layer.succeed(SkillRegistry, {
  available: () => Effect.succeed([]),
  load: () => Effect.die("x"),
});
export const makeApp = (
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
    readonly failFirstTerminalRejectedActionTransition?: boolean;
    readonly turnProfileResolver?: TurnProfileResolverService;
    readonly modelCapability?: ModelCapability;
    readonly providerFailures?: ReadonlyArray<ProviderFailureKind>;
    readonly controlAuthorizer?: ControlActionAuthorizerService;
    readonly qualificationProbe?: AgentLoopQualificationProbe;
    readonly recordReconciliationEscalation?: AgentLoopDriverOptions["recordReconciliationEscalation"];
    readonly databaseFilename?: string;
  } = {},
) => {
  const base = layer({ filename: options.databaseFilename ?? ":memory:" });
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
    options.failFirstOutputAcceptedTransition === true ||
    options.failFirstTerminalRejectedActionTransition === true
      ? Layer.provide(
          Layer.effect(
            AgentLoopStepStore,
            Effect.gen(function* () {
              const delegate = yield* AgentLoopStepStore;
              let failOutputAccepted =
                options.failFirstOutputAcceptedTransition === true;
              let failTerminalRejected =
                options.failFirstTerminalRejectedActionTransition === true;
              return AgentLoopStepStore.of({
                ...delegate,
                transition: (input, fence) => {
                  if (
                    failOutputAccepted &&
                    input.next.state === "OutputAccepted"
                  ) {
                    failOutputAccepted = false;
                    return Effect.fail({
                      _tag: "AgentLoopStepInvariantConflict" as const,
                      reason: "injected-after-session-write",
                    });
                  }
                  return delegate.transition(input, fence);
                },
                transitionAction: (input, fence) => {
                  if (
                    failTerminalRejected &&
                    input.next.state === "TerminalRejected"
                  ) {
                    failTerminalRejected = false;
                    return Effect.fail({
                      _tag: "AgentLoopStepInvariantConflict" as const,
                      reason: "injected-before-terminal-rejection-commit",
                    });
                  }
                  return delegate.transitionAction(input, fence);
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
                appendItemIdempotent: (...args) =>
                  rejectOnce(delegate.appendItemIdempotent(...args)),
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
    Layer.merge(capabilityLayer, skills),
  );
  const turnProfiles = Layer.succeed(TurnProfileResolver, turnProfileResolver);
  const environmentRevisions =
    options.environmentRevisions ??
    Layer.provide(EnvironmentRevisionStoreLive, infra);
  const controlBasisResolver = Layer.provide(
    ControlBasisResolverLive,
    Layer.mergeAll(
      infra,
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      environmentRevisions,
    ),
  );
  const driverDependencies = Layer.mergeAll(
    infra,
    modelContext,
    providerRuntime,
    capabilityLayer,
    controlBasisResolver,
    turnProfiles,
    sessions,
    providerTurnStore,
    agentLoopSteps,
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(HumanMessageStoreLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(ConversationResponseJobStoreLive, infra),
    Layer.provide(ConversationAttemptStoreLive, infra),
    Layer.provide(ConversationCheckpointStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(
      InputPromotionServiceLive,
      Layer.mergeAll(
        infra,
        Layer.provide(TransactionPortLive, infra),
        sessions,
        Layer.provide(InboxProjectionStoreLive, infra),
        Layer.provide(ExecutionRepositoryLive, infra),
      ),
    ),
    BlobStorePortLive,
    Layer.provide(
      RecoveryAttentionFactStoreLive,
      Layer.mergeAll(infra, Layer.provide(DomainEventJournalLive, infra)),
    ),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(RecoveryEvidenceStoreLive, infra),
    Layer.provide(LocalPlanStoreLive, infra),
    Layer.provide(DecisionRequestStoreLive, infra),
    Layer.provide(
      WorkspaceKnowledgePortLive,
      Layer.mergeAll(
        infra,
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(WorkRepositoryLive, infra),
        Layer.provide(VerificationRepositoryLive, infra),
        Layer.provide(AcceptanceRepositoryLive, infra),
        Layer.provide(FormationProposalStoreLive, infra),
        Layer.provide(FormationFulfillmentStoreLive, infra),
        Layer.provide(WorkspaceRepositoryLive, infra),
      ),
    ),
    Layer.provide(
      WorkspacePlacementPortLive,
      Layer.mergeAll(
        infra,
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(WorkRepositoryLive, infra),
        Layer.provide(VerificationRepositoryLive, infra),
        Layer.provide(AcceptanceRepositoryLive, infra),
        Layer.provide(FormationProposalStoreLive, infra),
        Layer.provide(FormationFulfillmentStoreLive, infra),
        Layer.provide(WorkspaceRepositoryLive, infra),
      ),
    ),
    environmentRevisions,
  );
  const modelDecision = Layer.provide(
    ModelDecisionServiceLive({
      ...(options.executionPolicyOverrides === undefined
        ? {}
        : { executionPolicyOverrides: options.executionPolicyOverrides }),
      ...(options.qualificationProbe === undefined
        ? {}
        : { qualificationProbe: options.qualificationProbe }),
    }),
    driverDependencies,
  );
  const driver = Layer.provide(
    AgentLoopDriverLive({
      controlRegistry,
      ...(options.executableHandler !== undefined
        ? { executableInvocationHandler: options.executableHandler }
        : {}),
      ...(options.recordReconciliationEscalation === undefined
        ? {}
        : {
            recordReconciliationEscalation:
              options.recordReconciliationEscalation,
          }),
      ...(options.controlAuthorizer === undefined
        ? {}
        : { controlAuthorizer: options.controlAuthorizer }),
      ...(options.qualificationProbe === undefined
        ? {}
        : { qualificationProbe: options.qualificationProbe }),
    }),
    Layer.merge(driverDependencies, modelDecision),
  );
  return Layer.merge(driverDependencies, driver);
};
export const seed = Effect.gen(function* () {
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
      yield* ensureLegacyProjectResourceSourceFixture();
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
// Narrowed to the `ExecutionOrigin` branch so importing files keep the
// same discriminated-union narrowing the original single-file test had.
type ExecutionOriginContext = Extract<
  CommandSubmissionContext,
  { _tag: "ExecutionOrigin" }
>;
export const context: ExecutionOriginContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
  workerId: "worker",
  workerIncarnationId: "",
};
export const allowGate: RuntimeSafetyGateService = {
  admitActivity: () => Effect.succeed("Continue" as const),
};
export const run = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
) =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );
export const drive = (
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
/** B-9: the drive plus the durable ProviderTurn count, so tests can prove that
 * bounded repair really re-prepared (a new ProviderTurn) and that a stale
 * decision re-prepared rather than executed. */
export const driveAndCount = (gate: RuntimeSafetyGateService) =>
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
export const textTurn = [
  { _tag: "TextDelta" as const, text: "thinking" },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];
export const sendMessageTurn = (body: string, callRef = "c1") => [
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
export const readToolTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "read",
    argumentsJson: JSON.stringify({ path: "README.md" }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];
