import type {
  ExecutionEpisodeBinding,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  Sha256,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { encodeExecutionEpisodeBinding } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { TransactionScope } from "./session.js";
import type { ToolObservationEvidenceStoreError } from "./tool-observation-evidence.js";

/** Verified, read-only evidence that an exact active P3 action requires a
 * sandbox policy before effect admission. No P3/P4 state is created here. */
export interface SandboxPolicyRequirementV1 {
  readonly _tag: "SandboxPolicyRequirementV1";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly invocationId: ToolInvocationId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: string;
  readonly recoveryBindingDigest: Sha256;
}

/** Read-only proof for a P3 Executable Action whose exact P4 approval is
 * Pending, before P4 has admitted a ToolInvocation or RecoveryBinding. */
export interface SandboxPolicyPreIntentRequirementV1 {
  readonly _tag: "SandboxPolicyPreIntentRequirementV1";
  readonly version: 1;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: string;
  readonly actionRevision: number;
  readonly inputHash: Sha256;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly approvalId: string;
  readonly approvalState: "Pending";
  readonly approvalRevision: number;
  readonly approvalConsumedBy: null;
  readonly approvalExpiresAt: string;
}

export type SandboxPolicyRequirement =
  | SandboxPolicyRequirementV1
  | SandboxPolicyPreIntentRequirementV1;

export type SandboxPolicyPreIntentStaleField =
  | "ActionRevision"
  | "ExecutableApprovalRevision";

/** Structural source proof equality; deliberately not a codec, digest, or
 * request-fingerprint input. */
export const sameSandboxPolicyPreIntentRequirement = (
  left: SandboxPolicyPreIntentRequirementV1,
  right: SandboxPolicyPreIntentRequirementV1,
): boolean =>
  left._tag === right._tag &&
  left.version === right.version &&
  left.projectId === right.projectId &&
  left.workspaceId === right.workspaceId &&
  left.executionId === right.executionId &&
  encodeExecutionEpisodeBinding(left.episodeBinding) ===
    encodeExecutionEpisodeBinding(right.episodeBinding) &&
  left.expectedEpisodeRevision === right.expectedEpisodeRevision &&
  left.providerTurnId === right.providerTurnId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt &&
  left.logicalActionId === right.logicalActionId &&
  left.actionIndex === right.actionIndex &&
  left.callRef === right.callRef &&
  left.actionRevision === right.actionRevision &&
  left.inputHash === right.inputHash &&
  left.toolName === right.toolName &&
  left.toolVersion === right.toolVersion &&
  left.approvalId === right.approvalId &&
  left.approvalState === right.approvalState &&
  left.approvalRevision === right.approvalRevision &&
  left.approvalConsumedBy === right.approvalConsumedBy &&
  left.approvalExpiresAt === right.approvalExpiresAt;

export interface SandboxPolicyRequirementReadPortService {
  readonly findPendingByExecution: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
  }) => Effect.Effect<
    Option.Option<SandboxPolicyRequirement>,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
  /** Transaction-scoped final P1 CAS. Reads action first, then approval, and
   * uses the caller's trusted GatewayNow for expiry even without row drift. */
  readonly comparePreIntentSource: (input: {
    readonly expected: SandboxPolicyPreIntentRequirementV1;
    readonly trustedNow: string;
  }) => Effect.Effect<
    SandboxPolicyPreIntentStaleField | undefined,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

export class SandboxPolicyRequirementReadPort extends Context.Service<
  SandboxPolicyRequirementReadPort,
  SandboxPolicyRequirementReadPortService
>()("arbor/SandboxPolicyRequirementReadPort") {}
