import type {
  CommandId,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";

/**
 * P14 `01` §4 — the durable human-message store (chat conversation turns).
 * Durable writes happen inside the command transaction (same tx as the
 * `HumanMessageSubmitted` event append); the P14 conversation trigger
 * consumer is the sole claimer (`02` §2).
 */

export interface HumanMessageRecord {
  readonly messageId: string;
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly humanPrincipal: Principal;
  readonly bodyRef: string;
  readonly commandId: CommandId;
  readonly fingerprint: string;
  readonly state: "Pending" | "Claimed" | "Answered";
  readonly claimedByExecutionId: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  /** Bounded assistant response persisted at settle (P14 `02` §4 "response
   * persisted"); null while unanswered. */
  readonly responseBody: string | null;
  /** retry-until-response attempt counter (`02` §4.2): incremented on each
   * Failed/OutcomeUnknown rollback; admission ids derive from
   * `(messageId, attemptNo)`. */
  readonly attemptNo: number;
}

export interface HumanMessageConflict {
  readonly _tag: "HumanMessageConflict";
  readonly existing: HumanMessageRecord;
}

export interface HumanMessageStoreError {
  readonly _tag: "HumanMessageStoreFailure";
  readonly cause: unknown;
}

export interface ClaimOutcome {
  readonly _tag: "Claimed" | "AlreadyClaimed" | "NotFound";
}

export interface HumanMessageStoreService {
  /** Insert a Pending message; conflict surfaces the existing row so the
   * handler can converge semantic idempotency or reject a fingerprint
   * conflict (P14 `01` §2). */
  readonly insertPending: (
    record: HumanMessageRecord,
  ) => Effect.Effect<
    void,
    HumanMessageConflict | HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  readonly findById: (
    messageId: string,
  ) => Effect.Effect<
    Option.Option<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Oldest-first pending for a project (FIFO claim order, `02` §2). */
  readonly pendingOrderedByCreated: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** CAS claim: Pending → Claimed(claimedByExecutionId). */
  readonly claim: (
    messageId: string,
    claimedByExecutionId: string,
  ) => Effect.Effect<
    ClaimOutcome,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Settled write-back: Claimed → Answered (+ bounded response body). */
  readonly markAnswered: (
    messageId: string,
    settledAt: string,
    responseBody: string | null,
  ) => Effect.Effect<
    void,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** All messages for a workspace (transcript read model, P14 `03`). */
  readonly listForWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Claimed messages for a project (settle sweep, FIFO order). */
  readonly claimedOrderedByCreated: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Settle-side lookup: the message claimed by a coordination execution
   * (P14 `02` §4 write-back). */
  readonly findByClaimedExecution: (
    executionId: string,
  ) => Effect.Effect<
    Option.Option<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Crash recovery: rollback stale claims (no live execution) — the SAME
   * attempt (no progress was made). */
  readonly rollbackClaim: (
    messageId: string,
  ) => Effect.Effect<
    void,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
  /** Unproductive settle (Failed/OutcomeUnknown): rollback AND advance the
   * attempt so the next admission uses fresh derived ids — retry-until-
   * response (`02` §4.2). */
  readonly rollbackForRetry: (
    messageId: string,
  ) => Effect.Effect<
    void,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
}

export class HumanMessageStore extends Context.Service<
  HumanMessageStore,
  HumanMessageStoreService
>()("arbor/HumanMessageStore") {}
