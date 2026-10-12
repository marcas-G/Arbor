import { Schema } from "effect";
import type {
  ExecutionId,
  ProviderTurnId,
  ToolInvocationId,
  WorkId,
  WorkspaceId,
} from "./ids.js";
import type { WorkRevision } from "./ordinals.js";

/** SHA-256 hex digest used for deterministic, content-derived identities. */
export const Sha256 = Schema.String.pipe(
  Schema.refine((value): value is string => /^[0-9a-f]{64}$/.test(value), {
    message: "expected lowercase SHA-256 hex",
  }),
  Schema.brand("Sha256"),
);
export type Sha256 = Schema.Schema.Type<typeof Sha256>;

/** P4 closed no-effect denial vocabulary. Kept dependency-free so the
 * ExecutionSettlement and P4 port share the same wire/storage values. */
export const NO_EFFECT_DENIAL_CODES = [
  "InvocationAuthorityDenied",
  "ApprovalRequired",
  "ApprovalRejected",
  "ApprovalNotFound",
  "ApprovalMismatch",
  "ApprovalExpired",
  "ApprovalConsumedByOtherInvocation",
  "ResourceResolutionDenied",
  "ResourceAdmissionDenied",
  "ApprovalNoLongerAuthorized",
] as const;
export type NoEffectDenialCode = (typeof NO_EFFECT_DENIAL_CODES)[number];
export type TerminalNoEffectDenialCode = Exclude<
  NoEffectDenialCode,
  "ApprovalRequired"
>;

/** Closed evidence category that can support an exact WorkEpisode Blocked
 * result. Native errors, free-form interruption reasons and Plan text are not
 * denial evidence. */
export type TerminalActionDenial =
  | {
      readonly _tag: "P4NoEffectDenied";
      readonly reasonCode: TerminalNoEffectDenialCode;
    }
  | {
      readonly _tag: "HandlerRejected";
      readonly routeKind: "Executable";
    };

/** P9 AgentLoopStep identity used to prove a terminal denied action without
 * depending on a provider transcript or the local Plan. */
export interface BlockedActionRef {
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly resultRef: string;
  readonly settlementRef: string;
  readonly observationSourceRef: string;
  readonly toolInvocationId?: ToolInvocationId;
  readonly terminalDenial: TerminalActionDenial;
}

export interface WorkBlocker {
  readonly blockerId: Sha256;
  readonly projectId: import("./ids.js").ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly failureFingerprint: Sha256;
  readonly state: "Open" | "Resolved" | "Superseded";
  readonly openCycleId: ExecutionId;
  readonly latestRequestRef: string;
  readonly failedActionRefs: ReadonlyArray<BlockedActionRef>;
  readonly revision: number;
}

/** A current Work revision intentionally invalidates unresolved blockers. */
export interface WorkBlockerTransition {
  readonly blockerId: Sha256;
  readonly workId: WorkId;
  readonly fromWorkRevision: WorkRevision;
  readonly toWorkRevision: WorkRevision;
  readonly changedAt: string;
}
