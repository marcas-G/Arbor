import { TransactionScope } from "@arbor/ports";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { executeAgentLoopActions } from "../src/agent-loop-actions.js";
import { fixtureExecutionProviderTurnId } from "./fixtures/provider-turn.js";

// P3 consumer source test only: the handler stubs the already-decoded P40
// result. It does not claim or exercise P39 binding authentication.
const executionId = "exe_00000000-0000-7000-8000-000000000005";
const sessionId = "ses_p40_p3_atomic";
const workspaceId = "ws_p40_p3_atomic";
const providerTurnId = fixtureExecutionProviderTurnId(executionId);
const logicalActionId = "lac_p40_p3_atomic";
const callRef = "call_p40_p3_atomic";
const invocationId = "tin_p40_p3_atomic";
const reconciliationFactRef = "f".repeat(64);
const resultArtifactRef = "art_p40_p3_result";
const observation = {
  text: "the effect was proven absent",
  truncated: false,
};

interface TestState {
  step: {
    readonly identity: {
      readonly executionId: string;
      readonly logicalStepNo: number;
      readonly repairAttempt: number;
    };
    readonly providerTurnId: string;
    readonly state: "ActionsInProgress";
    readonly nextActionIndex: number;
    readonly revision: number;
    readonly updatedAt: string;
  };
  actions: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
}

const makeHarness = () => {
  let state: TestState = {
    step: {
      identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId,
      state: "ActionsInProgress",
      nextActionIndex: 0,
      revision: 0,
      updatedAt: "2026-10-12T00:00:00.000Z",
    },
    actions: [],
    items: [],
  };
  let activeState = state;
  const cloneState = (value: TestState): TestState => ({
    step: { ...value.step, identity: { ...value.step.identity } },
    actions: value.actions.map((action) => ({ ...action })),
    items: value.items.map((item) => ({ ...item })),
  });

  const loopSteps = {
    listActions: () => Effect.sync(() => activeState.actions),
    createAction: (action: Record<string, unknown>) =>
      Effect.sync(() => {
        activeState.actions.push(action);
        return action;
      }),
    transitionAction: (input: {
      readonly actionIndex: number;
      readonly next: Record<string, unknown>;
    }) =>
      Effect.sync(() => {
        activeState.actions[input.actionIndex] = input.next;
        return input.next;
      }),
    transition: (input: { readonly next: TestState["step"] }) =>
      Effect.sync(() => {
        activeState.step = input.next;
        return input.next;
      }),
  };
  const sessions = {
    supportsTypedTimeline: () => Effect.succeed(true),
    appendItemIdempotent: (_id: string, input: { readonly item: unknown }) =>
      Effect.sync(() => {
        const item = input.item as Record<string, unknown>;
        const callRefValue = item.callRef;
        if (
          !activeState.items.some(
            (existing) =>
              existing.callRef === callRefValue && existing._tag === item._tag,
          )
        ) {
          activeState.items.push(item);
        }
      }),
  };
  const tx = {
    transact: (body: Effect.Effect<unknown, unknown, never>) =>
      Effect.gen(function* () {
        const staged = cloneState(state);
        activeState = staged;
        const exit = yield* Effect.exit(
          Effect.provideService(body, TransactionScope, {
            session: { id: "p40-p3-transaction-test" },
          }),
        );
        activeState = state;
        if (Exit.isFailure(exit)) {
          return yield* Effect.failCause(exit.cause);
        }
        state = staged;
        activeState = state;
        return exit.value;
      }),
  };

  return {
    tx,
    sessions,
    loopSteps,
    state: () => state,
  };
};

const makeInput = (
  harness: ReturnType<typeof makeHarness>,
  options: {
    readonly probe?: (event: { readonly boundary: string }) => Promise<void>;
    readonly handler: {
      readonly handle: () => Effect.Effect<unknown, unknown>;
    };
  },
) =>
  executeAgentLoopActions({
    input: {
      execution: {
        executionId,
        sessionId,
        workspaceId,
      } as never,
      context: {} as never,
    },
    preparedTurn: {
      manifest: { providerTurnId, contextEpoch: 0, controlBasis: {} },
      toolRoutes: [{ name: "write_once", route: "Executable" }],
    } as never,
    decodedOutput: {
      text: "",
      finishReason: "ToolCalls",
      toolInvocations: [
        {
          providerTurnId,
          outputPosition: 0,
          callRef,
          toolName: "write_once",
          argumentsJson: "{}",
        },
      ],
    } as never,
    turn: 0,
    currentLoopStep: harness.state().step as never,
    loopSteps: harness.loopSteps as never,
    loopStepFence: {
      executionId,
      workerId: "worker_p40_p3_atomic",
      workerIncarnationId: "incarnation_p40_p3_atomic",
      fencingGeneration: 0,
    } as never,
    tx: harness.tx as never,
    sessions: harness.sessions as never,
    controlRegistry: {
      classify: () => "NotControl",
      definitions: () => [],
      decode: () => Effect.die("executable route must not decode as control"),
      handle: () => Effect.die("executable route must not use control handler"),
    } as never,
    executableInvocationHandler: options.handler as never,
    currentControlBasis: () => Effect.succeed({} as never),
    admit: () => Effect.succeed("Continue"),
    failure: (cause: unknown) => cause as never,
    now: () => Effect.succeed("2026-10-12T00:00:01.000Z"),
    ...(options.probe === undefined
      ? {}
      : { qualificationProbe: options.probe as never }),
  } as never);

const p40ReplayObservation = () => ({
  _tag: "Observation" as const,
  source: "Tool" as const,
  observation,
  status: "Failed" as const,
  disposition: "ReconciledNoEffect:ReplayLimitReached",
  resultRef: resultArtifactRef,
  artifactRefs: [resultArtifactRef],
  invocationId: invocationId as never,
  reconciliationFactRef,
});

describe("P40 P3 terminal observation transaction source", () => {
  it.each([
    "AH7BeforeActionResultCommit",
    "AH7AfterActionResultCommit",
  ] as const)(
    "replays a P40 result idempotently after %s",
    async (crashBoundary) => {
      const harness = makeHarness();
      let crashOnce = true;
      let handlerCalls = 0;
      const handler = {
        handle: () => {
          handlerCalls += 1;
          return Effect.succeed(p40ReplayObservation());
        },
      };
      const interrupted = await Effect.runPromiseExit(
        makeInput(harness, {
          handler,
          probe: async (event) => {
            if (event.boundary === crashBoundary && crashOnce) {
              crashOnce = false;
              throw new Error("simulated process stop at P3 result boundary");
            }
          },
        }),
      );
      expect(Exit.isFailure(interrupted)).toBe(true);

      const afterInterruption = harness.state();
      if (crashBoundary === "AH7BeforeActionResultCommit") {
        expect(afterInterruption.items).toHaveLength(0);
        expect(afterInterruption.actions[0]).toMatchObject({
          state: "Pending",
        });
        expect(afterInterruption.step.nextActionIndex).toBe(0);
      } else {
        expect(afterInterruption.items).toHaveLength(1);
        expect(afterInterruption.actions[0]).toMatchObject({
          state: "Applied",
        });
        expect(afterInterruption.step.nextActionIndex).toBe(1);
      }

      const resumedExit = await Effect.runPromise(
        Effect.exit(makeInput(harness, { handler })),
      );
      if (Exit.isFailure(resumedExit)) {
        throw new Error("P3 replay unexpectedly failed", {
          cause: resumedExit.cause,
        });
      }
      const resumed = resumedExit.value;
      expect(resumed._tag).toBe("Completed");
      expect(handlerCalls).toBe(
        crashBoundary === "AH7BeforeActionResultCommit" ? 2 : 1,
      );
      expect(harness.state().items).toHaveLength(1);
      expect(harness.state().items[0]).toMatchObject({
        _tag: "ToolResult",
        callRef,
        invocationId,
        reconciliationFactRef,
        disposition: "ReconciledNoEffect:ReplayLimitReached",
        status: "Failed",
        modelOutputRef: resultArtifactRef,
        artifactRefs: [resultArtifactRef],
        outputText: observation.text,
      });
      expect(harness.state().actions).toHaveLength(1);
      expect(harness.state().actions[0]).toMatchObject({
        state: "Applied",
        disposition: {
          _tag: "ReconciledNoEffect:ReplayLimitReached",
          status: "Failed",
        },
      });
      expect(harness.state().step.nextActionIndex).toBe(1);
    },
  );

  it("leaves Action and cursor pending when P40 reports a recovery block", async () => {
    const harness = makeHarness();
    const outcomeExit = await Effect.runPromise(
      Effect.exit(
        makeInput(harness, {
          handler: {
            handle: () =>
              Effect.fail({
                _tag: "AgentActionRecoveryBlocked",
                executionId,
                logicalActionId,
              }),
          },
        }),
      ),
    );
    if (Exit.isFailure(outcomeExit)) {
      throw new Error("P3 recovery block unexpectedly failed", {
        cause: outcomeExit.cause,
      });
    }
    const outcome = outcomeExit.value;
    expect(outcome).toEqual({ _tag: "RecoveryBlocked" });
    expect(harness.state().items).toHaveLength(0);
    expect(harness.state().actions[0]).toMatchObject({ state: "Pending" });
    expect(harness.state().step.nextActionIndex).toBe(0);
  });
});
