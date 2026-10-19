import type {
  ExecutionEpisodeBinding,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  Sha256,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
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

export interface SandboxPolicyRequirementReadPortService {
  readonly findPendingByExecution: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
  }) => Effect.Effect<
    Option.Option<SandboxPolicyRequirementV1>,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

export class SandboxPolicyRequirementReadPort extends Context.Service<
  SandboxPolicyRequirementReadPort,
  SandboxPolicyRequirementReadPortService
>()("arbor/SandboxPolicyRequirementReadPort") {}
