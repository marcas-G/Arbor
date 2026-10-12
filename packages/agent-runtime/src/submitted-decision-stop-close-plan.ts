import { decodeTurn } from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
  CanonicalProviderEvent,
  SessionEntryRecord,
  SettledProviderTurnResult,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";

export interface SubmittedDecisionCloseActionIdentity {
  readonly identity: AgentLoopStepActionRecord["identity"];
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly routeKind: "Executable" | "Control";
  readonly actionKind: string;
  readonly inputHash: string;
  readonly existing?: AgentLoopStepActionRecord;
}

export type SubmittedDecisionStopClosePlanResult =
  | {
      readonly _tag: "Ready";
      readonly step: AgentLoopStepRecord;
      readonly actions: ReadonlyArray<AgentLoopStepActionRecord>;
    }
  | { readonly _tag: "InsufficientEvidence" };

export const reconstructSubmittedDecisionStopCloseActions = (input: {
  readonly executionId: string;
  readonly sessionId: string;
  readonly step: AgentLoopStepRecord;
  readonly providerResult: SettledProviderTurnResult;
  readonly modelOutputEntry: SessionEntryRecord | undefined;
  readonly existingActions: ReadonlyArray<AgentLoopStepActionRecord>;
}): ReadonlyArray<SubmittedDecisionCloseActionIdentity> | undefined => {
  const { step, providerResult, modelOutputEntry } = input;
  if (
    providerResult._tag !== "SettledSuccess" ||
    providerResult.turn.providerTurnId !== step.providerTurnId ||
    modelOutputEntry?.entryKind !== "ModelOutput" ||
    modelOutputEntry.sequence !== step.modelOutputSessionSequence ||
    step.decodedOutputHash === undefined
  ) {
    return undefined;
  }
  let manifest: {
    providerTurnId?: unknown;
    executionId?: unknown;
    sessionId?: unknown;
    outputContractRef?: unknown;
    toolRoutes?: ReadonlyArray<{
      name: string;
      route: "Executable" | "Control";
    }>;
    logicalStepNo?: unknown;
    repairAttempt?: unknown;
  };
  try {
    manifest = JSON.parse(providerResult.manifestJson) as typeof manifest;
  } catch {
    return undefined;
  }
  if (
    manifest.providerTurnId !== step.providerTurnId ||
    manifest.executionId !== input.executionId ||
    manifest.sessionId !== input.sessionId ||
    (manifest.logicalStepNo !== undefined &&
      manifest.logicalStepNo !== step.identity.logicalStepNo) ||
    (manifest.repairAttempt !== undefined &&
      manifest.repairAttempt !== step.identity.repairAttempt) ||
    typeof manifest.outputContractRef !== "string" ||
    !Array.isArray(manifest.toolRoutes)
  ) {
    return undefined;
  }
  const decoded = decodeTurn(
    providerResult.canonicalEvents as ReadonlyArray<CanonicalProviderEvent>,
  );
  if (!decoded.ok) return undefined;
  const outputPayload = {
    providerTurnId: step.providerTurnId,
    outputContractRef: manifest.outputContractRef,
    decoderVersion: "decode-turn-v1",
    text: decoded.output.text,
    finishReason: decoded.output.finishReason,
    toolInvocations: decoded.output.toolInvocations,
  };
  if (
    sha256Hex(JSON.stringify(outputPayload)) !== step.decodedOutputHash ||
    JSON.stringify(modelOutputEntry.payload) !== JSON.stringify(outputPayload)
  ) {
    return undefined;
  }
  const existingByIndex = new Map(
    input.existingActions.map((action) => [action.actionIndex, action]),
  );
  if (
    existingByIndex.size !== input.existingActions.length ||
    input.existingActions.some(
      (action) =>
        action.actionIndex >= decoded.output.toolInvocations.length ||
        action.actionIndex < 0,
    )
  ) {
    return undefined;
  }
  for (let index = 0; index < step.nextActionIndex; index += 1) {
    const prior = existingByIndex.get(index);
    if (prior === undefined || prior.state === "Pending") return undefined;
  }
  const routes = new Map(
    manifest.toolRoutes.map((tool) => [tool.name, tool.route]),
  );
  const actions: SubmittedDecisionCloseActionIdentity[] = [];
  for (
    let actionIndex = 0;
    actionIndex < decoded.output.toolInvocations.length;
    actionIndex += 1
  ) {
    const invocation = decoded.output.toolInvocations[actionIndex];
    if (invocation === undefined) return undefined;
    const routeKind = routes.get(invocation.toolName);
    if (routeKind === undefined) return undefined;
    const identity = step.identity;
    const logicalActionId = `lac_${sha256Hex(
      JSON.stringify({
        executionId: input.executionId,
        providerTurnId: step.providerTurnId,
        callRef: invocation.callRef,
        routeKind,
        actionKind: invocation.toolName,
      }),
    )}`;
    const existing = existingByIndex.get(actionIndex);
    const descriptor = {
      identity,
      actionIndex,
      logicalActionId,
      callRef: invocation.callRef,
      routeKind,
      actionKind: invocation.toolName,
      inputHash: sha256Hex(invocation.argumentsJson),
      ...(existing === undefined ? {} : { existing }),
    } satisfies SubmittedDecisionCloseActionIdentity;
    if (
      existing !== undefined &&
      (existing.identity.executionId !== identity.executionId ||
        existing.identity.logicalStepNo !== identity.logicalStepNo ||
        existing.identity.repairAttempt !== identity.repairAttempt ||
        existing.logicalActionId !== logicalActionId ||
        existing.callRef !== invocation.callRef ||
        existing.routeKind !== routeKind ||
        existing.actionKind !== invocation.toolName ||
        existing.inputHash !== descriptor.inputHash)
    ) {
      return undefined;
    }
    actions.push(descriptor);
  }
  return actions;
};

/** P3's pure stop-only close plan. The caller must supply the complete
 * decoder-verified action list and exact persisted identity matches. */
export const planSubmittedDecisionStopClose = (input: {
  readonly step: AgentLoopStepRecord;
  readonly actions: ReadonlyArray<SubmittedDecisionCloseActionIdentity>;
  readonly firstDetectedActionId: string;
  readonly updatedAt: string;
}): SubmittedDecisionStopClosePlanResult => {
  const { step, actions } = input;
  if (
    step.state !== "ActionsInProgress" ||
    step.nextActionIndex < 0 ||
    step.nextActionIndex >= actions.length ||
    actions.some(
      (action, index) =>
        action.actionIndex !== index ||
        action.identity.executionId !== step.identity.executionId ||
        action.identity.logicalStepNo !== step.identity.logicalStepNo ||
        action.identity.repairAttempt !== step.identity.repairAttempt ||
        (action.existing !== undefined &&
          (action.existing.identity.executionId !== step.identity.executionId ||
            action.existing.identity.logicalStepNo !==
              step.identity.logicalStepNo ||
            action.existing.identity.repairAttempt !==
              step.identity.repairAttempt ||
            action.existing.actionIndex !== action.actionIndex ||
            action.existing.logicalActionId !== action.logicalActionId ||
            action.existing.callRef !== action.callRef ||
            action.existing.routeKind !== action.routeKind ||
            action.existing.actionKind !== action.actionKind ||
            action.existing.inputHash !== action.inputHash ||
            (index >= step.nextActionIndex &&
              action.existing.state !== "Pending"))),
    )
  ) {
    return { _tag: "InsufficientEvidence" };
  }
  const current = actions[step.nextActionIndex];
  if (
    current === undefined ||
    current.logicalActionId !== input.firstDetectedActionId ||
    current.actionKind !== "select_current_work" ||
    current.routeKind !== "Control" ||
    current.existing === undefined ||
    current.existing.state !== "Pending" ||
    current.existing.identity.executionId !== step.identity.executionId ||
    current.existing.identity.logicalStepNo !== step.identity.logicalStepNo ||
    current.existing.identity.repairAttempt !== step.identity.repairAttempt ||
    current.existing.actionIndex !== step.nextActionIndex ||
    current.existing.logicalActionId !== current.logicalActionId ||
    current.existing.callRef !== current.callRef ||
    current.existing.routeKind !== current.routeKind ||
    current.existing.actionKind !== current.actionKind ||
    current.existing.inputHash !== current.inputHash
  ) {
    return { _tag: "InsufficientEvidence" };
  }

  const plannedActions = actions
    .filter((action) => action.actionIndex >= step.nextActionIndex)
    .map((action) => {
      const existing = action.existing;
      const state =
        action.actionIndex === step.nextActionIndex
          ? "TerminalRejected"
          : "SkippedEarlySettlement";
      return {
        identity: action.identity,
        actionIndex: action.actionIndex,
        logicalActionId: action.logicalActionId,
        callRef: action.callRef,
        routeKind: action.routeKind,
        actionKind: action.actionKind,
        inputHash: action.inputHash,
        state,
        ...(existing?.resultRef === undefined
          ? {}
          : { resultRef: existing.resultRef }),
        disposition: {
          _tag:
            action.actionIndex === step.nextActionIndex
              ? "StopRequestedAfterSubmittedBindingFailure"
              : "SkippedEarlySettlement",
        },
        revision: existing === undefined ? 0 : existing.revision + 1,
        updatedAt: input.updatedAt,
      } satisfies AgentLoopStepActionRecord;
    });
  return {
    _tag: "Ready",
    actions: plannedActions,
    step: {
      ...step,
      state: "SettlementProposed",
      nextActionIndex: actions.length,
      settlement: {
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      },
      revision: step.revision + 1,
      updatedAt: input.updatedAt,
    },
  };
};
