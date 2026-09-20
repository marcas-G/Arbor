import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P1_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistryLive,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandReceipt,
  type CommandSubmissionContext,
  type DomainResult,
  err,
  ok,
  Principal,
  ProjectId,
  parse,
} from "../packages/domain/src/index.js";
import {
  type TransactionOperationalFailure,
  TransactionPort,
  TransactionScope,
} from "../packages/ports/src/index.js";

const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const context: CommandSubmissionContext = {
  _tag: "External",
  principal: parse(Principal)("user:test"),
};

const envelope = (payload: unknown): GatewayEnvelope<unknown> => ({
  commandType: "TestCommand",
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const authorityFor = (payload: unknown): VerifiedCommandAuthority => ({
  _tag: "CreateProjectAuthority",
  principal: parse(Principal)("user:test"),
  commandId,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType: "TestCommand",
    projectId,
    actor,
    schemaVersion: "1",
    payload,
  }),
  projectId,
});

const buildApp = (
  behaviour: (payload: unknown) => DomainResult<{
    result: unknown;
    events: ReadonlyArray<never>;
  }>,
  onExecute: () => void,
  filename: string,
  transaction?: Layer.Layer<TransactionPort, never, SqlClient>,
) => {
  const handler: CommandHandler<unknown, unknown> = {
    commandType: "TestCommand",
    schemaVersion: "1",
    authority: { tag: "CreateProjectAuthority", targetMatches: () => true },
    execute: (env) =>
      Effect.sync(() => {
        onExecute();
        return behaviour(env.payload);
      }),
  };
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const transactionLayer =
    transaction === undefined
      ? Layer.provide(TransactionPortLive, infra)
      : Layer.provide(transaction, infra);
  const deps = Layer.mergeAll(
    transactionLayer,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    CommandHandlerRegistryLive([handler]),
    FenceStopCheckInertLive,
  );
  const all = Layer.mergeAll(infra, deps);
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<CommandGateway | SqlClient>;
};

const flakyTransaction = (): Layer.Layer<TransactionPort, never, SqlClient> =>
  Layer.effect(
    TransactionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = (statement: string) =>
        sql.unsafe(statement).pipe(
          Effect.mapError((cause) => ({
            _tag: "TransactionOperationalFailure" as const,
            cause,
          })),
        );
      let calls = 0;
      const transact = <A, E, R>(
        body: Effect.Effect<A, E, R | TransactionScope>,
      ): Effect.Effect<
        A,
        E | TransactionOperationalFailure,
        Exclude<R, TransactionScope>
      > =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            return yield* Effect.fail<TransactionOperationalFailure>({
              _tag: "TransactionOperationalFailure",
              cause: "busy",
            });
          }
          yield* run("BEGIN IMMEDIATE");
          const exit = yield* Effect.exit(
            Effect.provideService(body, TransactionScope, {
              session: { id: "sqlite" },
            }),
          );
          if (Exit.isSuccess(exit)) {
            yield* run("COMMIT");
            return exit.value;
          }
          yield* run("ROLLBACK");
          return yield* Effect.failCause(exit.cause);
        });
      return TransactionPort.of({ transact });
    }),
  );

const setup = Effect.gen(function* () {
  yield* runMigrations(P1_MIGRATIONS);
});

const commandCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
    [commandId],
  );
  return Number(rows[0]?.count ?? 0);
});

const runGateway = <A>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

describe("P1 idempotency / replay / concurrency", () => {
  it("replays the existing committed receipt without re-executing", async () => {
    let executions = 0;
    const app = buildApp(
      () => ok({ result: { ok: true }, events: [] }),
      () => {
        executions += 1;
      },
      ":memory:",
    );
    const program = Effect.gen(function* () {
      yield* setup;
      const gw = yield* CommandGateway;
      const first = yield* gw.execute(
        envelope({ x: 1 }),
        context,
        authorityFor({ x: 1 }),
      );
      const second = yield* gw.execute(
        envelope({ x: 1 }),
        context,
        authorityFor({ x: 1 }),
      );
      const count = yield* commandCount;
      return { first, second, count };
    });
    const { first, second, count } = await runGateway(program, app);
    expect(first.resolution._tag).toBe("Committed");
    expect(second.resolution._tag).toBe("Committed");
    expect(second.semanticRequestFingerprint).toBe(
      first.semanticRequestFingerprint,
    );
    expect(count).toBe(1);
    expect(executions).toBe(1);
  });

  it("replays a terminal rejection without re-executing", async () => {
    let executions = 0;
    const app = buildApp(
      () => err({ _tag: "AuthorityDenied", reason: "no authority" }),
      () => {
        executions += 1;
      },
      ":memory:",
    );
    const program = Effect.gen(function* () {
      yield* setup;
      const gw = yield* CommandGateway;
      const first = yield* gw.execute(
        envelope({ x: 1 }),
        context,
        authorityFor({ x: 1 }),
      );
      const second = yield* gw.execute(
        envelope({ x: 1 }),
        context,
        authorityFor({ x: 1 }),
      );
      return { first, second };
    });
    const { first, second } = await runGateway(program, app);
    expect(first.resolution._tag).toBe("TerminalRejected");
    expect(second.resolution._tag).toBe("TerminalRejected");
    expect(executions).toBe(1);
  });

  it("returns IdempotencyConflict on a different fingerprint without re-executing", async () => {
    let executions = 0;
    const app = buildApp(
      () => ok({ result: { ok: true }, events: [] }),
      () => {
        executions += 1;
      },
      ":memory:",
    );
    const program = Effect.gen(function* () {
      yield* setup;
      const gw = yield* CommandGateway;
      yield* gw.execute(envelope({ x: 1 }), context, authorityFor({ x: 1 }));
      const conflict = yield* gw.execute(
        envelope({ x: 2 }),
        context,
        authorityFor({ x: 2 }),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ result_json: string | null }>(
        "SELECT result_json FROM commands WHERE command_id = ?",
        [commandId],
      );
      return { conflict, rows };
    });
    const { conflict, rows } = await runGateway(program, app);
    expect(conflict.resolution._tag).toBe("TerminalRejected");
    if (conflict.resolution._tag === "TerminalRejected") {
      expect(conflict.resolution.error._tag).toBe("IdempotencyConflict");
    }
    expect(executions).toBe(1);
    expect(rows[0]?.result_json).not.toBeNull();
  });

  it("yields one authoritative resolution under concurrent duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-idem-"));
    const filename = join(dir, "idem.db");
    const app = buildApp(
      () => ok({ result: { ok: true }, events: [] }),
      () => {},
      filename,
    );
    const program = Effect.gen(function* () {
      yield* setup;
      const gw = yield* CommandGateway;
      const receipts = yield* Effect.all(
        [
          gw.execute(envelope({ x: 1 }), context, authorityFor({ x: 1 })),
          gw.execute(envelope({ x: 1 }), context, authorityFor({ x: 1 })),
        ],
        { concurrency: 2 },
      );
      const count = yield* commandCount;
      return { receipts, count };
    });
    const { receipts, count } = await runGateway(program, app);
    expect(count).toBe(1);
    expect(receipts[0]?.resolution._tag).toBe("Committed");
    expect(receipts[1]?.resolution._tag).toBe("Committed");
    expect(receipts[0]?.semanticRequestFingerprint).toBe(
      receipts[1]?.semanticRequestFingerprint,
    );
  });

  it("records a retryable attempt on operational failure, then a new attempt on retry", async () => {
    const app = buildApp(
      () => ok({ result: { ok: true }, events: [] }),
      () => {},
      ":memory:",
      flakyTransaction(),
    );
    const program = Effect.gen(function* () {
      yield* setup;
      const gw = yield* CommandGateway;
      const failure = yield* gw
        .execute(envelope({ x: 1 }), context, authorityFor({ x: 1 }))
        .pipe(Effect.flip);
      const afterFailure = yield* commandCount;
      const retry = yield* gw.execute(
        envelope({ x: 1 }),
        context,
        authorityFor({ x: 1 }),
      );
      const sql = yield* SqlClient;
      const attempts = yield* sql.unsafe<{
        attempt_no: number;
        outcome: string;
      }>(
        "SELECT attempt_no, outcome FROM command_attempts WHERE command_id = ? ORDER BY attempt_no",
        [commandId],
      );
      return { failure, afterFailure, retry, attempts };
    });
    const { failure, afterFailure, retry, attempts } = await runGateway(
      program,
      app,
    );
    expect((failure as { _tag: string })._tag).toBe(
      "TransactionOperationalFailure",
    );
    expect(afterFailure).toBe(0);
    expect(retry.resolution._tag).toBe("Committed");
    expect(attempts.map((row) => row.outcome)).toEqual([
      "RetryableOperationalFailure",
      "Committed",
    ]);
    expect(attempts.map((row) => row.attempt_no)).toEqual([0, 1]);
  });
});
