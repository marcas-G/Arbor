import {
  type AgentExecutionState,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type ControlBasis,
  ModelContext,
  TurnProfileResolver,
} from "@arbor/model-context";
import {
  BlobStorePort,
  ConversationAttemptStore,
  ConversationCheckpointStore,
  ConversationResponseJobStore,
  DecisionRequestStore,
  ExecutionRepository,
  HumanMessageStore,
  LocalPlanStore,
  ModelCapabilityPort,
  ProviderRuntime,
  RecoveryAttentionFactStore,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ControlBasisResolver } from "../src/control-basis-resolver.js";
import {
  ModelDecisionService,
  ModelDecisionServiceLive,
} from "../src/model-decision-service.js";

const decisionMocks = vi.hoisted(() => ({
  run: vi.fn(),
  journal: vi.fn(),
}));

vi.mock("../src/model-decision.js", () => ({
  runModelDecision: decisionMocks.run,
}));

vi.mock("../src/model-output-journal.js", () => ({
  recordAcceptedModelOutput: decisionMocks.journal,
}));

const unused = <Service>(): Service => ({}) as Service;

describe("ModelDecisionService", () => {
  it("binds one execution, resolves its capability once, and re-reads its ControlBasis", async () => {
    let capabilityResolutions = 0;
    let controlBasisReads = 0;
    const controlBasis: ControlBasis = {
      projectPolicyRevision: 1,
      workspacePolicyRevision: 2,
      responsibilityRevision: 3,
      resourceBoundaryRevision: 4,
      environmentRevision: "5",
      authorizationDigest: "digest",
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(ModelContext, unused()),
      Layer.succeed(ProviderRuntime, unused()),
      Layer.succeed(ModelCapabilityPort, {
        resolve: () =>
          Effect.sync(() => {
            capabilityResolutions += 1;
            return {
              modelRef: "model-a",
              family: "test",
              contextWindow: 8_000,
              outputCeiling: 512,
              toolProtocol: "json",
            };
          }),
      }),
      Layer.succeed(
        ControlBasisResolver,
        () => () =>
          Effect.sync(() => {
            controlBasisReads += 1;
            return controlBasis;
          }),
      ),
      Layer.succeed(SessionRepository, unused()),
      Layer.succeed(TransactionPort, unused()),
      Layer.succeed(ConversationCheckpointStore, unused()),
      Layer.succeed(BlobStorePort, unused()),
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
    const executionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-000000000301",
    );
    const workspaceId = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-000000000301",
    );
    const episode = {
      _tag: "InboxEpisode" as const,
      entryKey: "model-decision-service-test",
      inputKind: "TestInput",
    };
    const execution: Execution = {
      executionId,
      projectId: parse(ProjectId)("prj_00000000-0000-7000-8000-000000000301"),
      workspaceId,
      binding: {
        _tag: "WorkspaceExecution" as const,
        workspaceId,
        episode,
      },
      sessionId: parse(SessionId)("ses_00000000-0000-7000-8000-000000000301"),
      admittedAt: "2026-11-26T00:00:00.000Z",
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
      updatedAt: "2026-11-26T00:00:00.000Z",
    };

    const result = await Effect.runPromise(
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
          admitProviderTurn: () =>
            Effect.succeed({
              activity: {
                _tag: "ProviderTurn",
                fingerprint: "provider-turn:test",
              },
              decision: "Continue" as const,
            }),
          completeProviderTurn: () => Effect.succeed("Continue" as const),
          now: () => Effect.succeed("2026-11-26T00:00:00.000Z"),
        });
        return [
          yield* bound.currentControlBasis(),
          yield* bound.currentControlBasis(),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );

    expect(capabilityResolutions).toBe(1);
    expect(controlBasisReads).toBe(2);
    expect(result).toEqual([controlBasis, controlBasis]);
  });

  it("passes dynamic recovery inputs and journals Ready output before returning", async () => {
    const sequence: Array<string> = [];
    let capabilityResolutions = 0;
    const cancellationSignal = new AbortController().signal;
    const executionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-000000000302",
    );
    const workspaceId = parse(WorkspaceId)(
      "ws_00000000-0000-7000-8000-000000000302",
    );
    const episode = {
      _tag: "InboxEpisode" as const,
      entryKey: "model-decision-service-ready-test",
      inputKind: "TestInput",
    };
    const execution: Execution = {
      executionId,
      projectId: parse(ProjectId)("prj_00000000-0000-7000-8000-000000000302"),
      workspaceId,
      binding: { _tag: "WorkspaceExecution", workspaceId, episode },
      sessionId: parse(SessionId)("ses_00000000-0000-7000-8000-000000000302"),
      admittedAt: "2026-11-26T00:00:00.000Z",
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
      updatedAt: "2026-11-26T00:00:00.000Z",
    };
    const preparedTurn = {
      request: {
        modelRef: "model-a",
        instructions: [],
        messages: [],
        toolDefinitions: [],
        outputContractRef: "tool-invocation-v1",
        budget: { maxOutputTokens: 512 },
        cacheHints: [],
      },
      toolRoutes: [],
      manifest: {
        providerTurnId: "pt_test" as never,
        executionId,
        sessionId: execution.sessionId,
        contextEpoch: 0 as never,
        modelRef: "model-a",
        instructionFragments: [],
        contextRefs: [],
        skillRefs: [],
        toolRefs: [],
        toolRoutes: [],
        outputContractRef: "tool-invocation-v1",
        budgetDecision: { maxOutputTokens: 512 },
        compiledRequestHash: "hash",
        controlBasis: {
          projectPolicyRevision: 1,
          workspacePolicyRevision: 1,
          responsibilityRevision: 1,
          resourceBoundaryRevision: 1,
          environmentRevision: "1",
          authorizationDigest: "digest",
        },
      },
    };
    const output = {
      text: "ready",
      finishReason: "Stop" as const,
      toolInvocations: [],
    };
    decisionMocks.run.mockImplementation((dependencies) =>
      Effect.sync(() => {
        sequence.push("decision");
        expect(dependencies.options.cancellationSignal).toBe(
          cancellationSignal,
        );
        expect(dependencies.options.resumeExactActionStepIdentity).toEqual({
          executionId,
          logicalStepNo: 7,
          repairAttempt: 2,
        });
        return {
          _tag: "Ready" as const,
          turn: preparedTurn,
          output,
        };
      }),
    );
    decisionMocks.journal.mockImplementation((input) =>
      Effect.sync(() => {
        sequence.push("journal");
        expect(input.preparedTurn).toBe(preparedTurn);
        expect(input.decodedOutput).toBe(output);
        return undefined;
      }),
    );
    const layer = Layer.provide(
      ModelDecisionServiceLive(),
      Layer.mergeAll(
        Layer.succeed(ModelContext, unused()),
        Layer.succeed(ProviderRuntime, unused()),
        Layer.succeed(ModelCapabilityPort, {
          resolve: () =>
            Effect.sync(() => {
              capabilityResolutions += 1;
              return {
                modelRef: "model-a",
                family: "test",
                contextWindow: 8_000,
                outputCeiling: 512,
                toolProtocol: "json",
              };
            }),
        }),
        Layer.succeed(
          ControlBasisResolver,
          () => () => Effect.succeed(preparedTurn.manifest.controlBasis),
        ),
        Layer.succeed(SessionRepository, unused()),
        Layer.succeed(TransactionPort, unused()),
        Layer.succeed(ConversationCheckpointStore, unused()),
        Layer.succeed(BlobStorePort, unused()),
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
      ),
    );

    const result = await Effect.runPromise(
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
          cancellationSignal,
          admitProviderTurn: () =>
            Effect.succeed({
              activity: {
                _tag: "ProviderTurn",
                fingerprint: "provider-turn:test",
              },
              decision: "Continue" as const,
            }),
          completeProviderTurn: () => Effect.succeed("Continue" as const),
          now: () => Effect.succeed("2026-11-26T00:00:00.000Z"),
        });
        const cursor = {
          turn: 7,
          repairAttempt: 2,
          resumeExactActionStepIdentity: {
            executionId,
            logicalStepNo: 7,
            repairAttempt: 2,
          },
        } as const;
        return [yield* bound.decide(cursor), yield* bound.decide(cursor)];
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual([
      expect.objectContaining({ _tag: "Ready", output }),
      expect.objectContaining({ _tag: "Ready", output }),
    ]);
    expect(capabilityResolutions).toBe(1);
    expect(sequence).toEqual(["decision", "journal", "decision", "journal"]);
  });
});
