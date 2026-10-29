import { TransactionScope } from "@arbor/ports";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { executeAgentLoopActions } from "../src/agent-loop-actions.js";
import { fixtureExecutionProviderTurnId } from "./fixtures/provider-turn.js";

const executionId = "exe_00000000-0000-7000-8000-000000000006";
const sessionId = "ses_p9_control_settlement";
const workspaceId = "ws_p9_control_settlement";
const providerTurnId = fixtureExecutionProviderTurnId(executionId);
const callRef = "call_p9_control_settlement";

interface State {
  step: {
    readonly identity: {
      readonly executionId: string;
      readonly logicalStepNo: number;
      readonly repairAttempt: number;
    };
    readonly providerTurnId: string;
    readonly state: string;
    readonly nextActionIndex: number;
    readonly settlement?: unknown;
    readonly revision: number;
    readonly updatedAt: string;
  };
  actions: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  waitEffects: number;
}

const makeHarness = () => {
  let state: State = {
    step: {
      identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId,
      state: "ActionsInProgress",
      nextActionIndex: 0,
      revision: 0,
      updatedAt: "2026-10-17T00:00:00.000Z",
    },
    actions: [],
    items: [],
    waitEffects: 0,
  };
  let activeState = state;
  const clone = (value: State): State => ({
    step: { ...value.step, identity: { ...value.step.identity } },
    actions: value.actions.map((action) => ({ ...action })),
    items: value.items.map((item) => ({ ...item })),
    waitEffects: value.waitEffects,
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
    transition: (input: { readonly next: State["step"] }) =>
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
        if (
          !activeState.items.some(
            (existing) => existing.callRef === item.callRef,
          )
        ) {
          activeState.items.push(item);
        }
        return { sequence: activeState.items.length, inserted: true };
      }),
  };
  const tx = {
    transact: (body: Effect.Effect<unknown, unknown, never>) =>
      Effect.gen(function* () {
        const staged = clone(state);
        activeState = staged;
        const exit = yield* Effect.exit(
          Effect.provideService(body, TransactionScope, {
            session: { id: "p9-control-settlement-effect" },
          }),
        );
        activeState = state;
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
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
    applyWaitEffect: () => {
      activeState.waitEffects += 1;
    },
  };
};

describe("P9 direct Control settlement effect commit", () => {
  it("keeps the effect absent before commit and does not replay it after terminal commit", async () => {
    const harness = makeHarness();
    let handlerCalls = 0;
    const handler = {
      handle: () => {
        handlerCalls += 1;
        return Effect.succeed({
          _tag: "Settle" as const,
          settlement: {
            _tag: "Completed" as const,
            result: {
              _tag: "CompletionClaimed" as const,
              workRevision: 3 as never,
              claimRef: "claim-control-settlement",
            },
          },
          durableSettlementEffect: Effect.sync(() => {
            harness.applyWaitEffect();
          }),
        });
      },
    };
    const run = (probe?: (boundary: string) => Promise<void>) =>
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
          toolRoutes: [{ name: "claim_completion", route: "Control" }],
        } as never,
        decodedOutput: {
          text: "",
          finishReason: "ToolCalls",
          toolInvocations: [
            {
              providerTurnId,
              outputPosition: 0,
              callRef,
              toolName: "claim_completion",
              argumentsJson: JSON.stringify({ claim: "done" }),
            },
          ],
        } as never,
        turn: 0,
        currentLoopStep: harness.state().step as never,
        loopSteps: harness.loopSteps as never,
        loopStepFence: {
          executionId,
          workerId: "worker_p9_control_settlement",
          workerIncarnationId: "incarnation_p9_control_settlement",
          fencingGeneration: 1,
        } as never,
        tx: harness.tx as never,
        sessions: harness.sessions as never,
        controlRegistry: {
          classify: () => "Control",
          definitions: () => [],
          decode: () =>
            Effect.succeed({
              action: { _tag: "ClaimCompletion", claim: "done" },
            }),
          handle: handler.handle,
        } as never,
        executableInvocationHandler: {} as never,
        currentControlBasis: () => Effect.succeed({} as never),
        admit: () => Effect.succeed("Continue"),
        failure: (cause: unknown) => cause as never,
        now: () => Effect.succeed("2026-10-17T00:00:01.000Z"),
        ...(probe === undefined
          ? {}
          : {
              qualificationProbe: (event: { readonly boundary: string }) =>
                probe(event.boundary),
            }),
      } as never);

    const beforeCommit = await Effect.runPromiseExit(
      run(async (boundary) => {
        if (boundary === "AH9BeforeTerminalActionCommit") {
          throw new Error("crash before terminal transaction");
        }
      }),
    );
    expect(Exit.isFailure(beforeCommit)).toBe(true);
    expect(harness.state().waitEffects).toBe(0);
    expect(harness.state().actions[0]).toMatchObject({ state: "Pending" });
    expect(harness.state().step.nextActionIndex).toBe(0);

    const afterCommit = await Effect.runPromiseExit(
      run(async (boundary) => {
        if (boundary === "AH9AfterTerminalActionCommit") {
          throw new Error("crash after terminal transaction");
        }
      }),
    );
    expect(Exit.isFailure(afterCommit)).toBe(true);
    expect(harness.state().waitEffects).toBe(1);
    expect(harness.state().actions[0]).toMatchObject({
      state: "Applied",
      disposition: {
        _tag: "ExecutionSettlement:Completed",
        status: "Succeeded",
      },
    });
    expect(harness.state().step).toMatchObject({
      state: "SettlementProposed",
      nextActionIndex: 1,
    });
    expect(harness.state().items).toHaveLength(1);

    expect(handlerCalls).toBe(2);
    expect(harness.state().waitEffects).toBe(1);
    expect(harness.state().items).toHaveLength(1);
  });
});
