import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  layer,
  DomainEventJournalLive,
  ExecutableApprovalStore,
  ExecutableApprovalStoreLive,
  InboxProjectionStoreLive,
  P36_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  IdGenerator,
  TransactionPort,
} from "../../../packages/ports/src/index.js";

describe("EA-DG-01 SQLite approval-store red boundary", () => {
  it("reads an exact logical-action approval from the registered P36 schema", async () => {
    const db = layer({ filename: ":memory:" });
    const ids = Layer.succeed(IdGenerator, {
      generate: <T>(_kind: string) => Effect.succeed("id_test" as T),
    });
    const inbox = Layer.provide(InboxProjectionStoreLive, db);
    const journal = Layer.provide(DomainEventJournalLive, Layer.mergeAll(db, ids));
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
      yield* runMigrations(P36_MIGRATIONS);
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
    // Expected RED at the P36 checkpoint: the store queries the 0038 binding
    // columns, which do not exist before 0038. No P37 schema is simulated here.
    expect(Option.isNone(result as Option.Option<unknown>)).toBe(true);
  });
});
