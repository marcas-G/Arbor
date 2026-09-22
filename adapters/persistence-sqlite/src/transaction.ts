import {
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const operationalFailure = (
  message: string,
  cause?: unknown,
): TransactionOperationalFailure => ({
  _tag: "TransactionOperationalFailure",
  cause: cause === undefined ? message : { message, cause },
});

export const TransactionPortLive: Layer.Layer<
  TransactionPort,
  never,
  SqlClient
> = Layer.effect(
  TransactionPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const run = (statement: string) =>
      sql
        .unsafe(statement)
        .pipe(Effect.mapError((cause) => operationalFailure(statement, cause)));

    const transact: TransactionPortService["transact"] = <A, E, R>(
      body: Effect.Effect<A, E, R | TransactionScope>,
    ) =>
      Effect.gen(function* () {
        const existing = yield* Effect.serviceOption(TransactionScope);
        if (Option.isSome(existing)) {
          return yield* Effect.fail(
            operationalFailure("nested transaction rejected"),
          );
        }
        yield* run("BEGIN IMMEDIATE");
        const exit = yield* Effect.exit(
          Effect.provideService(body, TransactionScope, {
            session: { id: "sqlite" },
          }),
        );
        if (Exit.isSuccess(exit)) {
          const commitExit = yield* Effect.exit(run("COMMIT"));
          if (Exit.isFailure(commitExit)) {
            // PB1 (P9 `02` §11): COMMIT failure must roll back explicitly —
            // WAL all-or-nothing either way, but the connection never stays
            // inside an open transaction.
            yield* run("ROLLBACK").pipe(Effect.ignore, Effect.orDie);
            return yield* Effect.failCause(commitExit.cause).pipe(
              Effect.mapError(
                (cause): TransactionOperationalFailure => ({
                  _tag: "TransactionOperationalFailure",
                  cause,
                }),
              ),
            );
          }
          return exit.value;
        }
        yield* run("ROLLBACK");
        return yield* Effect.failCause(exit.cause);
      });

    return TransactionPort.of({ transact });
  }),
);
