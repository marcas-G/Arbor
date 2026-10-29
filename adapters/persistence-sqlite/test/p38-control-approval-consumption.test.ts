import { ControlApprovalStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { ControlApprovalStoreLive } from "../src/control-approval.js";
import { runMigrations } from "../src/migrate.js";
import { P38_MIGRATIONS } from "../src/migrations.js";
import { TransactionPortLive } from "../src/transaction.js";

describe("P38 Control approval consumption", () => {
  it("requires and preserves a runtime action identity in the unified ledger", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(ControlApprovalStoreLive, base),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P38_MIGRATIONS);
          const approvals = yield* ControlApprovalStore;
          const tx = yield* TransactionPort;
          const sql = yield* SqlClient;
          const requestedAt = "2026-10-11T00:00:00.000Z";
          const approvedAt = "2026-10-11T00:01:00.000Z";
          const consumedAt = "2026-10-11T00:02:00.000Z";

          yield* tx.transact(
            approvals.putPending({
              approvalId: "cap_p38_consumption",
              projectId: "prj_p38_consumption" as never,
              workspaceId: "ws_p38_consumption" as never,
              executionId: "exe_p38_consumption" as never,
              stableActionId: "core.control.assign-work",
              actionDigest: "action-digest-p38",
              argumentsJson: "{}",
              targetRef: "ws_p38_consumption",
              controlBasisDigest: "basis-p38",
              state: "Pending",
              revision: 0,
              requestedAt,
              expiresAt: "2026-10-12T00:00:00.000Z",
              decidedAt: null,
              decidedBy: null,
              decisionReason: null,
              consumedAt: null,
            }),
          );
          const decided = yield* tx.transact(
            approvals.decide({
              approvalId: "cap_p38_consumption",
              expectedRevision: 0,
              decision: "Approve",
              decidedAt: approvedAt,
              decidedBy: "user:p38-test",
              reason: null,
            }),
          );
          expect(Option.getOrThrow(decided)).toMatchObject({
            state: "Approved",
            revision: 1,
          });

          const invalidUpdate = sql.unsafe(
            `UPDATE action_approvals
                SET state = 'Consumed', revision = 2, consumed_at = ?,
                    consumed_by = NULL
              WHERE approval_id = ?`,
            [consumedAt, "cap_p38_consumption"],
          );
          const invalidWasRejected = yield* Effect.match(invalidUpdate, {
            onFailure: () => true,
            onSuccess: () => false,
          });
          expect(invalidWasRejected).toBe(true);

          const consumed = yield* tx.transact(
            approvals.consumeApproved({
              approvalId: "cap_p38_consumption",
              expectedRevision: 1,
              actionDigest: "action-digest-p38",
              controlBasisDigest: "basis-p38",
              consumedAt,
              consumedBy: "lac_p38_runtime_action",
            }),
          );
          expect(Option.getOrThrow(consumed)).toMatchObject({
            state: "Consumed",
            revision: 2,
            consumedAt,
            consumedBy: "lac_p38_runtime_action",
          });

          const replay = yield* tx.transact(
            approvals.consumeApproved({
              approvalId: "cap_p38_consumption",
              expectedRevision: 1,
              actionDigest: "action-digest-p38",
              controlBasisDigest: "basis-p38",
              consumedAt: "2026-10-11T00:03:00.000Z",
              consumedBy: "lac_p38_runtime_action",
            }),
          );
          expect(Option.isNone(replay)).toBe(true);
          const stored = yield* tx.transact(
            approvals.findById("cap_p38_consumption"),
          );
          expect(Option.getOrThrow(stored)).toMatchObject({
            state: "Consumed",
            revision: 2,
            consumedAt,
            consumedBy: "lac_p38_runtime_action",
          });
          return true;
        }),
        app,
      ),
    );
    expect(result).toBe(true);
  });
});
