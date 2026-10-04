export interface AhProbeHit {
  readonly boundary: string;
  readonly providerTurnId: string;
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
    !("providerTurnId" in parsed) ||
    typeof parsed.providerTurnId !== "string"
  ) {
    return;
  }
  hits.push({
    boundary: parsed.boundary,
    providerTurnId: parsed.providerTurnId,
  });
};
