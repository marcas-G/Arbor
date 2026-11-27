import {
  canonicalizeRecoveryBindingV1,
  recoveryBindingV1Digest,
  type ToolReconciliationProfile,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  executionId,
  invocationId,
  mustNotExecuteShellExecutor,
  p39NotOccurredRetryCase,
} from "./support.js";
import {
  retryApp,
  runShellRetry,
  runShellRetryMatched,
} from "./support-app.js";
import {
  newTrace,
  type PipelineTrace,
  retryHarness,
} from "./support-harness.js";

describe("tool runtime pipeline", () => {
  it("reconciles against the persisted scope before denying a changed current resource boundary", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      ...newTrace(),
      retryAttemptNumbers: [0],
      workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
      workspaceRevisionSequence: [1, 1],
      reconciliationRetry: retryHarness(retry),
    };
    const result = await runShellRetry(
      retryApp(
        mustNotExecuteShellExecutor(
          "a stale P39 resource boundary must not execute",
        ),
        trace,
        retry.prior,
      ),
      retry.context,
      retry.argumentsJson,
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

  it("emits the delayed reconciliation fence-rejection probe and preserves the failure", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      ...newTrace(),
      retryAttemptNumbers: [0],
      rejectFenceAfterReconciliation: true,
      reconciliationRetry: retryHarness(retry),
    };
    const outcome = await runShellRetryMatched(
      retryApp(
        mustNotExecuteShellExecutor(
          "a stale reconciliation result must not execute",
        ),
        trace,
        retry.prior,
      ),
      retry.context,
      retry.argumentsJson,
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
        ...newTrace(),
        reconciliationRetry: {
          ...retryHarness(retry),
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
      const outcome = await runShellRetryMatched(
        retryApp(
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
          trace,
          tamperedPrior,
        ),
        retry.context,
        retry.argumentsJson,
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
        ...newTrace(),
        reconciliationRetry: {
          ...retryHarness(retry),
          registryProfileOverride: currentProfile,
        },
      };
      let executorCalls = 0;
      const outcome = await runShellRetryMatched(
        retryApp(
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
          trace,
          retry.prior,
        ),
        retry.context,
        retry.argumentsJson,
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
