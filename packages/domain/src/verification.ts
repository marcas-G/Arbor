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

export const VerificationMission = Schema.Struct({
  goal: Schema.String,
  criteria: Schema.Array(Schema.String),
  riskRequirements: Schema.Array(Schema.String),
});

export type VerificationMission = Schema.Schema.Type<
  typeof VerificationMission
>;

export const VerificationVerdict = Schema.Literals(["Pass", "Fail", "Unknown"]);

export type VerificationVerdict = Schema.Schema.Type<
  typeof VerificationVerdict
>;

export type VerificationState =
  | { readonly status: "Open" }
  | { readonly status: "Concluded"; readonly verdict: VerificationVerdict };

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
): DomainResult<Verification> => {
  if (verification.state.status !== "Open") {
    return err(concludedError());
  }
  return ok({
    ...verification,
    state: { status: "Concluded", verdict },
  });
};

export const isVerificationOpen = (verification: Verification): boolean =>
  verification.state.status === "Open";

export const isVerificationConcluded = (verification: Verification): boolean =>
  verification.state.status === "Concluded";
