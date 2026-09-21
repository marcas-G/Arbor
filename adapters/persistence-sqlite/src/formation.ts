import type {
  ChildWorkspaceProposal,
  FormationProposalId,
  FormationProposalRecord,
  WorkspaceId,
} from "@arbor/domain";
import {
  FormationProposalStore,
  type FormationProposalStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ProposalRow {
  readonly proposal_id: string;
  readonly parent_workspace_id: string;
  readonly proposal_json: string;
  readonly revision: number;
  readonly state: string;
}

const toRecord = (row: ProposalRow): FormationProposalRecord => ({
  proposalId: row.proposal_id as FormationProposalId,
  parentWorkspaceId: row.parent_workspace_id as WorkspaceId,
  proposal: JSON.parse(row.proposal_json) as ChildWorkspaceProposal,
  revision: row.revision,
  state: row.state as FormationProposalRecord["state"],
});

/** P6 `01` §4.1/§4.2 (D1). `decideIfPendingRevision` is an L3 CAS: it only
 * advances rows that are still Pending at the exact expected revision. */
export const FormationProposalStoreLive: Layer.Layer<
  FormationProposalStore,
  never,
  SqlClient
> = Layer.effect(
  FormationProposalStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): FormationProposalStoreError => ({
      _tag: "FormationProposalStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return FormationProposalStore.of({
      insert: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = new Date().toISOString();
          yield* run(
            sql.unsafe(
              "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
              [
                record.proposalId,
                record.parentWorkspaceId,
                JSON.stringify(record.proposal),
                record.revision,
                record.state,
                now,
                now,
              ],
            ),
          );
        }),
      findById: (proposalId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ProposalRow>(
              "SELECT proposal_id, parent_workspace_id, proposal_json, revision, state FROM formation_proposals WHERE proposal_id = ?",
              [proposalId],
            ),
          );
          return rows.length > 0
            ? Option.some(toRecord(rows[0] as ProposalRow))
            : Option.none();
        }),
      decideIfPendingRevision: (proposalId, expectedRevision, next) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ proposal_id: string }>(
              "UPDATE formation_proposals SET proposal_json = ?, revision = ?, state = ?, updated_at = ? WHERE proposal_id = ? AND revision = ? AND state = 'Pending' RETURNING proposal_id",
              [
                JSON.stringify(next.proposal),
                next.revision,
                next.state,
                new Date().toISOString(),
                proposalId,
                expectedRevision,
              ],
            ),
          );
          return rows.length === 1 ? Option.some(next) : Option.none();
        }),
    });
  }),
);
