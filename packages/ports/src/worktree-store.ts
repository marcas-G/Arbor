import type { ProjectId, ResourceAddress, WorkspaceId } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

/** P11 `09` §2 (UD-1 closure): the frozen additive domain payload. */
export type GitWorktreeAddress = Extract<
  ResourceAddress,
  { readonly _tag: "GitWorktree" }
>;

export type WorktreeState = "Active" | "Retired";

/** P11 `09` §1: worktrees state-table row (`Active → Retired`, terminal). */
export interface WorktreeRecord {
  readonly worktreeId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly address: GitWorktreeAddress;
  readonly state: WorktreeState;
  readonly createdAt: string;
  readonly retiredAt?: string;
}

export type WorktreeStoreError = RepositoryFailure<"WorktreeStore">;

export interface WorktreeStoreService {
  readonly insert: (
    record: WorktreeRecord,
  ) => Effect.Effect<void, WorktreeStoreError, TransactionScope>;
  readonly findById: (
    worktreeId: string,
  ) => Effect.Effect<
    Option.Option<WorktreeRecord>,
    WorktreeStoreError,
    TransactionScope
  >;
  readonly findByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<WorktreeRecord>,
    WorktreeStoreError,
    TransactionScope
  >;
  /** P11 `09` §1: CAS `Active → Retired` (terminal). `None` = no Active row
   * matched (missing or already retired) — callers surface the typed
   * distinction from their own prior `findById`. */
  readonly retireIfActive: (
    worktreeId: string,
    retiredAt: string,
  ) => Effect.Effect<
    Option.Option<WorktreeRecord>,
    WorktreeStoreError,
    TransactionScope
  >;
}

export class WorktreeStore extends Context.Service<
  WorktreeStore,
  WorktreeStoreService
>()("arbor/WorktreeStore") {}
