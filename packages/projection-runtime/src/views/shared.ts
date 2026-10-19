import type {
  AcceptanceId,
  Actor,
  CommandId,
  DeliverableId,
  Dependency,
  DependencyId,
  EventTypeName,
  EvidenceId,
  ExecutionId,
  InboxEntry,
  ProjectId,
  Verification,
  VerificationId,
  VerificationVerdict,
  Work,
  WorkId,
} from "@arbor/domain";
import type { RetryVerificationUnboundLegacyInboxProjection } from "@arbor/ports";

// --- P10 `05` §1 shared wire-core restatements --------------------------
//
// The frozen api-contracts response cores the per-view derives share
// (projection-runtime depends on domain + ports only, so the cores are
// restated verbatim here and asserted structurally in the suites).

export interface ExecutionSummaryView {
  readonly executionId: ExecutionId;
  readonly admittedAt: string;
  readonly sandboxPolicy?: {
    readonly policyRevision: number;
    readonly profile: "ReadOnly" | "WorkspaceWrite" | "FullAccess";
    readonly providerId: string;
    readonly networkMode: "Disabled" | "Restricted" | "Enabled";
    readonly status: "Configured" | "Unavailable";
    readonly expiresAt: string;
  };
}

/** Mirrors CurrentWorkSummary (P10 `05` §1). */
export interface CurrentWorkSummaryView {
  readonly workId?: WorkId | undefined;
  readonly objective: string;
  readonly status: Work["lifecycle"];
  readonly revision: Work["revision"];
  readonly activeExecution?: ExecutionSummaryView | undefined;
}

export interface PendingWorkRefView {
  readonly workId: WorkId;
  readonly objective: string;
}

export interface InboxUnconsumedEntryView {
  readonly entryKey: string;
  readonly kind: InboxEntry["kind"];
  readonly summary: string;
  readonly watermark: number;
  readonly target?:
    | ExecutableApprovalInboxTargetView
    | RetryVerificationUnboundLegacyInboxTargetView
    | undefined;
}

export interface RetryVerificationUnboundLegacyInboxTargetView {
  readonly kind: "RetryVerificationUnboundLegacy";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly sourceWorkId: WorkId;
  readonly sourceVerificationId: VerificationId;
  readonly disposition: "UnboundLegacy";
  readonly reasonCode: "OriginEvidenceIncomplete";
  readonly createdAt: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export const retryVerificationUnboundLegacyTargetView = (
  projection: RetryVerificationUnboundLegacyInboxProjection,
): RetryVerificationUnboundLegacyInboxTargetView => ({
  kind: "RetryVerificationUnboundLegacy",
  commandId: projection.commandId,
  projectId: projection.projectId,
  sourceWorkId: projection.sourceWorkId,
  sourceVerificationId: projection.sourceVerificationId,
  disposition: projection.disposition,
  reasonCode: projection.reasonCode,
  createdAt: projection.createdAt,
  revision: projection.revision,
  updatedAt: projection.updatedAt,
});

/** Mirrors the frozen api-contracts Executable approval Inbox target. */
export interface ExecutableApprovalInboxTargetView {
  readonly kind: "ExecutableApproval";
  readonly approvalId: string;
  readonly revision: number;
  readonly executionId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly validatedArgumentsPreview: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly sideEffectSemantics:
    | "ReadOnly"
    | "Idempotent"
    | "Reconcilable"
    | "NonIdempotent";
  readonly expiresAt: string;
  readonly actionDigest: string;
}

/** Mirrors DependencyRow (P10 `05` §1). */
export interface DependencyRowView {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly binding: Dependency["producerBinding"];
  readonly state: Dependency["state"];
  readonly satisfiedBy?: DeliverableId | undefined;
}

export interface AuditTimelineEntryView {
  readonly sequence: number;
  readonly eventType: EventTypeName;
  readonly at: string;
}

export interface CriterionResultView {
  readonly criterionId: string;
  readonly requirement: string;
  readonly required: boolean;
  readonly verdict: VerificationVerdict;
}

export interface AcceptanceViewView {
  readonly acceptanceId: AcceptanceId;
  readonly actor: Actor;
  readonly acceptedAt: string;
}

/** A verification identity is emitted as an inseparable server-derived pair.
 * This keeps optional empty views compatible while preventing a projection
 * from independently manufacturing either frozen identity component. */
export type VerificationIdentityView =
  | {
      readonly verificationId: VerificationId;
      readonly targetWorkRevision: Verification["targetWorkRevision"];
    }
  | {
      readonly verificationId?: undefined;
      readonly targetWorkRevision?: undefined;
    };

export const verificationIdentityView = (
  verification:
    | Pick<Verification, "verificationId" | "targetWorkRevision">
    | undefined,
): VerificationIdentityView =>
  verification === undefined
    ? {}
    : {
        verificationId: verification.verificationId,
        targetWorkRevision: verification.targetWorkRevision,
      };

/** Mirrors the public VerificationView (P10 `05` §1), including its
 * inseparable selected identity pair. */
export type VerificationViewView = VerificationIdentityView & {
  readonly verdict?: VerificationVerdict | undefined;
  readonly criteriaResults: ReadonlyArray<CriterionResultView>;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
  readonly acceptance?: AcceptanceViewView | undefined;
};
