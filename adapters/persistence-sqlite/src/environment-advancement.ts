import type { ProjectId } from "@arbor/domain";
import {
  Clock,
  type EnvironmentRevisionStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * P12 `05` §5.1 (TR-1) — the INTERNAL, non-exported advancement capability.
 *
 * `advanceAnchor` is removed from the public `ports` `EnvironmentRevisionStore`
 * surface (see `packages/ports/src/environment.ts`). Strict-successor CAS
 * advancement lives here, in a module deliberately **not** re-exported from
 * the persistence adapter's `index.ts`, so no observation-side module (drift /
 * staleness / impact / verdict) can import or invoke it. In production the
 * governed `RecordEnvironmentChange` path is the sole advancement authority
 * (CI-1); this capability is the store-level CAS face used by the revision
 * algebra and by persistence-boundary tests.
 *
 * The successor is derived internally — callers cannot request an arbitrary
 * value — and a stale `expected` is a typed conflict (blind advance is
 * structurally impossible).
 */
export interface EnvironmentRevisionAdvancementService {
  readonly advanceAnchor: (
    projectId: ProjectId,
    expected: string,
  ) => Effect.Effect<
    | { readonly _tag: "Advanced"; readonly to: string }
    | { readonly _tag: "AnchorMissing" }
    | { readonly _tag: "RevisionConflict"; readonly current: string },
    EnvironmentRevisionStoreError,
    TransactionScope
  >;
}

export class EnvironmentRevisionAdvancement extends Context.Service<
  EnvironmentRevisionAdvancement,
  EnvironmentRevisionAdvancementService
>()("arbor/EnvironmentRevisionAdvancement") {}

export const EnvironmentRevisionAdvancementLive: Layer.Layer<
  EnvironmentRevisionAdvancement,
  never,
  SqlClient | Clock
> = Layer.effect(
  EnvironmentRevisionAdvancement,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): EnvironmentRevisionStoreError => ({
      _tag: "EnvironmentRevisionStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return EnvironmentRevisionAdvancement.of({
      advanceAnchor: (projectId, expected) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ revision: string | null }>(
              "SELECT revision FROM environment_revisions WHERE project_id = ?",
              [projectId],
            ),
          );
          const current = rows[0]?.revision ?? null;
          if (current === null) {
            return { _tag: "AnchorMissing" as const };
          }
          if (current !== expected) {
            return { _tag: "RevisionConflict" as const, current };
          }
          const to = String(Number(current) + 1);
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "UPDATE environment_revisions SET revision = ?, updated_at = ? WHERE project_id = ? AND revision = ?",
              [to, now, projectId, expected],
            ),
          );
          return { _tag: "Advanced" as const, to };
        }),
    });
  }),
);
