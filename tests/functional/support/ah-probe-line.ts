export interface AhProbeHit {
  readonly boundary: string;
  readonly providerTurnId?: string;
  readonly executionId?: string;
  readonly invocationId?: string;
  readonly logicalActionId?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
}

export const recordAhProbeLine = (hits: AhProbeHit[], line: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("tag" in parsed) ||
    parsed.tag !== "AH_PROBE" ||
    !("boundary" in parsed) ||
    typeof parsed.boundary !== "string" ||
    ("providerTurnId" in parsed && typeof parsed.providerTurnId !== "string")
  ) {
    return;
  }
  const hit: AhProbeHit = {
    boundary: parsed.boundary,
    ...("providerTurnId" in parsed && typeof parsed.providerTurnId === "string"
      ? { providerTurnId: parsed.providerTurnId }
      : {}),
    ...("executionId" in parsed && typeof parsed.executionId === "string"
      ? { executionId: parsed.executionId }
      : {}),
    ...("invocationId" in parsed && typeof parsed.invocationId === "string"
      ? { invocationId: parsed.invocationId }
      : {}),
    ...("callRef" in parsed && typeof parsed.callRef === "string"
      ? { callRef: parsed.callRef }
      : {}),
  };
  if (
    "logicalActionId" in parsed &&
    typeof parsed.logicalActionId === "string" &&
    "actionIndex" in parsed &&
    typeof parsed.actionIndex === "number"
  ) {
    hits.push({
      ...hit,
      logicalActionId: parsed.logicalActionId,
      actionIndex: parsed.actionIndex,
    });
    return;
  }
  hits.push(hit);
};
