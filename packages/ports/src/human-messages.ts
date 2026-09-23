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
}

export interface HumanMessageConflict {
  readonly _tag: "HumanMessageConflict";
  readonly existing: HumanMessageRecord;
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
    HumanMessageConflict,
    import("./session.js").TransactionScope
  >;
  readonly findById: (
    messageId: string,
  ) => Effect.Effect<
    Option.Option<HumanMessageRecord>,
    never,
    import("./session.js").TransactionScope
  >;
  /** Oldest-first pending for a project (FIFO claim order, `02` §2). */
  readonly pendingOrderedByCreated: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<HumanMessageRecord>,
    never,
    import("./session.js").TransactionScope
  >;
  /** CAS claim: Pending → Claimed(claimedByExecutionId). */
  readonly claim: (
    messageId: string,
    claimedByExecutionId: string,
  ) => Effect.Effect<
    ClaimOutcome,
    never,
    import("./session.js").TransactionScope
  >;
  /** Settled write-back: Claimed → Answered. */
  readonly markAnswered: (
    messageId: string,
    settledAt: string,
  ) => Effect.Effect<void, never, import("./session.js").TransactionScope>;
  /** Crash recovery: rollback stale claims (no live execution). */
  readonly rollbackClaim: (
    messageId: string,
  ) => Effect.Effect<void, never, import("./session.js").TransactionScope>;
}

export class HumanMessageStore extends Context.Service<
  HumanMessageStore,
  HumanMessageStoreService
>()("arbor/HumanMessageStore") {}
