import type {
  AcceptanceId,
  Actor,
  DeliverableId,
  Dependency,
  DependencyId,
  EventTypeName,
  EvidenceId,
  ExecutionId,
  InboxEntry,
  VerificationId,
  VerificationVerdict,
  Work,
  WorkId,
} from "@arbor/domain";

// --- P10 `05` §1 shared wire-core restatements --------------------------
//
// The frozen api-contracts response cores the per-view derives share
// (projection-runtime depends on domain + ports only, so the cores are
// restated verbatim here and asserted structurally in the suites).

export interface ExecutionSummaryView {
  readonly executionId: ExecutionId;
  readonly admittedAt: string;
}

/** Mirrors CurrentWorkSummary (P10 `05` §1). */
export interface CurrentWorkSummaryView {
  readonly workId?: WorkId | undefined;
  readonly objective: string;
  readonly status: Work["lifecycle"];
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

/** Mirrors VerificationView (P10 `05` §1). */
export interface VerificationViewView {
  readonly verificationId?: VerificationId | undefined;
  readonly verdict?: VerificationVerdict | undefined;
  readonly criteriaResults: ReadonlyArray<CriterionResultView>;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
  readonly acceptance?: AcceptanceViewView | undefined;
}
