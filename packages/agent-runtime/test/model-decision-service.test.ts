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
import type { ControlBasis } from "@arbor/model-context";
import { ModelCapabilityPort } from "@arbor/ports";
import { modelDecisionServiceUnitDependencies } from "@arbor/testkit";
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

const capabilityLayer = (onResolve: () => void) =>
  Layer.succeed(ModelCapabilityPort, {
    resolve: () =>
      Effect.sync(() => {
        onResolve();
        return {
          modelRef: "model-a",
          family: "test",
          contextWindow: 8_000,
          outputCeiling: 512,
          toolProtocol: "json",
        };
      }),
  });

const fixtures = (suffix: string) => {
  const executionId = parse(ExecutionId)(
    `exe_00000000-0000-7000-8000-0000000003${suffix}`,
  );
  const workspaceId = parse(WorkspaceId)(
    `ws_00000000-0000-7000-8000-0000000003${suffix}`,
  );
  const episode = {
    _tag: "InboxEpisode" as const,
    entryKey: `model-decision-service-test-${suffix}`,
    inputKind: "TestInput",
  };
  const execution: Execution = {
    executionId,
    projectId: parse(ProjectId)(
      `prj_00000000-0000-7000-8000-0000000003${suffix}`,
    ),
    workspaceId,
    binding: {
      _tag: "WorkspaceExecution" as const,
      workspaceId,
      episode,
    },
    sessionId: parse(SessionId)(
      `ses_00000000-0000-7000-8000-0000000003${suffix}`,
    ),
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
  return { executionId, execution, agentExecutionState };
};

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
    const { executionId, execution, agentExecutionState } = fixtures("01");
    const layer = Layer.provide(
      ModelDecisionServiceLive(),
      modelDecisionServiceUnitDependencies({
        modelCapability: capabilityLayer(() => {
          capabilityResolutions += 1;
        }),
        controlBasisResolver: Layer.succeed(
          ControlBasisResolver,
          () => () =>
            Effect.sync(() => {
              controlBasisReads += 1;
              return controlBasis;
            }),
        ),
      }),
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
    const { executionId, execution, agentExecutionState } = fixtures("02");
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
      modelDecisionServiceUnitDependencies({
        modelCapability: capabilityLayer(() => {
          capabilityResolutions += 1;
        }),
        controlBasisResolver: Layer.succeed(
          ControlBasisResolver,
          () => () => Effect.succeed(preparedTurn.manifest.controlBasis),
        ),
      }),
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
