import type {
  DecisionId,
  WorkId,
  WorkSelectionDecisionRequest,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { DecisionRequestStoreError } from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface DecisionRequestStoreService {
  readonly upsertPending: (
    request: WorkSelectionDecisionRequest,
  ) => Effect.Effect<void, DecisionRequestStoreError, TransactionScope>;
  readonly findById: (
    decisionId: DecisionId,
  ) => Effect.Effect<
    Option.Option<WorkSelectionDecisionRequest>,
    DecisionRequestStoreError,
    TransactionScope
  >;
  readonly findPendingByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<WorkSelectionDecisionRequest>,
    DecisionRequestStoreError,
    TransactionScope
  >;
  readonly submit: (input: {
    readonly decisionId: DecisionId;
    readonly expectedRevision: number;
    readonly selectedWorkId: WorkId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, DecisionRequestStoreError, TransactionScope>;
}

export class DecisionRequestStore extends Context.Service<
  DecisionRequestStore,
  DecisionRequestStoreService
>()("arbor/DecisionRequestStore") {}
