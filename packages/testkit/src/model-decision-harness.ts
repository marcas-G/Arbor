// biome-ignore-all lint/suspicious/noExplicitAny: test assembly helper —
// A-channels stay concrete while E/R channels are intentionally loose so
// Layer.mergeAll infers the member union instead of widening every member
// (docs/engineering/test-effectiveness.md, B1; same discipline as
// driver-layer.ts).
import {
  type AgentActionHandler,
  AgentLoopRuntimeLive,
  ModelDecisionServiceLive,
  makeControlToolRegistry,
} from "@arbor/agent-runtime";
import {
  type ControlBasis,
  ModelContext,
  makeTurnProfileResolver,
  type PrepareTurnInput,
  TurnProfileResolver,
} from "@arbor/model-context";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  SessionRepositoryLive,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import {
  type CanonicalProviderEvent,
  ModelCapabilityPort,
  type WorkspaceKnowledgePort,
  type WorkspacePlacementPort,
} from "@arbor/ports";
import { FakeProviderLive } from "@arbor/provider-fake";
import { ProviderRuntimeLive } from "@arbor/provider-runtime";
import { Effect, Layer } from "effect";
import { agentDriverTestDependencies } from "./driver-layer.js";
import { FixedSecretStoreLive } from "./secret-store.js";

/**
 * Model-decision harness (test-effectiveness B3): the shared assembly that
 * made `tests/p11-controlbasis.test.ts` boot the full driver stack (~110
 * lines per file) to reach `ModelDecisionService`. A test states only its
 * deltas — the fake-provider turn scripts and the control handlers — and
 * receives the composed app layer plus the recorded `ControlBasis` values
 * the scripted `ModelContext` observed at `prepareTurn`.
 *
 * `ModelContext` is a recording double returning a fixed `Ready` turn: the
 * provider fake supplies the canonical events, so `decide()` exercises the
 * real ToolCall -> decode -> accepted-output path without a live model.
 * The app-root capability layers (WorkspaceKnowledge/Placement) stay
 * explicit parameters — they do not belong in a package dependency of the
 * testkit (same boundary as `agentDriverTestDependencies`).
 */
export interface ModelDecisionHarnessInput {
  /** Fake-provider per-run scripts (run N uses turns[N]). */
  readonly turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  /** Control handlers composing the control tool registry. */
  readonly controlHandlers: ReadonlyArray<AgentActionHandler>;
  readonly workspaceKnowledge: Layer.Layer<WorkspaceKnowledgePort, any, any>;
  readonly workspacePlacement: Layer.Layer<WorkspacePlacementPort, any, any>;
}

const fixedCapability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});

/** Recording double for the ModelContext port: the minimal observable
 * surface for "which ControlBasis did the driver bind at prepareTurn". */
const recordingModelContext = (recorded: Array<ControlBasis>) =>
  Layer.succeed(ModelContext, {
    prepareTurn: (input: PrepareTurnInput) =>
      Effect.sync(() => {
        recorded.push(input.controlBasis);
        return {
          _tag: "Ready" as const,
          turn: {
            request: {
              modelRef: "model-a",
              instructions: [],
              messages: [],
              toolDefinitions: [],
              outputContractRef: "tool-invocation-v1",
              budget: { maxOutputTokens: input.maxOutputTokens },
              cacheHints: [],
            },
            toolRoutes: [{ name: "send_message", route: "Control" as const }],
            manifest: {
              providerTurnId: input.providerTurnId,
              executionId: input.executionId,
              sessionId: input.sessionId,
              contextEpoch: input.contextEpoch,
              modelRef: "model-a",
              instructionFragments: [],
              contextRefs: [],
              skillRefs: [],
              toolRefs: ["Control:send_message@1"],
              toolRoutes: [{ name: "send_message", route: "Control" as const }],
              outputContractRef: "tool-invocation-v1",
              budgetDecision: { maxOutputTokens: input.maxOutputTokens },
              compiledRequestHash: "hash-model-decision-harness",
              controlBasis: input.controlBasis,
            },
          },
        };
      }),
  });

export const makeModelDecisionHarness = (input: ModelDecisionHarnessInput) => {
  const recorded: Array<ControlBasis> = [];
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const provider = FakeProviderLive({ turns: input.turns });
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
  const revisions = Layer.provide(EnvironmentRevisionStoreLive, infra);
  const controlRegistry = makeControlToolRegistry(input.controlHandlers);
  const turnProfiles = Layer.succeed(
    TurnProfileResolver,
    makeTurnProfileResolver({
      toolCatalog: {
        visibleRefs: () => Effect.succeed([]),
        resolveForModel: (ref) =>
          Effect.fail({ _tag: "ToolNotRegistered", ref }),
      },
      controlCatalog: controlRegistry,
    }),
  );
  const driverDependencies = agentDriverTestDependencies({
    infra,
    sessions: Layer.provide(SessionRepositoryLive, infra),
    environmentRevisions: revisions,
    workspaceKnowledge: input.workspaceKnowledge,
    workspacePlacement: input.workspacePlacement,
  });
  const modelDecision = Layer.provide(
    ModelDecisionServiceLive(),
    Layer.mergeAll(
      driverDependencies,
      infra,
      recordingModelContext(recorded),
      providerRuntime,
      fixedCapability,
      turnProfiles,
    ),
  );
  const driver = Layer.provide(
    AgentLoopRuntimeLive({ controlRegistry }),
    Layer.mergeAll(driverDependencies, modelDecision, infra),
  );
  return {
    // `modelDecision` and the read-side stores are merged explicitly so a
    // capability test can `yield*` them directly: Layer.provide only exposes
    // the inner layer's own services, so the nested copies consumed by the
    // driver stay invisible otherwise.
    app: Layer.mergeAll(
      infra,
      driver,
      providerRuntime,
      fixedCapability,
      revisions,
      modelDecision,
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(TransactionPortLive, infra),
    ),
    recorded,
  };
};
