import {
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Duration, Effect, Exit, Layer, Option, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const operationalFailure = (
  message: string,
  cause?: unknown,
): TransactionOperationalFailure => ({
  _tag: "TransactionOperationalFailure",
  cause: cause === undefined ? message : { message, cause },
});

export type TransactionBeginQualificationProbe = (event: {
  readonly boundary: "BeforeBegin";
}) => Promise<void>;

export const makeTransactionPortLive = (
  qualificationProbe?: TransactionBeginQualificationProbe,
): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const transactionPermit = yield* Semaphore.make(1);

      const run = (statement: string) =>
        sql
          .unsafe(statement)
          .pipe(
            Effect.mapError((cause) => operationalFailure(statement, cause)),
          );

      const isLockTimeout = (cause: unknown): boolean => {
        let current: unknown = cause;
        for (let depth = 0; depth < 8; depth += 1) {
          if (
            typeof current === "object" &&
            current !== null &&
            "_tag" in current &&
            current._tag === "LockTimeoutError"
          ) {
            return true;
          }
          if (
            typeof current !== "object" ||
            current === null ||
            !("cause" in current)
          ) {
            return false;
          }
          current = current.cause;
        }
        return false;
      };

      /**
       * SQLite's busy timeout covers one BEGIN attempt. A second daemon may
       * still be finishing its startup recovery transaction when that
       * timeout expires, so retry only the side-effect-free BEGIN boundary.
       * The transaction body is never replayed by this contention path.
       */
      const begin = (
        remainingAttempts: number,
      ): Effect.Effect<void, TransactionOperationalFailure> =>
        run("BEGIN IMMEDIATE").pipe(
          Effect.catch((cause) => {
            if (!isLockTimeout(cause) || remainingAttempts <= 0) {
              return Effect.fail(cause);
            }
            return Effect.sleep(Duration.millis(100)).pipe(
              Effect.flatMap(() => begin(remainingAttempts - 1)),
            );
          }),
        );

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
          return yield* transactionPermit.withPermits(1)(
            Effect.gen(function* () {
              if (qualificationProbe !== undefined) {
                yield* Effect.promise(async () => {
                  try {
                    await qualificationProbe({ boundary: "BeforeBegin" });
                  } catch {
                    // Qualification observers never alter transaction behavior.
                  }
                });
              }
              // Each attempt already has the configured SQLite busy timeout;
              // the bounded outer retries cover cross-process startup races.
              yield* begin(5);
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
            }),
          );
        });

      return TransactionPort.of({ transact });
    }),
  );

export const TransactionPortLive: Layer.Layer<
  TransactionPort,
  never,
  SqlClient
> = makeTransactionPortLive();
