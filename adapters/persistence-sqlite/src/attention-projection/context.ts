import type { AttentionProjectionStoreError } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "../repository-error.js";
import type { AttentionProjectionQualificationProbe } from "./row-codecs.js";

export const makeProjectionContext = (
  qualificationProbe?: AttentionProjectionQualificationProbe,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("AttentionProjectionStore", "rows");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const submittedDecisionBindingMarkerAvailable = () =>
      run(
        sql.unsafe<{ readonly name: string }>(
          `SELECT name FROM sqlite_master
              WHERE type = 'table'
                AND name = 'submitted_decision_binding_attention_rows'`,
        ),
      );
    const requireSubmittedDecisionBindingMarker = () =>
      Effect.gen(function* () {
        const tables = yield* submittedDecisionBindingMarkerAvailable();
        if (tables.length === 0) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceUnavailable",
            repository: "AttentionProjectionStore",
            operation: "submitted-decision-binding-marker",
            retryDisposition: "non-retryable",
            sourceTag: "P41MigrationNotRegistered",
            cause: { _tag: "P41MigrationNotRegistered" },
          });
        }
      });
    const requireLegacyAdoptionMarker = () =>
      Effect.gen(function* () {
        const tables = yield* run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
                WHERE type='table' AND name='legacy_adoption_attention_rows'`,
          ),
        );
        if (tables.length === 0) {
          return yield* Effect.fail<AttentionProjectionStoreError>({
            _tag: "PersistenceUnavailable",
            repository: "AttentionProjectionStore",
            operation: "legacy-adoption-attention",
            retryDisposition: "non-retryable",
            sourceTag: "P47MigrationNotRegistered",
            cause: { _tag: "P47MigrationNotRegistered" },
          });
        }
      });
    return {
      sql,
      run,
      qualificationProbe,
      submittedDecisionBindingMarkerAvailable,
      requireSubmittedDecisionBindingMarker,
      requireLegacyAdoptionMarker,
    };
  });

export type ProjectionContext = Effect.Success<
  ReturnType<typeof makeProjectionContext>
>;
