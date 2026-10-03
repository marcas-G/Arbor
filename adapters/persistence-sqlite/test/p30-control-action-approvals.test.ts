import type { ControlApprovalRecord } from "@arbor/ports";
import { ControlApprovalStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { ControlApprovalStoreLive } from "../src/control-approval.js";
import { runMigrations } from "../src/migrate.js";
import { P30_MIGRATIONS } from "../src/migrations.js";
import { TransactionPortLive } from "../src/transaction.js";

const record: ControlApprovalRecord = {
  approvalId: "cap_test",
  projectId: "prj" as never,
  workspaceId: "ws" as never,
  executionId: "exe" as never,
  stableActionId: "core.control.assign-work",
  actionDigest: "action-digest",
  argumentsJson: "{}",
  targetRef: "ws",
  controlBasisDigest: "basis-digest",
  state: "Pending",
  revision: 0,
  requestedAt: "2026-10-03T00:00:00.000Z",
  expiresAt: "2026-10-03T01:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  consumedAt: null,
};

describe("CAPA migration 0030 control approval store", () => {
  it("decides and single-consumes one exact action", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(ControlApprovalStoreLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P30_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj','p','ws','{}',0,'{}','local','Open',0,'t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses','WorkspacePrimary','ws',NULL,0,'t')",
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws','prj',NULL,'w','{}',0,'{}',0,'{}','ses',NULL,'{}',0,0,'Active','t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe','prj','workspace','ws','InboxEpisode','test',0,NULL,NULL,'ses','t',NULL,NULL,NULL,NULL)",
              );
            }),
          );
          const store = yield* ControlApprovalStore;
          const tx = yield* TransactionPort;
          yield* tx.transact(store.putPending(record));
          const decided = yield* tx.transact(
            store.decide({
              approvalId: record.approvalId,
              expectedRevision: 0,
              decision: "Approve",
              decidedAt: "2026-10-03T00:10:00.000Z",
              decidedBy: "user:approver",
              reason: null,
            }),
          );
          expect(Option.getOrThrow(decided)).toMatchObject({
            state: "Approved",
            revision: 1,
          });
          const consumed = yield* tx.transact(
            store.consumeApproved({
              approvalId: record.approvalId,
              expectedRevision: 1,
              actionDigest: record.actionDigest,
              controlBasisDigest: record.controlBasisDigest,
              consumedAt: "2026-10-03T00:11:00.000Z",
            }),
          );
          expect(Option.getOrThrow(consumed)).toMatchObject({
            state: "Consumed",
            revision: 2,
          });
          expect(
            Option.isNone(
              yield* tx.transact(
                store.consumeApproved({
                  approvalId: record.approvalId,
                  expectedRevision: 1,
                  actionDigest: record.actionDigest,
                  controlBasisDigest: record.controlBasisDigest,
                  consumedAt: "2026-10-03T00:12:00.000Z",
                }),
              ),
            ),
          ).toBe(true);

          yield* tx.transact(
            store.putPending({
              ...record,
              approvalId: "cap_concurrent",
              actionDigest: "concurrent-action",
            }),
          );
          const concurrent = yield* Effect.all(
            ["Approve", "Reject"].map((decision) =>
              tx.transact(
                store.decide({
                  approvalId: "cap_concurrent",
                  expectedRevision: 0,
                  decision: decision as "Approve" | "Reject",
                  decidedAt: "2026-10-03T00:20:00.000Z",
                  decidedBy: `user:${decision.toLowerCase()}`,
                  reason: null,
                }),
              ),
            ),
            { concurrency: "unbounded" },
          );
          expect(concurrent.filter(Option.isSome)).toHaveLength(1);

          yield* tx.transact(
            store.putPending({
              ...record,
              approvalId: "cap_expired",
              actionDigest: "expired-action",
              expiresAt: "2026-10-03T00:05:00.000Z",
            }),
          );
          const expired = yield* tx.transact(
            store.expireDue("2026-10-03T00:06:00.000Z"),
          );
          expect(expired).toEqual([
            expect.objectContaining({
              approvalId: "cap_expired",
              state: "Expired",
              revision: 1,
            }),
          ]);
          expect(
            Option.isNone(
              yield* tx.transact(
                store.decide({
                  approvalId: "cap_expired",
                  expectedRevision: 1,
                  decision: "Approve",
                  decidedAt: "2026-10-03T00:07:00.000Z",
                  decidedBy: "user:late",
                  reason: null,
                }),
              ),
            ),
          ).toBe(true);
        }),
        app,
      ),
    );
  });
});
