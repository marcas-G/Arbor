import {
  type AgentExecutionState,
  ContextEpochNumber,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  providerTurnInferenceId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { ModelContextService } from "@arbor/model-context";
import { ModelContext, TurnProfileResolver } from "@arbor/model-context";
import {
  BlobStorePort,
  ConversationAttemptStore,
  ConversationCheckpointStore,
  ConversationResponseJobStore,
  DecisionRequestStore,
  decodeReasoningAttachment,
  ExecutionRepository,
  HumanMessageStore,
  LocalPlanStore,
  ModelCapabilityPort,
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  ProviderRuntime,
  RecoveryAttentionFactStore,
  SessionRepository,
  sha256Hex,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ControlBasisResolver } from "../src/control-basis-resolver.js";
import {
  ModelDecisionService,
  ModelDecisionServiceLive,
} from "../src/model-decision-service.js";

/**
 * The service-level wiring proof for the P16 Gate C reasoning round trip:
 * `ModelDecisionServiceLive` must hand the resolved `BlobStorePort` to the
 * (unmocked) output journal so a reasoning-bearing Ready outcome persists the
 * provider-reasoning-v1 attachment bound to the manifest's p16 fingerprint.
 * Pre-fix the wiring gap surfaced as ReasoningRoundTripBindingUnavailable on
 * every reasoning model turn (fail-closed daemon death against OpenAI-
 * compatible reasoning deployments).
 */

const decisionMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../src/model-decision.js", () => ({
  runModelDecision: decisionMocks.run,
}));

const unused = <Service>(): Service => ({}) as Service;

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000401",
);
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000401",
);
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000401");
const providerTurnId = providerTurnInferenceId(executionId, 0);
const bindingFingerprint = `p16fp_${"b".repeat(64)}`;
const protocolFamily = "openai-chat-completions-sse";
const controlBasis = {
  projectPolicyRevision: 1,
  workspacePolicyRevision: 1,
  responsibilityRevision: 1,
  resourceBoundaryRevision: 1,
  environmentRevision: "1",
  authorizationDigest: "digest",
};

describe("ModelDecisionService reasoning output persistence", () => {
  it("persists a fingerprint-bound reasoning attachment through the real output journal", async () => {
    const blobs = new Map<string, Uint8Array>();
    const appendedItems: Array<Record<string, unknown>> = [];
    const episode = {
      _tag: "InboxEpisode" as const,
      entryKey: "model-decision-reasoning-persistence",
      inputKind: "TestInput",
    };
    const execution: Execution = {
      executionId,
      projectId: parse(ProjectId)("prj_00000000-0000-7000-8000-000000000401"),
      workspaceId,
      binding: { _tag: "WorkspaceExecution", workspaceId, episode },
      sessionId,
      admittedAt: "2026-11-27T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    };
    const agentExecutionState: AgentExecutionState = {
      executionId,
      episode,
      wakeReason: { _tag: "WorkSelected" },
      currentMode: "execute",
      activeSkillRefs: [],
      turnNo: 0,
      recentDirectiveRefs: [],
      recentActionFingerprints: [],
      updatedAt: "2026-11-27T00:00:00.000Z",
    };
    const preparedTurn = {
      request: {
        modelRef: "model-openai",
        instructions: [],
        messages: [],
        toolDefinitions: [],
        outputContractRef: "agent-directive-v1",
        budget: { maxOutputTokens: 512 },
        cacheHints: [],
      },
      toolRoutes: [],
      manifest: {
        providerTurnId,
        executionId,
        sessionId,
        contextEpoch: parse(ContextEpochNumber)(0),
        modelRef: "model-openai",
        instructionFragments: [],
        contextRefs: [],
        skillRefs: [],
        toolRefs: [],
        toolRoutes: [],
        outputContractRef: "agent-directive-v1",
        protocolFamily,
        resolvedModelBindingFingerprint: bindingFingerprint,
        budgetDecision: { maxOutputTokens: 512 },
        compiledRequestHash: "hash-reasoning-persistence",
        controlBasis,
      },
    };
    decisionMocks.run.mockImplementation(() =>
      Effect.sync(() => ({
        _tag: "Ready" as const,
        turn: preparedTurn,
        output: {
          text: "answer",
          finishReason: "Stop" as const,
          reasoningOpaquePayload: "opaque reasoning from the provider",
          toolInvocations: [],
        },
        loopStep: {
          identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
          providerTurnId,
          state: "ProviderResultAvailable",
          nextActionIndex: 0,
          revision: 1,
          updatedAt: "2026-11-27T00:00:00.000Z",
        },
      })),
    );
    const sessions = {
      supportsTypedTimeline: () => Effect.succeed(true),
      findById: () =>
        Effect.succeed(
          Option.some({
            contextEpoch: parse(ContextEpochNumber)(0),
          } as never),
        ),
      appendItemIdempotent: (
        _sessionId: string,
        write: { readonly item: Record<string, unknown> },
      ) => {
        appendedItems.push(write.item);
        return Effect.succeed({
          sequence: appendedItems.length,
          inserted: true,
        });
      },
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(ModelContext, unused<ModelContextService>()),
      Layer.succeed(ProviderRuntime, unused()),
      Layer.succeed(ModelCapabilityPort, {
        resolve: () =>
          Effect.succeed({
            modelRef: "model-openai",
            family: "openai",
            contextWindow: 128_000,
            outputCeiling: 4096,
            toolProtocol: "json",
            capabilities: ["text", "tools"],
            bindingFingerprint,
          }),
      }),
      Layer.succeed(
        ControlBasisResolver,
        () => () => Effect.succeed(controlBasis),
      ),
      Layer.succeed(SessionRepository, sessions as never),
      Layer.succeed(TransactionPort, {
        transact: <A, E>(effect: Effect.Effect<A, E>) => effect,
      } as never),
      Layer.succeed(ConversationCheckpointStore, unused()),
      Layer.succeed(BlobStorePort, {
        put: (bytes: Uint8Array) =>
          Effect.sync(() => {
            const ref = sha256Hex(new TextDecoder().decode(bytes));
            blobs.set(ref, bytes);
            return ref;
          }),
        get: () => Effect.fail({ _tag: "BlobStoreError" } as never),
        stream: undefined as never,
      }),
      Layer.succeed(TurnProfileResolver, unused()),
      Layer.succeed(WorkRepository, unused()),
      Layer.succeed(DecisionRequestStore, unused()),
      Layer.succeed(WorkspaceRepository, unused()),
      Layer.succeed(LocalPlanStore, unused()),
      Layer.succeed(WorkspaceKnowledgePort, unused()),
      Layer.succeed(WorkspacePlacementPort, unused()),
      Layer.succeed(RecoveryAttentionFactStore, unused()),
      Layer.succeed(HumanMessageStore, unused()),
      Layer.succeed(ConversationResponseJobStore, unused()),
      Layer.succeed(ConversationAttemptStore, unused()),
      Layer.succeed(ExecutionRepository, unused()),
    );
    const layer = Layer.provide(ModelDecisionServiceLive(), dependencies);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ModelDecisionService;
        const bound = yield* service.forExecution({
          execution,
          agentExecutionState,
          context: {
            _tag: "ExecutionOrigin",
            principal: parse(Principal)("worker:test"),
            executionId,
            fencingGeneration: 0 as never,
          },
          loopSteps: {
            transition: (input: { readonly next: unknown }) =>
              Effect.succeed(input.next),
          } as never,
          loopStepFence: {} as never,
          admitProviderTurn: () =>
            Effect.succeed({
              activity: {
                _tag: "ProviderTurn",
                fingerprint: "provider-turn:test",
              },
              decision: "Continue" as const,
            }),
          completeProviderTurn: () => Effect.succeed("Continue" as const),
          now: () => Effect.succeed("2026-11-27T00:00:00.000Z"),
        });
        return yield* bound.decide({ turn: 0, repairAttempt: 0 });
      }).pipe(Effect.provide(layer)),
    );

    expect(outcome._tag).toBe("Ready");
    expect(appendedItems.map((item) => item._tag)).toEqual([
      "AssistantMessage",
      "AttachmentRef",
    ]);
    const attachmentItem = appendedItems[1];
    expect(attachmentItem).toMatchObject({
      _tag: "AttachmentRef",
      mediaType: PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
      trust: "DataOnly",
      providerTurnId,
    });
    expect(blobs.size).toBe(1);
    const bytes = blobs.get(String(attachmentItem?.ref)) as Uint8Array;
    expect(decodeReasoningAttachment(bytes)).toEqual({
      attachmentType: "provider-reasoning-v1",
      modelRef: "model-openai",
      protocolFamily,
      bindingFingerprint,
      opaquePayload: "opaque reasoning from the provider",
      receivedAt: "2026-11-27T00:00:00.000Z",
    });
  });
});
