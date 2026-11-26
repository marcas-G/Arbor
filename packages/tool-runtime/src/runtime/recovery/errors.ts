import type {
  ArtifactError,
  RepositoryFailure,
  ToolObservationEvidenceStoreError,
  ToolRuntimeError,
  TransactionOperationalFailure,
} from "@arbor/ports";
import { operationalFailure } from "../errors.js";

/** E09: the recovery phases keep their settlement-persistence failures
 * typed instead of folding every infrastructure error into
 * `cause: unknown` at each transaction call site. `ToolRuntimeError`
 * members are failures a phase already owns in final form (semantic
 * binding mismatches, replay escalation, ownership-loss fencing, the
 * retry gate's fenced admission); the remaining members are the port
 * failures that flow out of the reconciliation fact-persistence and
 * artifact transactions. Each still-typed member folds into
 * `ToolRuntimeOperationalFailure` exactly once, at the recovery boundary
 * in the runtime's invoke pipeline. */
export type ToolRuntimeRecoveryError =
  | ToolRuntimeError
  | ToolObservationEvidenceStoreError
  | RepositoryFailure<"ToolReconciliationFactStore">
  | ArtifactError
  | TransactionOperationalFailure;

/** The single fold for the admitted-reconciliation phase's still-typed
 * port failures. Failures already carrying a final `ToolRuntimeError`
 * tag pass through unchanged — the phase's own semantic failures and the
 * retry gate's fold are never re-wrapped. Everything still typed —
 * including a raw fencing rejection that escaped a reconciliation
 * transaction — takes the SettlementJournal stage, exactly as the
 * per-transaction folds it replaces did. */
export const foldAdmittedReconciliationError =
  (invocationRef: string) =>
  (cause: ToolRuntimeRecoveryError): ToolRuntimeError =>
    cause._tag === "ToolRuntimeOperationalFailure" ||
    cause._tag === "ToolRuntimeCleanupFailure" ||
    cause._tag === "ToolObservationRecoveryBlocked"
      ? cause
      : operationalFailure("SettlementJournal", invocationRef)(cause);

/** The single fold for the prior-settlement phase's still-typed port
 * failures. A raw fencing rejection may already be flowing in final
 * `ToolRuntimeError` form from the replay path, so it passes through
 * unwrapped; every still-typed settlement-persistence failure takes the
 * SettlementJournal stage. */
export const foldPriorSettlementError =
  (invocationRef: string) =>
  (cause: ToolRuntimeRecoveryError): ToolRuntimeError =>
    cause._tag === "ToolRuntimeOperationalFailure" ||
    cause._tag === "ToolRuntimeCleanupFailure" ||
    cause._tag === "ToolObservationRecoveryBlocked" ||
    cause._tag === "LeaseFencingRejected"
      ? cause
      : operationalFailure("SettlementJournal", invocationRef)(cause);
