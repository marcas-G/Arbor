import type { DecisionId, WorkId, WorkspaceId } from "./ids.js";

export interface WorkSelectionDecisionRequest {
  readonly decisionId: DecisionId;
  readonly workspaceId: WorkspaceId;
  readonly candidateWorkIds: ReadonlyArray<WorkId>;
  readonly workspaceRevision: number;
  readonly state:
    | { readonly _tag: "Pending" }
    | { readonly _tag: "Submitted"; readonly selectedWorkId: WorkId };
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
