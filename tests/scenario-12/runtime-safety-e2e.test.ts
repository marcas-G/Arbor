import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeSafetyPolicy } from "../../packages/execution-runtime/src/index.js";
import type { CanonicalProviderEvent } from "../../packages/ports/src/index.js";
import {
  type AttentionReadDeps,
  loadAttentionFacts,
} from "../../packages/projection-runtime/src/index.js";
import { createCurrentSchemaTestDatabaseFactory } from "../support/schema44-database.js";
import {
  projectId,
  runScenario,
  scenarioExecutionId,
  toolTurns,
  waitTurns,
  workId,
  workspaceId,
} from "./runtime-safety-scenarios.js";
import { itWithCurrentAppTimeout, policy } from "./runtime-safety-support.js";
import { setCurrentSchema44Factory } from "./schema44-factory.js";

let schema44Factory: Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;
beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: "p12-runtime-safety-template-",
  });
  setCurrentSchema44Factory(schema44Factory);
}, 120_000);
afterAll(() => schema44Factory.cleanup());

describe("end-to-end violation -> Interrupted(RuntimeSafetyStop), Work Open", () => {
  const cases: ReadonlyArray<{
    readonly dim: string;
    readonly safetyPolicy: RuntimeSafetyPolicy;
    readonly turns: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  }> = [
    { dim: "D1", safetyPolicy: policy({ maxRetries: 0 }), turns: waitTurns },
    {
      dim: "D2",
      safetyPolicy: policy({ maxRepeatedFingerprints: 0 }),
      turns: waitTurns,
    },
    {
      dim: "D3",
      safetyPolicy: policy({ maxRecursionDepth: 0 }),
      turns: toolTurns,
    },
    {
      dim: "D4",
      safetyPolicy: policy({ maxNoProgressTurns: 0 }),
      turns: waitTurns,
    },
    {
      dim: "D5",
      safetyPolicy: policy({ concurrencyCeiling: 0 }),
      turns: waitTurns,
    },
    { dim: "D6", safetyPolicy: policy({ rateLimit: 0 }), turns: waitTurns },
  ];

  for (const testCase of cases) {
    itWithCurrentAppTimeout(
      `${testCase.dim}: a violation interrupts with RuntimeSafetyStop and Work remains Open`,
      async () => {
        const result = await runScenario(testCase.safetyPolicy, testCase.turns);
        expect(result.settlementTag).toBe("Interrupted");
        expect(result.settlementReason).toBe("RuntimeSafetyStop");
        expect(result.settlementKind).toBe("Interrupted");
        expect(result.workLifecycle).toBe("Open");
        expect(result.settledEventPayload).toContain("RuntimeSafetyStop");
      },
    );
  }

  itWithCurrentAppTimeout(
    "persists the exact Work Episode before RuntimeSafetyStop so readmission holds the same revision",
    async () => {
      const result = await runScenario(policy({ rateLimit: 0 }), waitTurns);
      expect(result.agentExecutionEpisodeJson).not.toBeNull();
      expect(JSON.parse(result.agentExecutionEpisodeJson ?? "null")).toEqual({
        _tag: "WorkEpisode",
        workId,
        targetWorkRevision: 0,
      });
      expect(result.readmissionHold).toEqual({
        sourceKind: "RuntimeSafetyStopSettlement",
        executionId: scenarioExecutionId,
      });
    },
  );

  itWithCurrentAppTimeout(
    "fails closed without overwriting an existing state bound to another Work revision",
    async () => {
      const initialEpisode = JSON.stringify({
        _tag: "WorkEpisode",
        workId,
        targetWorkRevision: 1,
      });
      const result = await runScenario(
        policy({ rateLimit: 0 }),
        waitTurns,
        undefined,
        initialEpisode,
      );
      expect(result.runtimeFailure).toMatchObject({
        _tag: "PersistenceCorruption",
        repository: "ExecutionRepository",
        operation: "agent-state-episode-binding",
      });
      expect(JSON.parse(result.agentExecutionEpisodeJson ?? "null")).toEqual({
        _tag: "WorkEpisode",
        workId,
        targetWorkRevision: 1,
      });
    },
  );

  itWithCurrentAppTimeout(
    "fails closed without overwriting a malformed Episode state",
    async () => {
      const malformedEpisode = JSON.stringify({
        _tag: "WorkEpisode",
        workId,
        targetWorkRevision: "0",
      });
      const result = await runScenario(
        policy({ rateLimit: 0 }),
        waitTurns,
        undefined,
        malformedEpisode,
      );
      expect(result.runtimeFailure).toMatchObject({
        _tag: "PersistenceCorruption",
        repository: "ExecutionRepository",
        operation: "agent-state-decode",
      });
      expect(result.agentExecutionEpisodeJson).toBe(malformedEpisode);
    },
  );

  itWithCurrentAppTimeout(
    "does not create AgentExecutionState when the current lease is held by another worker",
    async () => {
      const result = await runScenario(
        policy(),
        waitTurns,
        undefined,
        undefined,
        true,
      );
      expect(result.runtimeFailure).toMatchObject({
        _tag: "LeaseFencingRejected",
        executionId: scenarioExecutionId,
        generation: 9,
      });
      expect(result.agentExecutionEpisodeJson).toBeNull();
    },
  );

  it("the RuntimeSafetyStop settlement is derived as an Attention fact (Attention emitted)", async () => {
    const deps: AttentionReadDeps = {
      listWorkspacesByProject: () => Effect.succeed([]),
      listWorksByWorkspace: () => Effect.succeed([]),
      listExecutionSettlementFacts: () =>
        Effect.succeed([
          {
            executionId: scenarioExecutionId,
            workspaceId,
            settlement: {
              _tag: "Interrupted",
              result: {
                _tag: "ControlledInterruption",
                reason: "RuntimeSafetyStop",
              },
            },
            settledAt: "t",
          },
        ]),
      listAttentionSourceExecutionBindings: (targetProjectId, executionIds) =>
        Effect.succeed(
          executionIds.map((executionId) => ({
            executionId,
            projectId: targetProjectId,
            workspaceId,
            episodeJson: JSON.stringify({
              _tag: "WorkEpisode",
              workId: String(workId),
              targetWorkRevision: 0,
            }),
            workId,
            workProjectId: targetProjectId,
            workWorkspaceId: workspaceId,
            workRevision: 0,
          })),
        ),
      listOpenVerifications: () => Effect.succeed([]),
      listUnsatisfiedDependencies: () => Effect.succeed([]),
      findDependency: () => Effect.succeed(Option.none()),
      readEvents: () => Effect.succeed([]),
    };
    const facts = await Effect.runPromise(loadAttentionFacts(projectId, deps));
    expect(facts.safetyStopSettlements).toHaveLength(1);
    expect(facts.safetyStopSettlements[0]?.executionId).toBe(
      scenarioExecutionId,
    );
  });
});
// --- D1 wired to the real ProviderAttempt lifecycle (B-4) ---------------------

const secondWaitTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "wait for a wake",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

describe("D1 real ProviderAttempt lifecycle (B-4)", () => {
  itWithCurrentAppTimeout(
    "a real transient retry at the ProviderAttempt boundary trips {maxRetries:1} -> Interrupted(RuntimeSafetyStop), Work Open",
    async () => {
      // The provider's first transport attempt fails retryably and the second
      // succeeds under the SAME ProviderTurn (DID §6A.9 — no new ProviderTurn).
      // ProviderRuntimeLive(maxAttempts=3) performs the retry; its attempt
      // ordinal (1) reaches the gate through the observation channel.
      const result = await runScenario(
        policy({ maxRetries: 1 }),
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        [waitTurns[0]!, waitTurns[0]!],
        ["ProviderUnavailable"],
      );
      expect(result.settlementTag).toBe("Interrupted");
      expect(result.settlementReason).toBe("RuntimeSafetyStop");
      expect(result.settlementKind).toBe("Interrupted");
      expect(result.workLifecycle).toBe("Open");
      expect(result.settledEventPayload).toContain("RuntimeSafetyStop");
    },
  );

  itWithCurrentAppTimeout(
    "the same real retry continues to Wait when maxRetries admits it (threshold-driven)",
    async () => {
      const result = await runScenario(
        policy({ maxRetries: 3 }),
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        [waitTurns[0]!, waitTurns[0]!],
        ["ProviderUnavailable"],
      );
      expect(result.settlementTag).toBe("Completed");
      expect(result.settlementReason).toBeNull();
    },
  );

  itWithCurrentAppTimeout(
    "a retried operation is followed by a clean operation boundary (retryCount 0) that resets the D1 counter and completes",
    async () => {
      // Turn 0 needs one real retry (attempt ordinal 1) and yields a
      // Communicate observation so the drive continues; turn 1's first attempt
      // reports retryCount 0, resetting the per-operation counter, and claims
      // completion.
      const result = await runScenario(
        policy({ maxRetries: 3 }),
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        [secondWaitTurn, secondWaitTurn, waitTurns[0]!],
        ["ProviderUnavailable"],
      );
      expect(result.settlementTag).toBe("Completed");
      expect(result.settlementReason).toBeNull();
    },
  );
});
