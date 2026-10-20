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
    manifestId: "mft_control_commit",
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
type State = ReturnType<typeof initialState>;

const settledProviderResult = (input: {
  readonly providerTurnId: string;
  readonly manifestId: string;
  readonly manifestJson: string;
  readonly callRef: string;
  readonly toolName: string;
  readonly contextEpoch: number;
}) => ({
  _tag: "SettledSuccess" as const,
  turn: {
    providerTurnId: input.providerTurnId,
    executionId: "exe_control_commit",
    sessionId: "ses_control_commit",
    contextEpoch: input.contextEpoch,
    modelRef: "model-test",
    outputContractRef: "contract-test",
    manifestId: input.manifestId,
  },
  manifestId: input.manifestId,
  manifestJson: input.manifestJson,
  canonicalEvents: [
    {
      _tag: "TurnStarted" as const,
      providerTurnId: input.providerTurnId,
      attemptNo: 1,
      modelRef: "model-test",
    },
    {
      _tag: "ToolCallProposed" as const,
      callRef: input.callRef,
      toolName: input.toolName,
      argumentsJson: "{}",
    },
    { _tag: "TurnCompleted" as const, finishReason: "ToolUse" as const },
  ],
  attemptNo: 1,
  finishReason: "ToolUse",
  usageJson: "{}",
  evidenceVersion: "provider-success-v1",
});

describe("P9 direct Control effect commit", () => {
  it("rolls an effect back on a stale fenced transition and applies it only once on retry", async () => {
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
    const providerTurns = {
      findManifestByTurn: (providerTurnId: string) =>
        Effect.succeed(
          providerTurnId === "ptn_control_commit"
            ? {
                manifestId: "mft_control_commit",
                manifestJson: JSON.stringify({
                  providerTurnId,
                  executionId: "exe_control_commit",
                  sessionId: "ses_control_commit",
                  contextEpoch: 0,
                  modelRef: "model-test",
                  outputContractRef: "contract-test",
                  logicalStepNo: 0,
                  repairAttempt: 0,
                }),
                portableRequestJson: "{}",
              }
            : null,
        ),
      findSettledResult: (providerTurnId: string) => {
        const manifestJson = JSON.stringify({
          providerTurnId,
          executionId: "exe_control_commit",
          sessionId: "ses_control_commit",
          contextEpoch: 0,
          modelRef: "model-test",
          outputContractRef: "contract-test",
          logicalStepNo: 0,
          repairAttempt: 0,
        });
        return Effect.succeed(
          providerTurnId === "ptn_control_commit"
            ? settledProviderResult({
                providerTurnId,
                manifestId: "mft_control_commit",
                manifestJson,
                callRef: "call_control_commit",
                toolName: "update_plan",
                contextEpoch: 0,
              })
            : { _tag: "NotFound" as const },
        );
      },
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
        providerTurns: providerTurns as never,
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

  it("accepts the exact P20 replacement manifest as the action source and fails closed on mismatches", async () => {
    const sourceTurn = "ptn_control_source";
    const replacementTurn = "ptn_control_source_overflow_0";
    const replacementManifestId = "mft_control_replacement";
    const manifestFor = (
      providerTurnId: string,
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      manifestId:
        providerTurnId === replacementTurn
          ? replacementManifestId
          : "mft_control_source",
      manifestJson: JSON.stringify({
        providerTurnId,
        executionId: "exe_control_commit",
        sessionId: "ses_control_commit",
        contextEpoch: 1,
        modelRef: "model-test",
        outputContractRef: "contract-test",
        logicalStepNo: 0,
        repairAttempt: 0,
        ...overrides,
      }),
      portableRequestJson: "{}",
    });

    const run = async (input: {
      readonly stepManifestId?: string;
      readonly contextProviderTurnId: string;
      readonly contextLogicalStepNo?: number;
      readonly contextCallRef?: string;
      readonly receiptCallRef?: string;
      readonly manifest?: ReturnType<typeof manifestFor> | null;
    }) => {
      const state = {
        ...initialState(),
        step: {
          ...initialState().step,
          manifestId: input.stepManifestId,
        },
        effects: 0,
        sessionItems: [] as Array<unknown>,
      };
      const loopSteps = {
        find: (identity: State["step"]["identity"]) =>
          Effect.succeed(
            identity.executionId === state.step.identity.executionId &&
              identity.logicalStepNo === state.step.identity.logicalStepNo &&
              identity.repairAttempt === state.step.identity.repairAttempt
              ? Option.some(state.step)
              : Option.none(),
          ),
        listActions: () => Effect.succeed([state.action]),
        transitionAction: (next: { readonly next: State["action"] }) =>
          Effect.sync(() => {
            state.action = next.next;
            return next.next;
          }),
        transition: (next: { readonly next: State["step"] }) =>
          Effect.sync(() => {
            state.step = next.next;
            return next.next;
          }),
      };
      const providerTurns = {
        findManifestByTurn: (providerTurnId: string) =>
          Effect.succeed(
            providerTurnId === input.contextProviderTurnId
              ? (input.manifest ?? null)
              : null,
          ),
        findSettledResult: (providerTurnId: string) => {
          const manifest = input.manifest;
          if (
            providerTurnId !== input.contextProviderTurnId ||
            manifest == null
          ) {
            return Effect.succeed({ _tag: "NotFound" as const });
          }
          return Effect.succeed(
            settledProviderResult({
              providerTurnId,
              manifestId: manifest.manifestId,
              manifestJson: manifest.manifestJson,
              callRef:
                input.receiptCallRef ??
                input.contextCallRef ??
                "call_control_commit",
              toolName: "update_plan",
              contextEpoch: 1,
            }),
          );
        },
      };
      const sessions = {
        appendItemIdempotent: (
          _sessionId: string,
          write: { readonly item: unknown },
        ) =>
          Effect.sync(() => {
            state.sessionItems.push(write.item);
            return { sequence: 1, inserted: true };
          }),
      };
      const tx = {
        transact: (body: Effect.Effect<unknown, unknown, never>) =>
          Effect.provideService(body, TransactionScope, {
            session: { id: "control-commit-test" },
          }),
      };
      const handlerInput = {
        action: { _tag: "UpdatePlan" },
        invocation: {
          callRef: input.contextCallRef ?? "call_control_commit",
          toolName: "update_plan",
          argumentsJson: "{}",
        },
        execution: {
          executionId: "exe_control_commit",
          sessionId: "ses_control_commit",
        },
        logicalActionId: "lac_control_commit",
        actionContext: {
          identity: {
            ...state.step.identity,
            logicalStepNo:
              input.contextLogicalStepNo ?? state.step.identity.logicalStepNo,
          },
          actionIndex: 0,
          providerTurnId: input.contextProviderTurnId,
          callRef: input.contextCallRef ?? "call_control_commit",
          contextEpoch: 1,
        },
        loopStepFence: {
          executionId: "exe_control_commit",
          workerId: "worker_control_commit",
          workerIncarnationId: "inc_control_commit",
          fencingGeneration: 1,
        },
      } as never;
      const result = await Effect.runPromise(
        commitDurableControlActionEffect({
          handlerInput,
          expectedToolName: "update_plan",
          tx: tx as never,
          loopSteps: loopSteps as never,
          providerTurns: providerTurns as never,
          sessions: sessions as never,
          clock: { now: () => Effect.succeed("2026-10-17T00:00:01.000Z") },
          effect: () =>
            Effect.sync(() => {
              state.effects += 1;
              return {
                value: "plan-revision-2",
                result: {
                  observation: { text: "updated", truncated: false as const },
                },
              };
            }),
        }),
      ).then(
        (value) =>
          ({ value, state }) as {
            readonly value: unknown;
            readonly error?: never;
            readonly state: typeof state;
          },
        (error: unknown) =>
          ({ error, state }) as {
            readonly error: unknown;
            readonly value?: never;
            readonly state: typeof state;
          },
      );
      return result;
    };

    const replacement = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      manifest: manifestFor(replacementTurn),
    });
    expect(replacement).not.toHaveProperty("error");
    expect(replacement.state.effects).toBe(1);
    expect(replacement.state.action.state).toBe("Applied");
    expect(replacement.state.sessionItems).toHaveLength(1);

    const sourceTurnMasqueradingAsReplacement = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: sourceTurn,
      manifest: manifestFor(sourceTurn),
    });
    expect(sourceTurnMasqueradingAsReplacement.error).toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(sourceTurnMasqueradingAsReplacement.state.effects).toBe(0);

    const wrongManifestIdentity = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      manifest: manifestFor(replacementTurn, { logicalStepNo: 1 }),
    });
    expect(wrongManifestIdentity.error).toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(wrongManifestIdentity.state.effects).toBe(0);

    const wrongManifestProviderTurn = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      manifest: manifestFor(replacementTurn, {
        providerTurnId: sourceTurn,
      }),
    });
    expect(wrongManifestProviderTurn.error).toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(wrongManifestProviderTurn.state.effects).toBe(0);

    const missingManifest = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      manifest: null,
    });
    expect(missingManifest.error).toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(missingManifest.state.effects).toBe(0);

    const mismatchedCallRef = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      receiptCallRef: "call_not_pinned",
      manifest: manifestFor(replacementTurn),
    });
    expect(mismatchedCallRef.error).toMatchObject({
      _tag: "LeaseFencingRejected",
    });
    expect(mismatchedCallRef.state.effects).toBe(0);

    const crossStep = await run({
      stepManifestId: replacementManifestId,
      contextProviderTurnId: replacementTurn,
      contextLogicalStepNo: 1,
      manifest: manifestFor(replacementTurn),
    });
    expect(crossStep.error).toMatchObject({ _tag: "LeaseFencingRejected" });
    expect(crossStep.state.effects).toBe(0);
  });
});
