import { Schema } from "effect";
import type { DomainError } from "./errors.js";
import type {
  ArtifactId,
  DeliverableId,
  EvidenceId,
  ExecutionId,
  VerificationId,
  WorkId,
} from "./ids.js";
import type { WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

/** v1.11 G1 (M-2): structured criteria — required/optional distinction. */
export const VerificationCriterion = Schema.Struct({
  criterionId: Schema.String,
  requirement: Schema.String,
  required: Schema.Boolean,
});

export const VerificationMission = Schema.Struct({
  goal: Schema.String,
  criteria: Schema.Array(VerificationCriterion),
  riskRequirements: Schema.Array(Schema.String),
});

export type VerificationCriterionType = Schema.Schema.Type<
  typeof VerificationCriterion
>;

export type VerificationMission = Schema.Schema.Type<
  typeof VerificationMission
>;

export const VerificationVerdict = Schema.Literals(["Pass", "Fail", "Unknown"]);

export type VerificationVerdict = Schema.Schema.Type<
  typeof VerificationVerdict
>;

export type ConclusionReason = "Orphaned";

/** v1.11 G1: required-qualified deterministic aggregation (SD §9.6). */
export const aggregateVerdict = (
  results: ReadonlyArray<{
    readonly required: boolean;
    readonly verdict: VerificationVerdict;
  }>,
): VerificationVerdict => {
  if (results.some((result) => result.required && result.verdict === "Fail")) {
    return "Fail";
  }
  if (
    results.some((result) => result.required && result.verdict === "Unknown")
  ) {
    return "Unknown";
  }
  return "Pass";
};

export type VerificationState =
  | { readonly status: "Open" }
  | {
      readonly status: "Concluded";
      readonly verdict: VerificationVerdict;
      /** v1.11 G5: only ever "Orphaned", and only with verdict Unknown. */
      readonly conclusionReason?: ConclusionReason;
    };

export interface Verification {
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly missionSnapshot: VerificationMission;
  readonly targetDeliverables: ReadonlyArray<DeliverableId>;
  readonly targetArtifactVersions: ReadonlyArray<ArtifactId>;
  readonly targetEnvironmentRevision: string | null;
  readonly environmentSnapshotRef: string | null;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
  readonly verificationExecutionIds: ReadonlyArray<ExecutionId>;
  readonly state: VerificationState;
}

export interface StartVerificationInput {
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly missionSnapshot: VerificationMission;
  readonly targetDeliverables?: ReadonlyArray<DeliverableId>;
  readonly targetArtifactVersions?: ReadonlyArray<ArtifactId>;
  readonly targetEnvironmentRevision?: string | null;
  readonly environmentSnapshotRef?: string | null;
  readonly verificationExecutionIds?: ReadonlyArray<ExecutionId>;
}

export const startVerification = (
  input: StartVerificationInput,
): Verification => ({
  verificationId: input.verificationId,
  workId: input.workId,
  targetWorkRevision: input.targetWorkRevision,
  missionSnapshot: input.missionSnapshot,
  targetDeliverables: input.targetDeliverables ?? [],
  targetArtifactVersions: input.targetArtifactVersions ?? [],
  targetEnvironmentRevision: input.targetEnvironmentRevision ?? null,
  environmentSnapshotRef: input.environmentSnapshotRef ?? null,
  evidenceRefs: [],
  verificationExecutionIds: input.verificationExecutionIds ?? [],
  state: { status: "Open" },
});

const concludedError = (): DomainError => ({
  _tag: "TerminalLifecycleMutation",
  entity: "Verification",
  lifecycle: "Concluded",
});

export const recordVerificationEvidence = (
  verification: Verification,
  evidenceId: EvidenceId,
): DomainResult<Verification> => {
  if (verification.state.status !== "Open") {
    return err(concludedError());
  }
  return ok({
    ...verification,
    evidenceRefs: [...verification.evidenceRefs, evidenceId],
  });
};

export const concludeVerification = (
  verification: Verification,
  verdict: VerificationVerdict,
  conclusionReason?: ConclusionReason,
): DomainResult<Verification> => {
  if (verification.state.status !== "Open") {
    return err(concludedError());
  }
  if (conclusionReason === "Orphaned" && verdict !== "Unknown") {
    return err({
      _tag: "AuthorityDenied",
      reason:
        "conclusionReason Orphaned pairs only with verdict Unknown (v1.11 G5)",
    });
  }
  return ok({
    ...verification,
    state:
      conclusionReason === undefined
        ? { status: "Concluded", verdict }
        : { status: "Concluded", verdict, conclusionReason },
  });
};

export const isVerificationOpen = (verification: Verification): boolean =>
  verification.state.status === "Open";

export const isVerificationConcluded = (verification: Verification): boolean =>
  verification.state.status === "Concluded";
