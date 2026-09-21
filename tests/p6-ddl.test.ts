import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  FormationProposalStoreLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P6_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  admitFormationProposal,
  decideFormationProposal,
  type MessageId,
  parse,
} from "../packages/domain/src/index.js";
import {
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  FPR_1,
  minimalProposal,
  WS_CHILD,
  WS_ROOT,
} from "./harness/p6-fixtures.js";

const MSG_1 = parse(
  (await import("../packages/domain/src/index.js")).MessageId,
)("msg_00000000-0000-7000-8000-000000000001");

const fullLayer = () => {
  const base = layer({ filename: ":memory:" });
  return Layer.provideMerge(
    Layer.mergeAll(
      FormationProposalStoreLive,
      MessageStoreLive,
      InboxProjectionStoreLive,
      TransactionPortLive,
    ),
    base,
  );
};

const run = <A, E, R>(
  program: Effect.Effect<A, E, SqlClient | R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P6_MIGRATIONS);
          const tx = yield* TransactionPort;
          return yield* tx.transact(program);
        }) as Effect.Effect<A, E, SqlClient>,
        fullLayer(),
      ),
    ),
  );

describe("P6-002 DDL + stores", () => {
  it("applies the p6 migration and enforces inbox upsert-by-key (D3)", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('formation_proposals','messages','message_correlations','inbox_entries')",
        );
        expect(tables.map((t) => t.name).sort()).toEqual([
          "formation_proposals",
          "inbox_entries",
          "message_correlations",
          "messages",
        ]);

        const inbox = yield* InboxProjectionStore;
        yield* inbox.admitUpsert({
          recipientWorkspaceId: WS_CHILD,
          entryKey: "spc:exe-1:fp-1",
          kind: "SpecialistSettled",
          summary: "specialist done",
          admittedAt: "2026-09-21T00:00:00.000Z",
        });
        yield* inbox.admitUpsert({
          recipientWorkspaceId: WS_CHILD,
          entryKey: "spc:exe-1:fp-1",
          kind: "SpecialistSettled",
          summary: "specialist done (replayed)",
          admittedAt: "2026-09-21T00:00:01.000Z",
        });
        expect(yield* inbox.countByKey(WS_CHILD, "spc:exe-1:fp-1")).toBe(1);
        const pending = yield* inbox.listUnconsumed(WS_CHILD);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.summary).toBe("specialist done");
      }),
    );
  });

  it("formation proposal CAS enforces exact-revision Pending decisions (D1)", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* FormationProposalStore;
        const record = admitFormationProposal({
          proposalId: FPR_1,
          parentWorkspaceId: WS_ROOT,
          proposal: minimalProposal(),
        });
        yield* store.insert(record);
        expect(
          Option.isNone(yield* store.decideIfPendingRevision(FPR_1, 2, record)),
        ).toBe(true);
        const decided = decideFormationProposal(record, {
          expectedProposalRevision: 1,
          outcome: { _tag: "Approve" },
        });
        expect(decided.ok).toBe(true);
        if (decided.ok) {
          expect(
            Option.isSome(
              yield* store.decideIfPendingRevision(
                FPR_1,
                1,
                decided.value.record,
              ),
            ),
          ).toBe(true);
          expect(
            Option.isNone(
              yield* store.decideIfPendingRevision(
                FPR_1,
                1,
                decided.value.record,
              ),
            ),
          ).toBe(true);
          const after = yield* store.findById(FPR_1);
          expect(Option.isSome(after) && after.value.state).toBe("Approved");
        }
      }),
    );
  });

  it("message store persists facts and closes correlations idempotently", async () => {
    await run(
      Effect.gen(function* () {
        const messages = yield* MessageStore;
        yield* messages.append({
          messageId: MSG_1 as MessageId,
          senderWorkspaceId: WS_ROOT,
          message: {
            kind: "Report",
            recipientWorkspaceId: WS_CHILD,
            bodyRef: "art-body-1",
            urgency: "Normal",
          },
          sentAt: "2026-09-21T00:00:00.000Z",
        });
        const found = yield* messages.findById(MSG_1 as MessageId);
        expect(Option.isSome(found)).toBe(true);
        expect(Option.isSome(found) && found.value.message.kind).toBe("Report");

        yield* messages.closeCorrelation("cor-1");
        yield* messages.closeCorrelation("cor-1");
        expect(yield* messages.isCorrelationClosed("cor-1")).toBe(true);
        expect(yield* messages.isCorrelationClosed("cor-2")).toBe(false);
      }),
    );
  });
});
