import { TransactionScope } from "@arbor/ports";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { commitDurableControlActionEffect } from "../src/durable-control-action-effect.js";

const initialState = () => ({
  step: {
    identity: {
      executionId: "exe_control_commit",
      logicalStepNo: 0,
      repairAttempt: 0,
    },
    providerTurnId: "ptn_control_commit",
    state: "ActionsInProgress" as const,
    nextActionIndex: 0,
    revision: 1,
    updatedAt: "2026-10-17T00:00:00.000Z",
  },
  action: {
    identity: {
      executionId: "exe_control_commit",
      logicalStepNo: 0,
      repairAttempt: 0,
    },
    actionIndex: 0,
    logicalActionId: "lac_control_commit",
    callRef: "call_control_commit",
    routeKind: "Control" as const,
    actionKind: "update_plan",
    inputHash: "input-hash",
    state: "Pending" as const,
    revision: 0,
    updatedAt: "2026-10-17T00:00:00.000Z",
  },
  effects: 0,
  sessionItems: [] as Array<unknown>,
});

describe("P9 direct Control effect commit", () => {
  it("rolls an effect back on a stale fenced transition and applies it only once on retry", async () => {
    type State = ReturnType<typeof initialState>;
    let durable = initialState();
    let transactionState: State | undefined;
    let rejectActionTransition = true;
    const getState = () => {
      if (transactionState === undefined)
        throw new Error("outside transaction");
      return transactionState;
    };
    const loopSteps = {
      find: () => Effect.succeed(Option.some(getState().step)),
      listActions: () => Effect.succeed([getState().action]),
      transitionAction: (input: { readonly next: State["action"] }) =>
        rejectActionTransition
          ? Effect.fail({ _tag: "LeaseFencingRejected" as const })
          : Effect.sync(() => {
              getState().action = input.next;
              return input.next;
            }),
      transition: (input: { readonly next: State["step"] }) =>
        Effect.sync(() => {
          getState().step = input.next;
          return input.next;
        }),
    };
    const sessions = {
      appendItemIdempotent: (
        _sessionId: string,
        write: { readonly item: unknown },
      ) =>
        Effect.sync(() => {
          getState().sessionItems.push(write.item);
          return { sequence: 1, inserted: true };
        }),
    };
    const tx = {
      transact: (body: Effect.Effect<unknown, unknown, never>) =>
        Effect.gen(function* () {
          transactionState = structuredClone(durable);
          const result = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "control-commit-test" },
            }),
          );
          if (Exit.isFailure(result)) {
            transactionState = undefined;
            return yield* Effect.failCause(result.cause);
          }
          durable = transactionState;
          transactionState = undefined;
          return result.value;
        }),
    };
    const handlerInput = {
      action: { _tag: "UpdatePlan" },
      invocation: {
        callRef: "call_control_commit",
        toolName: "update_plan",
        argumentsJson: "{}",
      },
      execution: {
        executionId: "exe_control_commit",
        sessionId: "ses_control_commit",
      },
      logicalActionId: "lac_control_commit",
      actionContext: {
        identity: durable.step.identity,
        actionIndex: 0,
        providerTurnId: "ptn_control_commit",
        callRef: "call_control_commit",
        contextEpoch: 0,
      },
      loopStepFence: {
        executionId: "exe_control_commit",
        workerId: "worker_control_commit",
        workerIncarnationId: "inc_control_commit",
        fencingGeneration: 1,
      },
    } as never;
    const commit = () =>
      commitDurableControlActionEffect({
        handlerInput,
        expectedToolName: "update_plan",
        tx: tx as never,
        loopSteps: loopSteps as never,
        sessions: sessions as never,
        clock: { now: () => Effect.succeed("2026-10-17T00:00:01.000Z") },
        effect: () =>
          Effect.sync(() => {
            getState().effects += 1;
            return {
              value: "plan-revision-2",
              result: {
                observation: { text: "updated", truncated: false as const },
              },
            };
          }),
      });

    await expect(Effect.runPromise(commit())).rejects.toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(durable.effects).toBe(0);
    expect(durable.action.state).toBe("Pending");
    expect(durable.sessionItems).toHaveLength(0);

    rejectActionTransition = false;
    const committed = await Effect.runPromise(commit());
    expect(committed.value).toBe("plan-revision-2");
    expect(committed.outcome._tag).toBe("Observation");
    expect(durable.effects).toBe(1);
    expect(durable.action.state).toBe("Applied");
    expect(durable.step.nextActionIndex).toBe(1);
    expect(durable.sessionItems).toHaveLength(1);

    await expect(Effect.runPromise(commit())).rejects.toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(durable.effects).toBe(1);
  });
});
