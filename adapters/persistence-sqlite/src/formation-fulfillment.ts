import type {
  FormationFulfillmentRecord,
  FormationFulfillmentStoreError,
} from "@arbor/ports";
import { FormationFulfillmentStore, TransactionScope } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface Row {
  readonly proposal_id: string;
  readonly proposal_revision: number;
  readonly expected_child_workspace_id: string;
  readonly expected_initial_work_id: string | null;
  readonly state: FormationFulfillmentRecord["state"];
  readonly typed_block: string | null;
  readonly last_attempt_at: string | null;
  readonly revision: number;
}

const toRecord = (row: Row): FormationFulfillmentRecord => ({
  proposalId: row.proposal_id as never,
  proposalRevision: row.proposal_revision,
  expectedChildWorkspaceId: row.expected_child_workspace_id as never,
  expectedInitialWorkId: row.expected_initial_work_id as never,
  state: row.state,
  typedBlock: row.typed_block,
  lastAttemptAt: row.last_attempt_at,
  revision: row.revision,
});

export const FormationFulfillmentStoreLive: Layer.Layer<
  FormationFulfillmentStore,
  never,
  SqlClient
> = Layer.effect(
  FormationFulfillmentStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("FormationFulfillmentStore", "sql");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          (cause): FormationFulfillmentStoreError => failure(cause),
        ),
      );
    return FormationFulfillmentStore.of({
      put: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO formation_fulfillments (proposal_id, proposal_revision, expected_child_workspace_id, expected_initial_work_id, state, typed_block, last_attempt_at, revision) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(proposal_id, proposal_revision) DO UPDATE SET expected_child_workspace_id=excluded.expected_child_workspace_id, expected_initial_work_id=excluded.expected_initial_work_id, state=excluded.state, typed_block=excluded.typed_block, last_attempt_at=excluded.last_attempt_at, revision=excluded.revision WHERE formation_fulfillments.revision <= excluded.revision",
              [
                record.proposalId,
                record.proposalRevision,
                record.expectedChildWorkspaceId,
                record.expectedInitialWorkId,
                record.state,
                record.typedBlock,
                record.lastAttemptAt,
                record.revision,
              ],
            ),
          );
        }),
      findByProposal: (proposalId, proposalRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<Row>(
              "SELECT * FROM formation_fulfillments WHERE proposal_id = ? AND proposal_revision = ?",
              [proposalId, proposalRevision],
            ),
          );
          return rows[0] === undefined
            ? Option.none()
            : Option.some(toRecord(rows[0]));
        }),
    });
  }),
);
