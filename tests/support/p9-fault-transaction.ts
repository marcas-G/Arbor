import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
} from "../../packages/ports/src/index.js";

/**
 * P9 `02` §0/§11 (P9-001): transaction-port fault modes — the
 * envelope-internal crash-injected subclass (GQ5). Real injections only:
 * begin/commit failure and mid-body abort; never power/WAL simulation.
 * Shape mirrors the P1 `faultingTransaction` precedent; adds
 * `fail-on-commit` and PB1's explicit rollback-on-commit-failure.
 */
export type FaultMode =
  | "fail-on-begin"
  | "rollback-after-body"
  | "fail-on-commit";

export const faultingTransactionP9 = (
  mode: FaultMode,
  injectOn = 1,
): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError(
            (cause): TransactionOperationalFailure => ({
              _tag: "TransactionOperationalFailure",
              cause,
            }),
          ),
        );
      const operational: TransactionOperationalFailure = {
        _tag: "TransactionOperationalFailure",
        cause: `injected:${mode}`,
      };
      let calls = 0;
      const transact: TransactionPortService["transact"] = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ) =>
        Effect.gen(function* () {
          calls += 1;
          const injected = calls === injectOn;
          if (injected && mode === "fail-on-begin") {
            return yield* Effect.fail(operational);
          }
          const existing = yield* Effect.serviceOption(TransactionScope);
          if (Option.isSome(existing)) {
            return yield* Effect.fail({
              _tag: "TransactionOperationalFailure",
              cause: "nested transaction rejected",
            } satisfies TransactionOperationalFailure);
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isSuccess(exit)) {
            if (
              injected &&
              (mode === "rollback-after-body" || mode === "fail-on-commit")
            ) {
              yield* run("ROLLBACK");
              return yield* Effect.fail(operational);
            }
            const commitExit = yield* Effect.exit(run("COMMIT"));
            if (Exit.isFailure(commitExit)) {
              // PB1: explicit rollback on COMMIT failure.
              yield* run("ROLLBACK").pipe(Effect.ignore, Effect.orDie);
              return yield* Effect.fail(operationalFrom(commitExit.cause));
            }
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact });
    }),
  );

const operationalFrom = (cause: unknown): TransactionOperationalFailure => ({
  _tag: "TransactionOperationalFailure",
  cause,
});
