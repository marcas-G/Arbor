import {
  canonicalizeRecoveryBindingV1,
  recoveryBindingV1Digest,
  type ToolReconciliationProfile,
  ToolRuntimePort,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  executionId,
  intent,
  invocationId,
  p39NotOccurredRetryCase,
} from "./support.js";
import { app } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
  it("reconciles against the persisted P39 scope before denying a changed current resource boundary", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      retryAttemptNumbers: [0],
      workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
      workspaceRevisionSequence: [1, 1],
      reconciliationRetry: {
        profile: retry.profile,
        verifiedBinding: retry.verifiedBinding,
        attempt: retry.attempt,
        authority: retry.authority,
        result: retry.result,
        factId: retry.factId,
        settlementEvidence: retry.settlementEvidence,
      },
    };
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              ...intent(retry.argumentsJson),
              toolName: "shell",
              toolVersion: "2",
              invocationId,
              approvalId: null,
            } as never,
            retry.context,
          );
        }),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () =>
              Effect.die(
                new Error("a stale P39 resource boundary must not execute"),
              ),
          },
          {},
          trace,
          undefined,
          false,
          retry.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(result).toEqual(retry.settlementEvidence.observation);
    expect(trace.reconciliationCalls).toBe(1);
    expect(trace.reconciliationRequests).toEqual([
      expect.objectContaining({
        invocationId,
        attemptNo: 0,
        visibilityScopeSha256:
          retry.verifiedBinding.value.targetResourceIdentityDigest,
      }),
    ]);
    expect(trace.reconciliationFactWrites).toBe(1);
    expect(trace.retryAttemptNumbers).toEqual([0]);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
    expect(trace.noEffectDenials).toEqual([]);
    expect(trace.p40Candidates).toHaveLength(1);
    expect(trace.p40Candidates?.[0]).toMatchObject({
      settlement: {
        _tag: "ReconciledNoEffect",
        reasonCode: "ResourceSnapshotChanged",
      },
      reconciliationSelection: {
        attemptNo: 0,
        factId: retry.factId,
      },
    });
  });

  it("emits the delayed reconciliation fence-rejection probe and preserves the P39 failure", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      retryAttemptNumbers: [0],
      rejectFenceAfterReconciliation: true,
      reconciliationRetry: {
        profile: retry.profile,
        verifiedBinding: retry.verifiedBinding,
        attempt: retry.attempt,
        authority: retry.authority,
        result: retry.result,
        factId: retry.factId,
        settlementEvidence: retry.settlementEvidence,
      },
    };
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              {
                ...intent(retry.argumentsJson),
                toolName: "shell",
                toolVersion: "2",
                invocationId,
                approvalId: null,
              } as never,
              retry.context,
            );
          }),
          {
            onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          },
        ),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () =>
              Effect.die(
                new Error("a stale reconciliation result must not execute"),
              ),
          },
          {},
          trace,
          undefined,
          false,
          retry.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(outcome).toMatchObject({
      _tag: "Failure",
      cause: {
        _tag: "ToolRuntimeOperationalFailure",
        stage: "RecoveryBinding",
        cause: { _tag: "LeaseFencingRejected" },
      },
    });
    expect(trace.qualificationEvents).toContainEqual(
      expect.objectContaining({
        boundary: "AH7ReconciliationResultFenceRejected",
        executionId,
        invocationId,
        attemptNo: 0,
        outcomeTag: "NotOccurred",
        factId: retry.factId,
      }),
    );
    expect(trace.reconciliationCalls).toBe(1);
    expect(trace.reconciliationFactWrites ?? 0).toBe(0);
    expect(trace.retryAttemptNumbers).toEqual([0]);
    expect(trace.effectAdmissions).toBe(0);
  });

  it.each(["recorded-regions", "binding"] as const)(
    "fails closed before reconciliation when the persisted %s no longer matches",
    async (tamper) => {
      const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        reconciliationRetry: {
          profile: retry.profile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: retry.result,
          factId: retry.factId,
          settlementEvidence: retry.settlementEvidence,
          ...(tamper === "binding"
            ? {
                bindingOverride: (() => {
                  const altered = {
                    ...retry.verifiedBinding.value,
                    targetResourceIdentityDigest: "e".repeat(64),
                  };
                  return verifyRecoveryBindingV1({
                    invocationId,
                    canonicalJson: canonicalizeRecoveryBindingV1(altered),
                    bindingSha256: recoveryBindingV1Digest(altered),
                  }) as NonNullable<ReturnType<typeof verifyRecoveryBindingV1>>;
                })(),
              }
            : {}),
        },
      };
      const tamperedPrior =
        tamper === "recorded-regions"
          ? {
              ...retry.prior,
              resolvedRegions: [
                {
                  resourceSpaceId: "tampered-filesystem",
                  normalizedRegion: {
                    _tag: "GitWorktree" as const,
                    path: "/repo/tampered",
                  },
                },
              ],
            }
          : retry.prior;
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(retry.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                retry.context,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.succeed({
                  settlement: { _tag: "Success" as const },
                  observation: { text: "should not run", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            tamperedPrior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.cause).toMatchObject({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "RecoveryBinding",
          cause: { _tag: "RecoveryBindingReplayMismatch" },
        });
      }
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
    },
  );

  it.each(["version", "hash", "effect-key"] as const)(
    "returns OutcomeUnknown without reconciliation when only the trusted profile %s drifts",
    async (drift) => {
      const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
      const currentProfile: ToolReconciliationProfile = {
        ...retry.profile,
        ...(drift === "version" ? { profileVersion: "2" } : {}),
        ...(drift === "hash" ? { profileHash: "f".repeat(64) } : {}),
        ...(drift === "effect-key"
          ? { effectKey: ({ invocationId: id }) => `changed:${id}` }
          : {}),
      };
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        reconciliationRetry: {
          profile: retry.profile,
          registryProfileOverride: currentProfile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: retry.result,
          factId: retry.factId,
          settlementEvidence: retry.settlementEvidence,
        },
      };
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(retry.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                retry.context,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.succeed({
                  settlement: { _tag: "Success" as const },
                  observation: { text: "must not execute", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            retry.prior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome).toEqual({
        _tag: "Success",
        value: {
          _tag: "OutcomeUnknown",
          reconciliationRefs: [String(invocationId)],
        },
      });
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.retryAttemptNumbers).toEqual(undefined);
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.intentWrites).toBe(0);
      expect(executorCalls).toBe(0);
      expect(trace.noEffectDenials).toEqual([]);
    },
  );
});
