import type { ProjectId } from "@arbor/domain";
import type {
  AttentionProjectionStoreError,
  AttentionProjectionStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  WorkspaceResourceActivationStoreError,
  WorkspaceResourceActivationStoreService,
} from "@arbor/ports";
import { Effect } from "effect";

export interface ActivationAttentionReconciliationDeps {
  readonly transactions: Pick<TransactionPortService, "transact">;
  readonly activationIntents: Pick<
    WorkspaceResourceActivationStoreService,
    "listAll"
  >;
  readonly attentionProjection: Pick<
    AttentionProjectionStoreService,
    "reconcileWorkspaceResourceActivation"
  >;
}

export type ActivationAttentionReconciliationError =
  | TransactionOperationalFailure
  | WorkspaceResourceActivationStoreError
  | AttentionProjectionStoreError;

/** P10 source-only repair. It owns one TransactionPort boundary, reads the
 * current P1 intent table, and replaces only the Activation Attention source.
 * It never observes or mutates a P1 consumer offset. */
export const reconcileProjectActivationAttention = (
  deps: ActivationAttentionReconciliationDeps,
  projectId: ProjectId,
): Effect.Effect<void, ActivationAttentionReconciliationError> =>
  deps.transactions.transact(
    Effect.gen(function* () {
      const intents = yield* deps.activationIntents.listAll();
      yield* deps.attentionProjection.reconcileWorkspaceResourceActivation(
        projectId,
        intents,
      );
    }),
  );
