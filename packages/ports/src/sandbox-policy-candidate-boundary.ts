import type {
  CanonicalResourceRegion,
  ProjectId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { ResourceOwnershipClaimRecord } from "./repositories.js";
import type { TransactionScope } from "./session.js";
import type { WorktreeRecord } from "./worktree-store.js";

/** Complete P11 evidence pinned for all candidate profiles in one P10 read. */
export interface SandboxPolicyCandidateBoundarySnapshotV1 {
  readonly workspace: Workspace;
  readonly ownershipClaims: ReadonlyArray<ResourceOwnershipClaimRecord>;
  readonly worktrees: ReadonlyArray<WorktreeRecord>;
  readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
  readonly primaryManagedGitWorktreeRegion: CanonicalResourceRegion;
}

export type SandboxPolicyCandidateBoundaryReadFailureReasonV1 =
  | "WorkspaceMissing"
  | "WorkspaceProjectMismatch"
  | "WorkspaceInactive"
  | "ResponsibilityRevisionMismatch"
  | "ResourceBoundaryInvalid"
  | "OwnershipSourceUnavailable"
  | "WorktreeSourceUnavailable"
  | "EnvironmentObservationUnavailable"
  | "EnvironmentObservationInconsistent"
  | "PrimaryWorktreeMissingOrAmbiguous"
  | "PrimaryWorktreeForeignOrStale"
  | "PrimaryWorktreeNotInBoundary"
  | "PrimaryWorktreeNotResolvedAsGitWorktree";

export interface SandboxPolicyCandidateBoundaryReadFailureV1 {
  readonly _tag: "SandboxPolicyCandidateBoundaryReadFailure";
  readonly reason: SandboxPolicyCandidateBoundaryReadFailureReasonV1;
}

export interface SandboxPolicyCandidateBoundaryReadPortService {
  readonly readCurrentForWorkspace: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
  }) => Effect.Effect<
    SandboxPolicyCandidateBoundarySnapshotV1,
    SandboxPolicyCandidateBoundaryReadFailureV1,
    TransactionScope
  >;
}

export class SandboxPolicyCandidateBoundaryReadPort extends Context.Service<
  SandboxPolicyCandidateBoundaryReadPort,
  SandboxPolicyCandidateBoundaryReadPortService
>()("arbor/SandboxPolicyCandidateBoundaryReadPort") {}
