import type { ExecutionSettlement } from "@arbor/domain";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepRecord,
  SettledProviderTurnResult,
} from "@arbor/ports";

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

const sameStepIdentity = (
  left: AgentLoopStepIdentity,
  right: AgentLoopStepIdentity,
): boolean =>
  left.executionId === right.executionId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt;

const parsedRecord = (value: string): Record<string, unknown> | undefined => {
  try {
    return recordOf(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
};

/** P3 compiler's existing portable request fingerprint codec. */
export const fnv1aHash = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

export const hasValidCompiledInferenceRequestHash = (
  manifest: Record<string, unknown>,
  portableRequestJson: string,
): boolean => {
  if (
    typeof manifest.compiledRequestHash !== "string" ||
    !Array.isArray(manifest.toolRoutes)
  ) {
    return false;
  }
  try {
    const request = JSON.parse(portableRequestJson) as unknown;
    return (
      manifest.compiledRequestHash ===
      fnv1aHash(JSON.stringify({ request, toolRoutes: manifest.toolRoutes }))
    );
  } catch {
    return false;
  }
};

export interface P20OverflowReplacementChain {
  readonly inference: AgentLoopStepProviderTurnLink;
  readonly compaction: AgentLoopStepProviderTurnLink;
  readonly replacement: AgentLoopStepProviderTurnLink;
}

/** Resolve the one complete P20 overflow chain for an exact AgentLoopStep.
 * P9's primary ProviderTurn remains the step identity while the replacement
 * turn may own the step's accepted output manifest. */
export const resolveP20OverflowReplacementChain = (
  links: ReadonlyArray<AgentLoopStepProviderTurnLink>,
  identity: AgentLoopStepIdentity,
  primaryProviderTurnId: string,
): P20OverflowReplacementChain | undefined => {
  if (links.length !== 3) return undefined;
  const inferenceLinks = links.filter((link) => link.role === "Inference");
  const compactionLinks = links.filter(
    (link) => link.role === "OverflowCompaction",
  );
  const replacementLinks = links.filter(
    (link) => link.role === "OverflowReplacement",
  );
  const inference = inferenceLinks[0];
  const compaction = compactionLinks[0];
  const replacement = replacementLinks[0];
  const exactIdentity = (link: AgentLoopStepProviderTurnLink) =>
    sameStepIdentity(link.identity, identity) && link.overflowOrdinal === 0;
  if (
    inferenceLinks.length !== 1 ||
    compactionLinks.length !== 1 ||
    replacementLinks.length !== 1 ||
    inference === undefined ||
    compaction === undefined ||
    replacement === undefined ||
    !exactIdentity(inference) ||
    !exactIdentity(compaction) ||
    !exactIdentity(replacement) ||
    inference.providerTurnId !== primaryProviderTurnId ||
    inference.predecessorProviderTurnId !== undefined ||
    inference.state !== "SettledFailure" ||
    compaction.predecessorProviderTurnId !== inference.providerTurnId ||
    compaction.contextEpoch !== inference.contextEpoch ||
    compaction.state === "SettledFailure" ||
    replacement.predecessorProviderTurnId !== compaction.providerTurnId ||
    Number(replacement.contextEpoch) !== Number(compaction.contextEpoch) + 1 ||
    replacement.state === "SettledFailure" ||
    new Set(links.map((link) => String(link.providerTurnId))).size !== 3
  ) {
    return undefined;
  }
  return { inference, compaction, replacement };
};

/** A resumed step may name the accepted P20 replacement manifest rather than
 * the primary inference manifest. Accept that only when the exact linked
 * replacement has a complete, settled successful receipt. */
export const isP20OverflowReplacementManifestBound = (input: {
  readonly step: AgentLoopStepRecord;
  readonly sessionId: string;
  readonly chain: P20OverflowReplacementChain;
  readonly manifest: {
    readonly manifestId: string;
    readonly manifestJson: string;
    readonly portableRequestJson: string;
  } | null;
  readonly settled: SettledProviderTurnResult;
}): boolean =>
  p20OverflowReplacementManifestBindingFailures(input).length === 0;

export const p20OverflowReplacementManifestBindingFailures = (input: {
  readonly step: AgentLoopStepRecord;
  readonly sessionId: string;
  readonly chain: P20OverflowReplacementChain;
  readonly manifest: {
    readonly manifestId: string;
    readonly manifestJson: string;
    readonly portableRequestJson: string;
  } | null;
  readonly settled: SettledProviderTurnResult;
}): ReadonlyArray<string> => {
  const { step, sessionId, chain, manifest, settled } = input;
  if (manifest === null) return ["manifest-missing"];
  if (settled._tag !== "SettledSuccess") return [`receipt-${settled._tag}`];
  const parsed = parsedRecord(manifest.manifestJson);
  const request = parsedRecord(manifest.portableRequestJson);
  if (parsed === undefined) return ["manifest-invalid-json"];
  if (request === undefined) return ["request-invalid-json"];
  const sourceStep = recordOf(parsed.sourceAgentLoopStep);
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ["step-manifest-id", step.manifestId === manifest.manifestId],
    ["receipt-version", settled.evidenceVersion === "provider-success-v1"],
    ["receipt-manifest-id", settled.manifestId === manifest.manifestId],
    ["receipt-manifest-json", settled.manifestJson === manifest.manifestJson],
    ["turn-manifest-id", settled.turn.manifestId === manifest.manifestId],
    [
      "turn-provider-id",
      settled.turn.providerTurnId === chain.replacement.providerTurnId,
    ],
    [
      "turn-execution-id",
      settled.turn.executionId === step.identity.executionId,
    ],
    ["turn-session-id", settled.turn.sessionId === sessionId],
    [
      "turn-context-epoch",
      settled.turn.contextEpoch === chain.replacement.contextEpoch,
    ],
    [
      "manifest-provider-id",
      parsed.providerTurnId === chain.replacement.providerTurnId,
    ],
    ["manifest-execution-id", parsed.executionId === step.identity.executionId],
    ["manifest-session-id", parsed.sessionId === sessionId],
    [
      "manifest-logical-step",
      parsed.logicalStepNo === step.identity.logicalStepNo,
    ],
    [
      "manifest-repair-attempt",
      parsed.repairAttempt === step.identity.repairAttempt,
    ],
    [
      "manifest-source-step",
      sourceStep === undefined ||
        (sourceStep.executionId === step.identity.executionId &&
          sourceStep.logicalStepNo === step.identity.logicalStepNo &&
          sourceStep.repairAttempt === step.identity.repairAttempt &&
          sourceStep.providerTurnId === step.providerTurnId),
    ],
    [
      "manifest-context-epoch",
      parsed.contextEpoch === chain.replacement.contextEpoch,
    ],
    ["manifest-operation", parsed.operationKind === "Inference"],
    ["manifest-model", parsed.modelRef === settled.turn.modelRef],
    [
      "manifest-output-contract",
      parsed.outputContractRef === settled.turn.outputContractRef,
    ],
    [
      "manifest-binding-fingerprint",
      typeof parsed.resolvedModelBindingFingerprint === "string" &&
        parsed.resolvedModelBindingFingerprint.length > 0,
    ],
    [
      "manifest-compiled-request-hash",
      hasValidCompiledInferenceRequestHash(
        parsed,
        manifest.portableRequestJson,
      ),
    ],
    ["request-version", request.requestVersion === 2],
    ["request-operation", request.operationKind === "Inference"],
    ["request-model", request.modelRef === parsed.modelRef],
    [
      "request-output-contract",
      request.outputContractRef === parsed.outputContractRef,
    ],
  ];
  return checks.filter(([, valid]) => !valid).map(([field]) => field);
};

/** Decode only the settlement shape produced by exhausted output-contract
 * repair. This marker is a terminal frontier only when the persisted payload
 * is complete and internally consistent. */
export const decodeExhaustedRepairDisposition = (
  value: unknown,
): ExecutionSettlement | undefined => {
  const disposition = recordOf(value);
  if (
    disposition === undefined ||
    !hasExactKeys(disposition, ["_tag", "settlement"]) ||
    disposition._tag !== "Exhausted"
  ) {
    return undefined;
  }
  const settlement = recordOf(disposition.settlement);
  if (settlement === undefined) return undefined;
  if (
    settlement._tag === "Failed" &&
    hasExactKeys(settlement, ["_tag", "failure"])
  ) {
    const failure = recordOf(settlement.failure);
    if (
      failure !== undefined &&
      hasExactKeys(failure, ["_tag", "reason"]) &&
      failure._tag === "ExecutionFailure" &&
      typeof failure.reason === "string" &&
      failure.reason.length > 0
    ) {
      return settlement as unknown as ExecutionSettlement;
    }
    return undefined;
  }
  if (
    settlement._tag === "Interrupted" &&
    hasExactKeys(settlement, ["_tag", "result"])
  ) {
    const result = recordOf(settlement.result);
    if (
      result !== undefined &&
      hasExactKeys(result, ["_tag", "reason"]) &&
      result._tag === "ControlledInterruption" &&
      result.reason === "RuntimeSafetyStop"
    ) {
      return settlement as unknown as ExecutionSettlement;
    }
  }
  return undefined;
};

/** Retry OutputRejected rows must point to the exact next repair attempt in
 * both the row's successor column and its persisted disposition. */
export const retryDispositionMatchesSuccessor = (
  step: AgentLoopStepRecord,
  successor: AgentLoopStepRecord,
): boolean => {
  const disposition = recordOf(step.repairDisposition);
  const target = recordOf(disposition?.successor);
  return (
    disposition !== undefined &&
    hasExactKeys(disposition, ["_tag", "successor"]) &&
    disposition._tag === "Retry" &&
    target !== undefined &&
    hasExactKeys(target, [
      "executionId",
      "logicalStepNo",
      "repairAttempt",
      "providerTurnId",
    ]) &&
    target.executionId === successor.identity.executionId &&
    target.logicalStepNo === successor.identity.logicalStepNo &&
    target.repairAttempt === successor.identity.repairAttempt &&
    target.providerTurnId === successor.providerTurnId
  );
};
