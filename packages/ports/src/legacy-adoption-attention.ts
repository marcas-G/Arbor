import type {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  WorkspaceId,
} from "@arbor/domain";
import { sha256Hex } from "./provider-extension.js";

export interface LegacyAdoptionMissing {
  readonly _tag: "Missing";
}

export const LEGACY_ADOPTION_MISSING: LegacyAdoptionMissing = Object.freeze({
  _tag: "Missing",
});

export interface LegacyAdoptionEvidenceActionV1 {
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly toolName: string;
  readonly toolSchemaVersion: string;
  readonly inputHash: string;
  readonly stableActionId: string | LegacyAdoptionMissing;
  readonly actionVersion: string | LegacyAdoptionMissing;
  readonly argumentsSha256: string;
  readonly disposition: unknown;
}

export interface LegacyAdoptionEvidenceV1 {
  readonly version: 1;
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly episode: {
    readonly kind: string;
    readonly ref: string;
    readonly revision: number;
  };
  readonly step: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly providerTurnId: ProviderTurnId;
    readonly manifestId: string | LegacyAdoptionMissing;
    readonly decoderVersion: string;
  };
  readonly providerSuccess: {
    readonly attemptNo: number;
    readonly evidenceVersion: string;
    readonly finishReason: string;
    readonly settledAt: string;
    readonly canonicalEventsSha256: string;
  };
  readonly actions: ReadonlyArray<LegacyAdoptionEvidenceActionV1>;
  readonly failureCode: "LegacyActionDispositionUnproven";
}

export interface LegacyAdoptionAttentionFact {
  readonly attentionFactId: string;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly failureCode: "LegacyActionDispositionUnproven";
  readonly evidenceSha256: string;
  readonly firstDetectedAt: string;
}

export type LegacyAdoptionResolutionCode =
  | "DispositionProvenNotAdmitted"
  | "DispositionProvenSettled";

export interface LegacyAdoptionAttentionResolutionFact {
  readonly resolutionFactId: string;
  readonly attentionFactId: string;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly providerTurnId: ProviderTurnId;
  readonly originalEvidenceSha256: string;
  readonly resolutionEvidenceSha256: string;
  readonly actionDispositionSummaryJson: string;
  readonly actionDispositionSummarySha256: string;
  readonly resolutionCode: LegacyAdoptionResolutionCode;
  readonly resolvedAt: string;
}

/** Exact, store-verified P4 disposition evidence for one decoded legacy
 * action. P9 persists this only inside the canonical resolution tuple. */
export interface LegacyAdoptionActionDispositionV1 {
  readonly actionOrdinal: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly toolName: string;
  readonly toolSchemaVersion: string;
  readonly inputHash: string;
  readonly disposition: "Applied" | "NotAdmitted";
  readonly p4Evidence: Readonly<Record<string, unknown>>;
}

export interface LegacyAdoptionResolutionTupleV1 {
  readonly version: 1;
  readonly attentionFactId: string;
  readonly originalEvidenceSha256: string;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly resolutionCode: LegacyAdoptionResolutionCode;
  readonly actionDispositionSummarySha256: string;
  readonly actions: ReadonlyArray<LegacyAdoptionActionDispositionV1>;
}

export interface RecordLegacyAdoptionAttentionFailureInput {
  readonly evidence: LegacyAdoptionEvidenceV1;
  readonly fence: import("./agent-loop-step.js").AgentLoopStepFence;
  /** Selected by the P9 Runtime inside the owning TransactionScope. */
  readonly firstDetectedAt: string;
}

export interface ResolveLegacyAdoptionAttentionInput {
  readonly evidence: LegacyAdoptionEvidenceV1;
  readonly fence: import("./agent-loop-step.js").AgentLoopStepFence;
  /** Selected by P9 in the same transaction as resolution and Step adoption. */
  readonly resolvedAt: string;
}

const codePointCompare = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
};

const canonicalValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("AH14 evidence v1 permits only safe integer numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError("AH14 evidence v1 rejects cycles");
    ancestors.add(value);
    const result = `[${value.map((item) => canonicalValue(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(
      "AH14 evidence v1 rejects undefined and non-JSON values",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("AH14 evidence v1 requires plain JSON objects");
  }
  if (ancestors.has(value))
    throw new TypeError("AH14 evidence v1 rejects cycles");
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  const normalized = Object.keys(record).map((key) => ({
    original: key,
    normalized: key.normalize("NFC"),
  }));
  if (
    new Set(normalized.map(({ normalized: key }) => key)).size !==
    normalized.length
  ) {
    throw new TypeError(
      "AH14 evidence v1 rejects keys colliding after NFC normalization",
    );
  }
  normalized.sort((left, right) =>
    codePointCompare(left.normalized, right.normalized),
  );
  const result = `{${normalized
    .map(({ original, normalized: key }) => {
      const item = record[original];
      if (item === undefined) {
        throw new TypeError(
          "AH14 evidence v1 requires explicit Missing markers",
        );
      }
      return `${JSON.stringify(key)}:${canonicalValue(item, ancestors)}`;
    })
    .join(",")}}`;
  ancestors.delete(value);
  return result;
};

/** Canonical UTF-8 JSON v1: NFC strings, code-point key order, integral numbers. */
export const canonicalizeLegacyAdoptionEvidenceV1 = (value: unknown): string =>
  canonicalValue(value, new Set());

export const legacyAdoptionEvidenceDigestV1 = (value: unknown): string =>
  sha256Hex(canonicalizeLegacyAdoptionEvidenceV1(value));

export const legacyAdoptionAttentionFactIdV1 = (
  executionId: string,
  evidenceSha256: string,
): string =>
  `att_${sha256Hex(
    JSON.stringify({ version: 1, executionId, evidenceSha256 }),
  )}`;

export const legacyAdoptionResolutionFactIdV1 = (input: {
  readonly attentionFactId: string;
  readonly originalEvidenceSha256: string;
  readonly resolutionEvidenceSha256: string;
  readonly resolutionCode: LegacyAdoptionResolutionCode;
}): string =>
  `alr_${sha256Hex(
    JSON.stringify({
      version: 1,
      attentionFactId: input.attentionFactId,
      originalEvidenceSha256: input.originalEvidenceSha256,
      resolutionEvidenceSha256: input.resolutionEvidenceSha256,
      resolutionCode: input.resolutionCode,
    }),
  )}`;

export const canonicalizeLegacyActionDispositionSummaryV1 = (
  actions: ReadonlyArray<{
    readonly actionOrdinal: number;
    readonly logicalActionId: string;
    readonly callRef: string;
    readonly toolName: string;
    readonly toolSchemaVersion: string;
    readonly inputHash: string;
    readonly disposition: "Applied" | "NotAdmitted";
  }>,
): string => canonicalizeLegacyAdoptionEvidenceV1(actions);

export const deriveLegacyAdoptionResolutionCodeV1 = (
  dispositions: ReadonlyArray<string>,
): "DispositionProvenNotAdmitted" | "DispositionProvenSettled" | null => {
  if (dispositions.length === 0) return null;
  if (dispositions.every((value) => value === "NotAdmitted")) {
    return "DispositionProvenNotAdmitted";
  }
  if (
    dispositions.some((value) => value === "Applied") &&
    dispositions.every(
      (value) => value === "Applied" || value === "NotAdmitted",
    )
  ) {
    return "DispositionProvenSettled";
  }
  return null;
};
