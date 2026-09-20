import type { DomainError, WorkspaceId } from "@arbor/domain";

export type CommandRejection =
  | DomainError
  | { readonly _tag: "FencingRejected" }
  | { readonly _tag: "ExecutionStopping" }
  | {
      readonly _tag: "WorkspaceNotFound";
      readonly workspaceId: WorkspaceId;
    };
