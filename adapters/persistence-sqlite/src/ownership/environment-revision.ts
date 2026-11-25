import {
  Clock,
  EnvironmentRevisionStore,
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
  Layer,
  Option,
} from "effect";
import {
  SqlClient,
} from "effect/unstable/sql/SqlClient";
import type {
  SqlError,
} from "effect/unstable/sql/SqlError";
import {
  repositoryFailure,
} from "../repository-error.js";

export const EnvironmentRevisionStoreLive: Layer.Layer<
  EnvironmentRevisionStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  EnvironmentRevisionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure(
      "EnvironmentRevisionStore",
      "environment-revision",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return EnvironmentRevisionStore.of({
      current: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ revision: string | null }>(
              "SELECT revision FROM environment_revisions WHERE project_id = ?",
              [projectId],
            ),
          );
          const revision = rows[0]?.revision;
          return revision === undefined || revision === null
            ? Option.none()
            : Option.some(revision);
        }),
      record: (projectId, revision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at",
              [projectId, revision, now],
            ),
          );
        }),
      // P11 `01` §2 (P1-DG-08): first successful ownership write records the
      // initial anchor "1"; no event, no wake. No-op afterwards.
      lazyInitAnchor: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', ?) ON CONFLICT(project_id) DO NOTHING",
              [projectId, now],
            ),
          );
        }),
      // P12 `05` §5.1 (TR-1): `advanceAnchor` is no longer on the public
      // `EnvironmentRevisionStore` port. CAS successor advancement is the
      // internal, non-exported `EnvironmentRevisionAdvancement` capability
      // (see `environment-advancement.ts`); the governed
      // `RecordEnvironmentChange` command path is the sole production
      // advancement authority (CI-1).
    });
  }),
);

