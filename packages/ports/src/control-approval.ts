import type { ExecutionId, ProjectId, WorkspaceId } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type ControlApprovalState =
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Consumed"
  | "Expired";

export interface ControlApprovalRecord {
  readonly approvalId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly stableActionId: string;
  readonly actionDigest: string;
  readonly argumentsJson: string;
  readonly targetRef: string;
  readonly controlBasisDigest: string;
  readonly state: ControlApprovalState;
  readonly revision: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly consumedAt: string | null;
}

export type ControlApprovalStoreError =
  RepositoryFailure<"ControlApprovalStore">;

export interface ControlApprovalStoreService {
  readonly putPending: (
    record: ControlApprovalRecord,
  ) => Effect.Effect<void, ControlApprovalStoreError, TransactionScope>;
  readonly findById: (
    approvalId: string,
  ) => Effect.Effect<
    Option.Option<ControlApprovalRecord>,
    ControlApprovalStoreError,
    TransactionScope
  >;
  readonly decide: (input: {
    readonly approvalId: string;
    readonly expectedRevision: number;
    readonly decision: "Approve" | "Reject";
    readonly decidedAt: string;
    readonly decidedBy: string;
    readonly reason: string | null;
  }) => Effect.Effect<
    Option.Option<ControlApprovalRecord>,
    ControlApprovalStoreError,
    TransactionScope
  >;
  readonly consumeApproved: (input: {
    readonly approvalId: string;
    readonly expectedRevision: number;
    readonly actionDigest: string;
    readonly controlBasisDigest: string;
    readonly consumedAt: string;
  }) => Effect.Effect<
    Option.Option<ControlApprovalRecord>,
    ControlApprovalStoreError,
    TransactionScope
  >;
  readonly listResolved: () => Effect.Effect<
    ReadonlyArray<ControlApprovalRecord>,
    ControlApprovalStoreError,
    TransactionScope
  >;
  readonly expireDue: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<ControlApprovalRecord>,
    ControlApprovalStoreError,
    TransactionScope
  >;
}

export class ControlApprovalStore extends Context.Service<
  ControlApprovalStore,
  ControlApprovalStoreService
>()("arbor/ControlApprovalStore") {}
