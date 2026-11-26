import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  ExecutableApprovalStoreLive,
  InboxProjectionStoreLive,
  layer,
  P38_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  ExecutableApprovalStore,
  IdGenerator,
  TransactionPort,
} from "../../../packages/ports/src/index.js";

describe("EA-DG-01 SQLite approval store", () => {
  it("reads an exact logical-action approval from the cumulative P38 schema", async () => {
    const db = layer({ filename: ":memory:" });
    const ids = Layer.succeed(IdGenerator, {
      generate: <T>(_kind: string) => Effect.succeed("id_test" as T),
    });
    const inbox = Layer.provide(InboxProjectionStoreLive, db);
    const journal = Layer.provide(
      DomainEventJournalLive,
      Layer.mergeAll(db, ids),
    );
    const approvalStore = Layer.provide(
      ExecutableApprovalStoreLive,
      Layer.mergeAll(db, ids, inbox, journal),
    );
    const app = Layer.mergeAll(
      db,
      ids,
      inbox,
      journal,
      approvalStore,
      Layer.provide(TransactionPortLive, db),
    );

    const program = Effect.gen(function* () {
      yield* runMigrations(P38_MIGRATIONS);
      const tx = yield* TransactionPort;
      const approvals = yield* ExecutableApprovalStore;
      return yield* tx.transact(
        approvals.findByActionKey({
          executionId: "exe_ea_red" as never,
          logicalStepNo: 1,
          repairAttempt: 0,
          actionIndex: 0,
          logicalActionId: "lac_ea_red",
        }),
      );
    });

    const result = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect(Option.isNone(result as Option.Option<unknown>)).toBe(true);
  });
});
