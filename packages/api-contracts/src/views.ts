import type {
  AcceptanceId,
  Actor,
  DeliverableId,
  DependencyId,
  DependencyLifecycle,
  EventTypeName,
  EvidenceId,
  ExecutionId,
  InboxEntry,
  ProducerBinding,
  ProjectId,
  ResourceBoundary,
  ResponsibilityDefinition,
  SessionId,
  VerificationId,
  VerificationVerdict,
  WorkId,
  WorkLifecycle,
  WorkspaceId,
  WorkspaceStatusLabel,
} from "@arbor/domain";

// --- shared cores (P10 `05` §1 frozen shapes; rendering detail is P12) ---

export interface ExecutionSummary {
  readonly executionId: ExecutionId;
  readonly admittedAt: string;
}

export interface CurrentWorkSummary {
  readonly workId?: WorkId | undefined;
  readonly objective: string;
  readonly status: WorkLifecycle;
  readonly activeExecution?: ExecutionSummary | undefined;
}

/** Subtree attention bubbling — aggregated deduplicated fact counts by
 * severity over descendants (P10 `02` §2). */
export interface SubtreeAttention {
  readonly attention: number;
  readonly actionRequired: number;
}

export interface UsageSummary {
  readonly tokens: number;
  readonly cost: number;
  readonly turns: number;
}

/** The six frozen attention fact sources (P10 `02` §1). */
export type AttentionSource =
  | "DependencyUnfulfillable"
  | "Deadlock"
  | "RuntimeSafetyEnvelope"
  | "RecoveryEscalation"
  | "VerifierOrphan"
  | "VacantProducer";

export const ATTENTION_SOURCES: ReadonlyArray<AttentionSource> = [
  "DependencyUnfulfillable",
  "Deadlock",
  "RuntimeSafetyEnvelope",
  "RecoveryEscalation",
  "VerifierOrphan",
  "VacantProducer",
];

/** SD §12.3 severities; Normal is the absence of facts, never a row. */
export type AttentionSeverity = "Attention" | "ActionRequired";

export type InboxEntryKind = InboxEntry["kind"];

export interface InboxUnconsumedEntry {
  readonly entryKey: string;
  readonly kind: InboxEntryKind;
  readonly summary: string;
  readonly watermark: number;
}

export interface PendingWorkRef {
  readonly workId: WorkId;
  readonly objective: string;
}

export interface AuditTimelineEntry {
  readonly sequence: number;
  readonly eventType: EventTypeName;
  readonly at: string;
}

export interface CriterionResult {
  readonly criterionId: string;
  readonly requirement: string;
  readonly required: boolean;
  readonly verdict: VerificationVerdict;
}

export interface AcceptanceView {
  readonly acceptanceId: AcceptanceId;
  readonly actor: Actor;
  readonly acceptedAt: string;
}

export interface VerificationView {
  readonly verificationId?: VerificationId | undefined;
  readonly verdict?: VerificationVerdict | undefined;
  readonly criteriaResults: ReadonlyArray<CriterionResult>;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
  readonly acceptance?: AcceptanceView | undefined;
}

export interface DependencyRow {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly binding: ProducerBinding;
  readonly state: DependencyLifecycle;
  readonly satisfiedBy?: DeliverableId | undefined;
}

// --- per-view request/response cores (P10 `05` §1, frozen) ---

export interface TreeViewReq {
  readonly projectId: ProjectId;
  readonly depth?: number | undefined;
}

export interface TreeViewNode {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly status: WorkspaceStatusLabel;
  readonly currentWork?: CurrentWorkSummary | undefined;
  readonly subtreeAttention: SubtreeAttention;
  readonly usageSummary?: UsageSummary | undefined;
}

export interface TreeViewRes {
  readonly nodes: ReadonlyArray<TreeViewNode>;
}

export interface AttentionReq {
  readonly projectId: ProjectId;
}

export interface AttentionRow {
  readonly source: AttentionSource;
  readonly severity: AttentionSeverity;
  readonly targetWorkspaceId: WorkspaceId;
  readonly dedupKey: string;
  readonly summaryRef: string;
  readonly occurredAt: string;
}

export interface AttentionRes {
  readonly rows: ReadonlyArray<AttentionRow>;
}

export interface WorkspaceDetailReq {
  readonly workspaceId: WorkspaceId;
}

export interface WorkspaceDetailRes {
  readonly responsibility: ResponsibilityDefinition;
  readonly boundary: ResourceBoundary;
  readonly currentWork?: CurrentWorkSummary | undefined;
  readonly pendingWorks: ReadonlyArray<PendingWorkRef>;
  readonly executionSummary?: ExecutionSummary | undefined;
  readonly dependencies: ReadonlyArray<DependencyRow>;
  readonly inboxUnconsumed: ReadonlyArray<InboxUnconsumedEntry>;
  readonly verification?: VerificationView | undefined;
  readonly auditTimeline: ReadonlyArray<AuditTimelineEntry>;
}

export interface CurrentWorkReq {
  readonly workspaceId: WorkspaceId;
}

export type CurrentWorkRes = CurrentWorkSummary | null;

export interface VerificationReq {
  readonly workId: WorkId;
}

export type VerificationRes = VerificationView;

export type DependencyReq =
  | { readonly projectId: ProjectId; readonly workspaceId?: undefined }
  | { readonly projectId?: undefined; readonly workspaceId: WorkspaceId };

export interface DependencyRes {
  readonly rows: ReadonlyArray<DependencyRow>;
}

export interface TranscriptReq {
  readonly workspaceId: WorkspaceId;
  readonly sessionId?: SessionId | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface TranscriptEntry {
  readonly kind: string;
  readonly summaryRef: string;
  readonly at: string;
}

export interface TranscriptRes {
  readonly entries: ReadonlyArray<TranscriptEntry>;
  readonly nextCursor?: string | undefined;
}

export type UsageGroupBy = "workspace" | "subtree" | "project";

export interface UsageReq {
  readonly projectId: ProjectId;
  readonly groupBy: UsageGroupBy;
}

export interface UsageRow {
  readonly workspaceId: WorkspaceId;
  readonly tokens: number;
  readonly cost: number;
  readonly turns: number;
}

export interface UsageRes {
  readonly rows: ReadonlyArray<UsageRow>;
}

export interface InboxViewReq {
  readonly workspaceId: WorkspaceId;
}

export interface InboxViewRes {
  readonly unconsumed: ReadonlyArray<InboxUnconsumedEntry>;
}

// --- ViewId ↔ request/response pairing (compile-time exhaustive) ---

export interface ViewRequestMap {
  readonly "responsibility-tree": TreeViewReq;
  readonly attention: AttentionReq;
  readonly "workspace-detail": WorkspaceDetailReq;
  readonly "current-work": CurrentWorkReq;
  readonly verification: VerificationReq;
  readonly "dependency-view": DependencyReq;
  readonly transcript: TranscriptReq;
  readonly usage: UsageReq;
  readonly "inbox-view": InboxViewReq;
}

export interface ViewResponseMap {
  readonly "responsibility-tree": TreeViewRes;
  readonly attention: AttentionRes;
  readonly "workspace-detail": WorkspaceDetailRes;
  readonly "current-work": CurrentWorkRes;
  readonly verification: VerificationRes;
  readonly "dependency-view": DependencyRes;
  readonly transcript: TranscriptRes;
  readonly usage: UsageRes;
  readonly "inbox-view": InboxViewRes;
}
