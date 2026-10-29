import type {
  DecisionId,
  WorkId,
  WorkSelectionDecisionRequest,
  WorkspaceId,
} from "@arbor/domain";
import { DecisionRequestStore, TransactionScope } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface DecisionRow {
  readonly decision_id: string;
  readonly workspace_id: string;
  readonly candidate_work_ids_json: string;
  readonly workspace_revision: number;
  readonly state: "Pending" | "Submitted";
  readonly selected_work_id: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const toDecision = (row: DecisionRow): WorkSelectionDecisionRequest => ({
  decisionId: row.decision_id as DecisionId,
  workspaceId: row.workspace_id as WorkspaceId,
  candidateWorkIds: JSON.parse(row.candidate_work_ids_json) as WorkId[],
  workspaceRevision: row.workspace_revision,
  state:
    row.state === "Pending"
      ? { _tag: "Pending" }
      : {
          _tag: "Submitted",
          selectedWorkId: row.selected_work_id as WorkId,
        },
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const DecisionRequestStoreLive: Layer.Layer<
  DecisionRequestStore,
  never,
  SqlClient
> = Layer.effect(
  DecisionRequestStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure(
      "DecisionRequestStore",
      "work-selection-decision",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const find = (clause: string, value: string) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<DecisionRow>(
            `SELECT * FROM work_selection_decision_requests WHERE ${clause} LIMIT 1`,
            [value],
          ),
        );
        return rows[0] === undefined
          ? Option.none()
          : Option.some(toDecision(rows[0]));
      });
    return DecisionRequestStore.of({
      upsertPending: (request) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO work_selection_decision_requests (decision_id, workspace_id, candidate_work_ids_json, workspace_revision, state, selected_work_id, revision, created_at, updated_at) VALUES (?,?,?,?,'Pending',NULL,?,?,?) ON CONFLICT(decision_id) DO NOTHING",
              [
                request.decisionId,
                request.workspaceId,
                JSON.stringify(request.candidateWorkIds),
                request.workspaceRevision,
                request.revision,
                request.createdAt,
                request.updatedAt,
              ],
            ),
          );
        }),
      findById: (decisionId) => find("decision_id = ?", decisionId),
      findPendingByWorkspace: (workspaceId) =>
        find("workspace_id = ? AND state = 'Pending'", workspaceId),
      submit: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ decision_id: string }>(
              "UPDATE work_selection_decision_requests SET state='Submitted', selected_work_id=?, revision=revision+1, updated_at=? WHERE decision_id=? AND revision=? AND state='Pending' RETURNING decision_id",
              [
                input.selectedWorkId,
                input.updatedAt,
                input.decisionId,
                input.expectedRevision,
              ],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail({
              _tag: "DecisionRequestStoreRevisionConflict" as const,
            });
          }
        }),
    });
  }),
);
