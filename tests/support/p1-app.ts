import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  ProjectRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  FenceStopCheckInertLive,
  P1CommandHandlerRegistryLive,
} from "../../packages/application/src/index.js";

export const makeP1App = (
  filename = ":memory:",
): Layer.Layer<CommandGateway | SqlClient> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    deps,
    FenceStopCheckInertLive,
    Layer.provide(P1CommandHandlerRegistryLive, deps),
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<CommandGateway | SqlClient>;
};

export const runP1 = <A>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> => Effect.runPromise(Effect.provide(program, app));

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const eventTypes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ event_type: string }>(
    "SELECT event_type FROM domain_events ORDER BY sequence",
  );
  return rows.map((row) => row.event_type);
});
