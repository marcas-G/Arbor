import { sha256Hex } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { reconstructSubmittedDecisionStopCloseActions } from "../src/submitted-decision-stop-close-plan.js";

const turn = {
  providerTurnId: "ptn_p41_stop_close",
  executionId: "exe_p41_stop_close",
  sessionId: "ses_p41_stop_close",
  contextEpoch: 0,
  modelRef: "model:p41-test",
  outputContractRef: "contract:p41-test",
};
const invocation = {
  callRef: "call_p41_select",
  toolName: "select_current_work",
  argumentsJson: '{"workId":"wrk_selected"}',
};
const canonicalEvents = [
  {
    _tag: "TurnStarted",
    providerTurnId: turn.providerTurnId,
    attemptNo: 0,
    modelRef: turn.modelRef,
  },
  { _tag: "ToolCallProposed", ...invocation },
  { _tag: "TurnCompleted", finishReason: "Stop" },
];
const decodedOutput = {
  providerTurnId: turn.providerTurnId,
  outputContractRef: turn.outputContractRef,
  decoderVersion: "decode-turn-v1",
  text: "",
  finishReason: "Stop",
  toolInvocations: [
    {
      providerTurnId: turn.providerTurnId,
      outputPosition: 0,
      callRef: invocation.callRef,
      toolName: invocation.toolName,
      argumentsJson: invocation.argumentsJson,
    },
  ],
};
const manifest = {
  ...turn,
  logicalStepNo: 0,
  repairAttempt: 0,
  toolRoutes: [{ name: invocation.toolName, route: "Control" }],
};

const makeInput = (
  overrides: {
    manifest?: Record<string, unknown>;
    providerTurn?: Record<string, unknown>;
    stepManifestId?: string;
    decodedOutputHash?: string;
    outputPayload?: unknown;
    action?: Record<string, unknown>;
  } = {},
) => {
  const stepIdentity = {
    executionId: turn.executionId as never,
    logicalStepNo: 0,
    repairAttempt: 0,
  };
  const logicalActionId = `lac_${sha256Hex(
    JSON.stringify({
      executionId: turn.executionId,
      providerTurnId: turn.providerTurnId,
      callRef: invocation.callRef,
      routeKind: "Control",
      actionKind: invocation.toolName,
    }),
  )}`;
  const action = {
    identity: stepIdentity,
    actionIndex: 0,
    logicalActionId,
    callRef: invocation.callRef,
    routeKind: "Control" as const,
    actionKind: invocation.toolName,
    inputHash: sha256Hex(invocation.argumentsJson),
    state: "Pending" as const,
    revision: 0,
    updatedAt: "2026-10-16T00:00:00.000Z",
    ...overrides.action,
  };
  const outputPayload = overrides.outputPayload ?? {
    _tag: "AssistantMessage",
    providerTurnId: turn.providerTurnId,
    contentRef: `provider:${turn.providerTurnId}:assistant`,
    text: decodedOutput.text,
    finishReason: decodedOutput.finishReason,
  };
  return {
    executionId: turn.executionId,
    sessionId: turn.sessionId,
    step: {
      identity: stepIdentity,
      providerTurnId: turn.providerTurnId as never,
      state: "ActionsInProgress" as const,
      nextActionIndex: 0,
      manifestId: overrides.stepManifestId ?? "manifest_corrupted_on_step",
      decodedOutputHash:
        overrides.decodedOutputHash ?? sha256Hex(JSON.stringify(decodedOutput)),
      modelOutputSessionSequence: 20,
      revision: 1,
      updatedAt: "2026-10-16T00:00:00.000Z",
    },
    providerResult: {
      _tag: "SettledSuccess" as const,
      turn: { ...turn, ...overrides.providerTurn },
      manifestId: "manifest_provider_result",
      manifestJson: JSON.stringify(overrides.manifest ?? manifest),
      canonicalEvents,
      evidenceVersion: "provider-success-v1" as const,
    },
    modelOutputEntry: {
      sessionId: turn.sessionId as never,
      sequence: 20,
      entryKind: "ModelOutput" as const,
      payload: outputPayload,
      createdAt: "2026-10-16T00:00:00.000Z",
      source: {
        kind: "ProviderTurn",
        ref: `${turn.providerTurnId}:assistant`,
        contentHash: "p41-model-output-content-hash",
      },
    },
    existingActions: [action],
    logicalActionId,
  };
};

const reconstruct = (input: ReturnType<typeof makeInput>) =>
  reconstructSubmittedDecisionStopCloseActions(
    input as unknown as Parameters<
      typeof reconstructSubmittedDecisionStopCloseActions
    >[0],
  );

describe("P41 pinned action reconstruction for Stop-only close", () => {
  it("reconstructs the exact pinned action from current typed ModelOutput even when the Step Manifest is mismatched", () => {
    const fixture = makeInput();
    const actions = reconstruct(fixture);
    expect(actions).toHaveLength(1);
    expect(actions?.[0]).toMatchObject({
      actionIndex: 0,
      logicalActionId: fixture.logicalActionId,
      callRef: invocation.callRef,
      routeKind: "Control",
      actionKind: "select_current_work",
      inputHash: sha256Hex(invocation.argumentsJson),
    });
  });

  it("reconstructs the same pinned action from a legacy decoded-output entry", () => {
    const actions = reconstruct(makeInput({ outputPayload: decodedOutput }));
    expect(actions).toHaveLength(1);
    expect(actions?.[0]?.actionKind).toBe("select_current_work");
  });

  it.each([
    ["ProviderTurn identity", { providerTurnId: "ptn_other" }],
    ["Execution identity", { executionId: "exe_other" }],
    ["Session identity", { sessionId: "ses_other" }],
    ["context epoch", { contextEpoch: 1 }],
    ["model identity", { modelRef: "model:other" }],
    ["output-contract identity", { outputContractRef: "contract:other" }],
    ["logical Step", { logicalStepNo: 1 }],
    ["repair attempt", { repairAttempt: 1 }],
  ] as const)(
    "fails closed on a Manifest %s mismatch",
    (_name, manifestPatch) => {
      expect(
        reconstruct(makeInput({ manifest: { ...manifest, ...manifestPatch } })),
      ).toBeUndefined();
    },
  );

  it("fails closed on decoded-output hash and action-ledger identity mismatches", () => {
    expect(
      reconstruct(makeInput({ decodedOutputHash: "0".repeat(64) })),
    ).toBeUndefined();
    expect(
      reconstruct(
        makeInput({
          action: { callRef: "call_other" },
        }),
      ),
    ).toBeUndefined();
    expect(
      reconstruct(
        makeInput({
          action: { inputHash: "0".repeat(64) },
        }),
      ),
    ).toBeUndefined();
  });
});
