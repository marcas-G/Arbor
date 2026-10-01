import type {
  CommandId,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { ReasoningAttachment } from "./provider-extension.js";

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
  readonly state: "Pending" | "Claimed" | "Answered" | "Declined";
  readonly claimedByExecutionId: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  /** Bounded assistant response persisted at settle (P14 `02` §4 "response
   * persisted"); null while unanswered. */
  readonly responseBody: string | null;
  /**
   * Gate C C3: the provider-native reasoning payload attached to this turn's
   * answer (ReasoningAttachment JSON, or null when the deployment produced /
   * preserved none). Conversation-history attachment — the ONLY persistence
   * home for reasoning round-trip state (never the provider transport rows).
   */
  readonly providerReasoning: ReasoningAttachment | null;
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
  /** All messages for a workspace (transcript read model, P14 `03`). */
  readonly listForWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<HumanMessageRecord>,
    HumanMessageStoreError,
    import("./session.js").TransactionScope
  >;
}

export class HumanMessageStore extends Context.Service<
  HumanMessageStore,
  HumanMessageStoreService
>()("arbor/HumanMessageStore") {}
