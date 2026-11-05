import type {
  ExecutionId,
  ProjectId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";

/** Immutable causal owner for a typed Session timeline item. */
export interface SessionCausalBinding {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId | null;
  readonly executionId: ExecutionId;
  readonly episodeBinding: string;
  readonly causedByRef: string | null;
}

export const sessionCausalBindingForWork = (input: {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly executionId: ExecutionId;
  readonly causedByRef?: string | null;
}): SessionCausalBinding => ({
  projectId: input.projectId,
  workspaceId: input.workspaceId,
  workId: input.workId,
  executionId: input.executionId,
  episodeBinding: "WorkEpisode",
  causedByRef: input.causedByRef ?? null,
});
