import { type ToolInvocationRecord, ToolRuntimePort } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  executionId,
  intent,
  invocationId,
  p39TerminalReceiptCase,
  workspaceId,
} from "./support.js";
import { app } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
  it.each(["NotOccurred", "Success", "ExpectedFailure"] as const)(
    "returns a terminal P40 %s receipt before current-region admission or reconciliation",
    async (terminalOutcome) => {
      const receipt = p39TerminalReceiptCase(terminalOutcome);
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
        workspaceRevisionSequence: [1, 1],
        p39SelectedEvidence: receipt.selected,
        p40WinnerEvidence: receipt.settlementEvidence,
        reconciliationRetry: {
          profile: receipt.profile,
          verifiedBinding: receipt.verifiedBinding,
          attempt: receipt.attempt,
          authority: receipt.authority,
          result: receipt.result,
          factId: receipt.factId,
          settlementEvidence: receipt.settlementEvidence,
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
                  ...intent(receipt.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                receipt.context,
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
                return Effect.die(
                  new Error("terminal receipt replay executed"),
                );
              },
            },
            {},
            trace,
            undefined,
            false,
            receipt.prior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome).toEqual({
        _tag: "Success",
        value: receipt.settlementEvidence.observation,
      });
      expect(trace.p40ReadInvocations).toEqual([
        expect.objectContaining({
          invocationId,
          executionId,
          workspaceId,
          toolName: "shell",
          toolVersion: "2",
          sideEffectSemantics: "Reconcilable",
          argumentsJson: receipt.argumentsJson,
          resolvedRegions: receipt.prior.resolvedRegions,
          approvalId: null,
        }),
      ]);
      expect(trace.p40ReadFences).toEqual([receipt.context.executionFence]);
      expect(trace.p40ReadFenceTimes).toEqual(["2026-01-01T00:00:00.000Z"]);
      expect(trace.p39SelectedReads).toBe(1);
      if (terminalOutcome === "ExpectedFailure") {
        expect(receipt.prior.resultRef).toBeNull();
        expect(receipt.selected.fact.resultRef).toBe(
          "art_p4_occurred_terminal_result",
        );
      }
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
    },
  );

  it("falls back to strict replay when a terminal Reconcilable Success has no P39 selected fact", async () => {
    const receipt = p39TerminalReceiptCase("Success");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      p40WinnerEvidence: receipt.settlementEvidence,
      reconciliationRetry: {
        profile: receipt.profile,
        verifiedBinding: receipt.verifiedBinding,
        attempt: receipt.attempt,
        authority: receipt.authority,
        result: receipt.result,
        factId: receipt.factId,
        settlementEvidence: receipt.settlementEvidence,
      },
    };
    let executorCalls = 0;
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              ...intent(receipt.argumentsJson),
              toolName: "shell",
              toolVersion: "2",
              invocationId,
              approvalId: null,
            } as never,
            receipt.context,
          );
        }),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () => {
              executorCalls += 1;
              return Effect.die(new Error("ordinary receipt replay executed"));
            },
          },
          {},
          trace,
          undefined,
          false,
          receipt.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(result).toEqual(receipt.settlementEvidence.observation);
    expect(trace.p40ReadInvocations).toHaveLength(2);
    expect(trace.resourceAdmissionCalls).toBe(1);
    expect(trace.reconciliationCalls ?? 0).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it("keeps strict current-region identity for ordinary settled receipts", async () => {
    const receipt = p39TerminalReceiptCase();
    const ordinarySettled = {
      ...receipt.prior,
      settledAt: "2026-01-01T00:00:04.000Z",
      settlement: { _tag: "ExpectedFailure" as const },
    } satisfies ToolInvocationRecord;
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
      workspaceRevisionSequence: [1, 1],
      p40WinnerEvidence: receipt.settlementEvidence,
      reconciliationRetry: {
        profile: receipt.profile,
        verifiedBinding: receipt.verifiedBinding,
        attempt: receipt.attempt,
        authority: receipt.authority,
        result: receipt.result,
        factId: receipt.factId,
        settlementEvidence: receipt.settlementEvidence,
      },
    };
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              {
                ...intent(receipt.argumentsJson),
                toolName: "shell",
                toolVersion: "2",
                invocationId,
                approvalId: null,
              } as never,
              receipt.context,
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
              Effect.die(new Error("ordinary receipt drift executed")),
          },
          {},
          trace,
          undefined,
          false,
          ordinarySettled,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.cause).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        cause: { _tag: "ToolInvocationIdentityConflict" },
      });
    }
    expect(trace.p40ReadInvocations ?? []).toHaveLength(1);
    expect(trace.reconciliationCalls ?? 0).toBe(0);
    expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
  });

  it.each([
    "model-identity",
    "callRef",
    "logicalAction",
    "approval-id",
    "missing-selected",
    "corrupt-selected",
    "corrupt-evidence",
    "fence-transition",
  ] as const)(
    "fails closed receipt-first when terminal %s is invalid",
    async (invalidReceipt) => {
      const receipt = p39TerminalReceiptCase();
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        p40WinnerEvidence: receipt.settlementEvidence,
        ...(invalidReceipt === "corrupt-evidence"
          ? { p40ReadFailure: "HashMismatch" as const }
          : {}),
        ...(invalidReceipt === "missing-selected"
          ? {}
          : invalidReceipt === "corrupt-selected"
            ? {
                p39SelectedEvidence: {
                  ...receipt.selected,
                  fact: { ...receipt.selected.fact, factId: "wrong-fact-id" },
                },
              }
            : { p39SelectedEvidence: receipt.selected }),
        ...(invalidReceipt === "fence-transition"
          ? { p39SelectedFenceReject: true }
          : {}),
        ...(invalidReceipt === "missing-selected"
          ? {
              workspaceBoundaryAddresses: [
                { _tag: "GitWorktree" as const, path: "/repo/b" },
              ],
              workspaceRevisionSequence: [1, 1],
            }
          : {}),
        reconciliationRetry: {
          profile: receipt.profile,
          verifiedBinding: receipt.verifiedBinding,
          attempt: receipt.attempt,
          authority: receipt.authority,
          result: receipt.result,
          factId: receipt.factId,
          settlementEvidence: receipt.settlementEvidence,
        },
      };
      const eapId = "eap_terminal_receipt_context";
      const mismatchedPrior =
        invalidReceipt === "model-identity"
          ? { ...receipt.prior, argumentsJson: `${receipt.argumentsJson} ` }
          : invalidReceipt === "approval-id"
            ? { ...receipt.prior, approvalId: eapId }
            : receipt.prior;
      const sourceIdentity = receipt.context.recoveryBindingIdentity;
      if (sourceIdentity === undefined) {
        throw new Error("terminal receipt fixture lacks P3 source identity");
      }
      const contextWithMismatch =
        invalidReceipt === "callRef"
          ? {
              ...receipt.context,
              recoveryBindingIdentity: {
                ...sourceIdentity,
                callRef: "call_wrong_receipt",
              },
            }
          : invalidReceipt === "logicalAction"
            ? {
                ...receipt.context,
                recoveryBindingIdentity: {
                  ...sourceIdentity,
                  logicalActionId: "lac_wrong_receipt",
                },
              }
            : invalidReceipt === "approval-id"
              ? {
                  ...receipt.context,
                  executableApproval: {
                    approvalId: eapId,
                    expectedRevision: 1,
                    state: "Consumed",
                    binding: {
                      executionId,
                      logicalStepNo: 0,
                      repairAttempt: 0,
                      logicalActionId: sourceIdentity.logicalActionId,
                      actionIndex: 0,
                      callRef: "c",
                      toolInvocationId: invocationId,
                    },
                  } as never,
                }
              : receipt.context;
      const intentApprovalId =
        invalidReceipt === "approval-id" ? "iap_different_receipt" : null;
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(receipt.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: intentApprovalId,
                } as never,
                contextWithMismatch,
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
                  observation: { text: "should not execute", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            mismatchedPrior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.cause).toMatchObject({
          _tag:
            invalidReceipt === "fence-transition"
              ? "LeaseFencingRejected"
              : "ToolRuntimeOperationalFailure",
        });
      }
      const readCount =
        invalidReceipt === "model-identity" ||
        invalidReceipt === "callRef" ||
        invalidReceipt === "approval-id"
          ? 0
          : invalidReceipt === "missing-selected"
            ? 1
            : 1;
      expect(trace.p40ReadInvocations ?? []).toHaveLength(readCount);
      expect(trace.p40ReadFences ?? []).toHaveLength(readCount);
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
      expect(trace.environmentResolutions ?? 0).toBe(
        invalidReceipt === "missing-selected" ? 2 : 0,
      );
    },
  );
});
