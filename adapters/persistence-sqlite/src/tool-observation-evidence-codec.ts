import { createHash } from "node:crypto";
import { ArtifactId, parse } from "@arbor/domain";
import {
  P4_TOOL_OBSERVATION_FORMAT_V1,
  P4_TOOL_OBSERVATION_MAX_TEXT_UTF16_CODE_UNITS,
  type ToolObservationEvidence,
  type ToolObservationEvidenceObservation,
  type ToolObservationReplayFailureCode,
  type ToolObservationSettlement,
} from "@arbor/ports";

const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_OBSERVATION_BYTES = 16_384;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isArtifactRef = (value: string): boolean => {
  try {
    return parse(ArtifactId)(value) === value;
  } catch {
    return false;
  }
};

const tagged = (value: unknown): value is { readonly _tag: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly _tag?: unknown })._tag === "string";

const exactKeys = (value: unknown, keys: ReadonlyArray<string>): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const isBoundedObservation = (value: unknown): boolean =>
  exactKeys(value, ["text", "truncated"]) &&
  typeof (value as { readonly text?: unknown }).text === "string" &&
  (value as { readonly text: string }).text.length <=
    P4_TOOL_OBSERVATION_MAX_TEXT_UTF16_CODE_UNITS &&
  typeof (value as { readonly truncated?: unknown }).truncated === "boolean";

const isSandboxUnavailableMetadata = (value: unknown): boolean => {
  if (
    !exactKeys(value, [
      "policyRevision",
      "policyDigest",
      "profile",
      "providerId",
      "providerVersion",
      "capabilityRevision",
      "probeEvidenceRef",
      "failureCode",
      "effectDisposition",
    ])
  ) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(record.policyRevision) &&
    (record.policyRevision as number) > 0 &&
    typeof record.policyDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(record.policyDigest) &&
    ["ReadOnly", "WorkspaceWrite", "FullAccess"].includes(
      String(record.profile),
    ) &&
    typeof record.providerId === "string" &&
    record.providerId.length > 0 &&
    record.providerId.trim() === record.providerId &&
    typeof record.providerVersion === "string" &&
    record.providerVersion.length > 0 &&
    record.providerVersion.trim() === record.providerVersion &&
    typeof record.capabilityRevision === "string" &&
    record.capabilityRevision.length > 0 &&
    record.capabilityRevision.trim() === record.capabilityRevision &&
    (record.probeEvidenceRef === null ||
      (typeof record.probeEvidenceRef === "string" &&
        record.probeEvidenceRef.length > 0 &&
        record.probeEvidenceRef.trim() === record.probeEvidenceRef)) &&
    typeof record.failureCode === "string" &&
    record.failureCode.length > 0 &&
    record.failureCode.trim() === record.failureCode &&
    utf8.encode(record.failureCode).byteLength <= 128 &&
    record.effectDisposition === "NoEffect"
  );
};

const canonicalJson = (
  observation: ToolObservationEvidenceObservation,
): string => {
  switch (observation._tag) {
    case "Success":
      return JSON.stringify({
        _tag: observation._tag,
        observation: {
          text: observation.observation.text,
          truncated: observation.observation.truncated,
        },
        resultRef: observation.resultRef,
      });
    case "ExpectedFailure":
      return JSON.stringify({
        _tag: observation._tag,
        observation: {
          text: observation.observation.text,
          truncated: observation.observation.truncated,
        },
        ...(observation.sandboxProviderUnavailable === undefined
          ? {}
          : {
              sandboxProviderUnavailable: {
                policyRevision:
                  observation.sandboxProviderUnavailable.policyRevision,
                policyDigest:
                  observation.sandboxProviderUnavailable.policyDigest,
                profile: observation.sandboxProviderUnavailable.profile,
                providerId: observation.sandboxProviderUnavailable.providerId,
                providerVersion:
                  observation.sandboxProviderUnavailable.providerVersion,
                capabilityRevision:
                  observation.sandboxProviderUnavailable.capabilityRevision,
                probeEvidenceRef:
                  observation.sandboxProviderUnavailable.probeEvidenceRef,
                failureCode: observation.sandboxProviderUnavailable.failureCode,
                effectDisposition:
                  observation.sandboxProviderUnavailable.effectDisposition,
              },
            }),
      });
    case "Denied":
      return JSON.stringify({
        _tag: observation._tag,
        reasonCode: observation.reasonCode,
        reason: observation.reason,
      });
    case "ApprovalRequired":
      // Nonterminal approvals never produce ToolInvocation evidence. The
      // shape validator rejects this tag before canonicalization; keep an
      // empty sentinel here so a future call site fails the nonempty check.
      return "";
    case "SandboxProviderUnavailable":
      // Nonterminal process-policy results never create tool-observation
      // evidence; P9 consumes the typed outcome directly.
      return "";
    case "SandboxPolicyRequiredInterruption":
      // A required human policy is a nonterminal park, never P40 evidence.
      return "";
    case "Interrupted":
      return JSON.stringify({ _tag: observation._tag });
    case "OutcomeUnknown":
      return JSON.stringify({
        _tag: observation._tag,
        reconciliationRefs: [...observation.reconciliationRefs],
      });
    case "RuntimeFailure":
      return JSON.stringify({
        _tag: observation._tag,
        cause: observation.cause,
      });
    case "ReconciledNoEffect":
      return JSON.stringify({
        _tag: observation._tag,
        reasonCode: observation.reasonCode,
        reconciliationFactRef: observation.reconciliationFactRef,
        observation: {
          text: observation.observation.text,
          truncated: observation.observation.truncated,
        },
        resultRef: observation.resultRef,
      });
  }
};

const matchesSettlement = (
  observation: ToolObservationEvidenceObservation,
  settlement: ToolObservationSettlement,
): ToolObservationReplayFailureCode | undefined => {
  if (observation._tag !== settlement._tag) return "SettlementMismatch";
  switch (settlement._tag) {
    case "Success":
      return observation._tag === "Success" ? undefined : "SettlementMismatch";
    case "ExpectedFailure":
      return observation._tag === "ExpectedFailure"
        ? undefined
        : "SettlementMismatch";
    case "Interrupted":
      return observation._tag === "Interrupted"
        ? undefined
        : "SettlementMismatch";
    case "OutcomeUnknown":
      return observation._tag === "OutcomeUnknown" &&
        JSON.stringify(observation.reconciliationRefs) ===
          JSON.stringify(settlement.reconciliationRefs)
        ? undefined
        : "SettlementMismatch";
    case "RuntimeFailure":
      return observation._tag === "RuntimeFailure" &&
        observation.cause === settlement.cause
        ? undefined
        : "SettlementMismatch";
    case "ReconciledNoEffect":
      return observation._tag === "ReconciledNoEffect" &&
        observation.reasonCode === settlement.reasonCode &&
        observation.reconciliationFactRef === settlement.reconciliationFactRef
        ? undefined
        : "SettlementMismatch";
  }
};

const validateShape = (
  value: unknown,
): value is ToolObservationEvidenceObservation => {
  if (!tagged(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  switch (record._tag) {
    case "Success":
      return (
        exactKeys(value, ["_tag", "observation", "resultRef"]) &&
        isBoundedObservation(record.observation) &&
        (record.resultRef === null || typeof record.resultRef === "string")
      );
    case "ExpectedFailure":
      return (
        (exactKeys(value, ["_tag", "observation"]) ||
          exactKeys(value, [
            "_tag",
            "observation",
            "sandboxProviderUnavailable",
          ])) &&
        isBoundedObservation(record.observation) &&
        (record.sandboxProviderUnavailable === undefined ||
          isSandboxUnavailableMetadata(record.sandboxProviderUnavailable))
      );
    case "Interrupted":
      return exactKeys(value, ["_tag"]);
    case "OutcomeUnknown":
      return (
        exactKeys(value, ["_tag", "reconciliationRefs"]) &&
        Array.isArray(record.reconciliationRefs) &&
        record.reconciliationRefs.length >= 1 &&
        record.reconciliationRefs.length <= 8 &&
        record.reconciliationRefs.every(
          (ref) =>
            typeof ref === "string" && utf8.encode(ref).byteLength <= 128,
        )
      );
    case "RuntimeFailure":
      return (
        exactKeys(value, ["_tag", "cause"]) &&
        typeof record.cause === "string" &&
        utf8.encode(record.cause).byteLength <= 1024
      );
    case "ReconciledNoEffect":
      return (
        exactKeys(value, [
          "_tag",
          "reasonCode",
          "reconciliationFactRef",
          "observation",
          "resultRef",
        ]) &&
        [
          "AuthoritySnapshotChanged",
          "ResourceSnapshotChanged",
          "ApprovalNoLongerAuthorized",
          "StopRequested",
          "ReplayLimitReached",
        ].includes(String(record.reasonCode)) &&
        typeof record.reconciliationFactRef === "string" &&
        record.reconciliationFactRef.length > 0 &&
        isBoundedObservation(record.observation) &&
        typeof record.resultRef === "string" &&
        record.resultRef.length > 0
      );
    default:
      return false;
  }
};

export const encodeToolObservationEvidence = (input: {
  readonly observation: ToolObservationEvidenceObservation;
  readonly settlement: ToolObservationSettlement;
  readonly resultRef: string | null;
}):
  | { readonly _tag: "Encoded"; readonly evidence: ToolObservationEvidence }
  | {
      readonly _tag: "Failure";
      readonly failureCode: ToolObservationReplayFailureCode;
    } => {
  const { observation, settlement, resultRef } = input;
  if (observation._tag === "Denied") {
    return { _tag: "Failure", failureCode: "UnexpectedResultRef" };
  }
  if (!validateShape(observation)) {
    return { _tag: "Failure", failureCode: "Malformed" };
  }
  const settlementFailure = matchesSettlement(observation, settlement);
  if (settlementFailure !== undefined) {
    return { _tag: "Failure", failureCode: settlementFailure };
  }
  if (observation._tag === "Success" && observation.resultRef !== resultRef) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  if (
    resultRef !== null &&
    (observation._tag === "Success" ||
      observation._tag === "ReconciledNoEffect") &&
    !isArtifactRef(resultRef)
  ) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  if (
    observation._tag !== "Success" &&
    observation._tag !== "ReconciledNoEffect" &&
    resultRef !== null
  ) {
    return { _tag: "Failure", failureCode: "UnexpectedResultRef" };
  }
  if (
    observation._tag === "ReconciledNoEffect" &&
    observation.resultRef !== resultRef
  ) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  const bytes = utf8.encode(canonicalJson(observation));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OBSERVATION_BYTES) {
    return { _tag: "Failure", failureCode: "Malformed" };
  }
  const hashBytes = utf8.encode(`${P4_TOOL_OBSERVATION_FORMAT_V1}\n`);
  const digest = sha256(Uint8Array.from([...hashBytes, ...bytes]));
  return {
    _tag: "Encoded",
    evidence: {
      formatVersion: P4_TOOL_OBSERVATION_FORMAT_V1,
      bytes,
      sha256: digest,
      observation,
    },
  };
};

export const decodeToolObservationEvidence = (input: {
  readonly formatVersion: string | null;
  readonly bytes: Uint8Array | null;
  readonly sha256: string | null;
  readonly settlement: ToolObservationSettlement | null;
  readonly resultRef: string | null;
}):
  | { readonly _tag: "Decoded"; readonly evidence: ToolObservationEvidence }
  | {
      readonly _tag: "Failure";
      readonly failureCode: ToolObservationReplayFailureCode;
    } => {
  const {
    formatVersion,
    bytes,
    sha256: storedHash,
    settlement,
    resultRef,
  } = input;
  if (formatVersion === null || bytes === null || storedHash === null) {
    return { _tag: "Failure", failureCode: "Missing" };
  }
  if (formatVersion !== P4_TOOL_OBSERVATION_FORMAT_V1) {
    return { _tag: "Failure", failureCode: "UnsupportedVersion" };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OBSERVATION_BYTES) {
    return { _tag: "Failure", failureCode: "Malformed" };
  }
  const expectedHash = sha256(
    Uint8Array.from([
      ...utf8.encode(`${P4_TOOL_OBSERVATION_FORMAT_V1}\n`),
      ...bytes,
    ]),
  );
  if (!/^[0-9a-f]{64}$/.test(storedHash) || expectedHash !== storedHash) {
    return { _tag: "Failure", failureCode: "HashMismatch" };
  }
  if (settlement === null) {
    return { _tag: "Failure", failureCode: "SettlementMismatch" };
  }
  let json: string;
  let parsed: unknown;
  try {
    json = fatalUtf8.decode(bytes);
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { _tag: "Failure", failureCode: "Malformed" };
  }
  if (!validateShape(parsed) || JSON.stringify(parsed) !== json) {
    return { _tag: "Failure", failureCode: "Malformed" };
  }
  const settlementFailure = matchesSettlement(parsed, settlement);
  if (settlementFailure !== undefined) {
    return { _tag: "Failure", failureCode: settlementFailure };
  }
  if (parsed._tag === "Success" && parsed.resultRef !== resultRef) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  if (
    resultRef !== null &&
    (parsed._tag === "Success" || parsed._tag === "ReconciledNoEffect") &&
    !isArtifactRef(resultRef)
  ) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  if (parsed._tag === "ReconciledNoEffect" && parsed.resultRef !== resultRef) {
    return { _tag: "Failure", failureCode: "ResultRefMismatch" };
  }
  if (
    parsed._tag !== "Success" &&
    parsed._tag !== "ReconciledNoEffect" &&
    resultRef !== null
  ) {
    return { _tag: "Failure", failureCode: "UnexpectedResultRef" };
  }
  return {
    _tag: "Decoded",
    evidence: {
      formatVersion,
      bytes,
      sha256: storedHash,
      observation: parsed,
    },
  };
};
