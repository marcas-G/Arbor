import { Principal, parse } from "@arbor/domain";
import {
  type DomainEventJournal,
  ExecutableApprovalStore,
  IdGenerator,
  type InboxProjectionStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  ExecutableApprovalStoreLive,
  InboxProjectionStoreLive,
  layer,
  P38_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const approvalId = "eap_expiry_test";
const projectId = "prj_expiry_test";
const workspaceId = "ws_expiry_test";
const executionId = "exe_expiry_test";
const logicalActionId = "lac_expiry_test";
const toolInvocationId = "tin_expiry_test";
const expiredAt = "2026-10-11T00:15:00.000Z";
const expiryObservedAt = "2026-10-11T00:15:00.001Z";

const makeApp = () => {
  const db = layer({ filename: ":memory:" });
  let sequence = 0;
  const ids = Layer.succeed(IdGenerator, {
    generate: <T>(_kind: string) =>
      Effect.succeed(`evt_expiry_${++sequence}` as T),
  });
  const inbox = Layer.provide(InboxProjectionStoreLive, db);
  const journal = Layer.provide(
    DomainEventJournalLive,
    Layer.mergeAll(db, ids),
  );
  const approvals = Layer.provide(
    ExecutableApprovalStoreLive,
    Layer.mergeAll(db, ids, inbox, journal),
  );
  return Layer.mergeAll(
    db,
    ids,
    inbox,
    journal,
    approvals,
    Layer.provide(TransactionPortLive, db),
  );
};

const seedApproval = (input: {
  readonly state: "Pending" | "Approved";
  readonly revision: number;
  readonly inboxConsumedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO action_approvals (
         approval_id, route_kind, project_id, workspace_id, execution_id,
         subject_ref, stable_action_id, action_version, side_effect_semantics,
         action_digest, arguments_json, target_ref,
         target_resource_space_ids_json, control_basis_digest, state, revision,
         requested_at, expires_at, decided_at, decided_by, decision_reason,
         consumed_at, consumed_by, binding_proven, source_state,
         logical_step_no, repair_attempt, action_index, logical_action_id,
         call_ref, tool_invocation_id, cancelled_at, cancelled_by,
         cancellation_reason
       ) VALUES (?, 'Executable', ?, ?, ?, 'user:expiry-test', 'write_file',
         '2', 'Idempotent', 'digest-expiry', '{"path":"a.txt"}', '[]',
         '["space-expiry"]', 'basis-expiry', ?, ?,
         '2026-10-11T00:00:00.000Z', ?, ?, ?, ?, NULL, NULL, 1, NULL,
         2, 0, 0, ?, 'call-expiry', ?, NULL, NULL, NULL)`,
      [
        approvalId,
        projectId,
        workspaceId,
        executionId,
        input.state,
        input.revision,
        expiredAt,
        input.state === "Approved" ? "2026-10-11T00:01:00.000Z" : null,
        input.state === "Approved" ? "user:expiry-test" : null,
        input.state === "Approved" ? "Approve" : null,
        logicalActionId,
        toolInvocationId,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO inbox_entries (
         workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
         consumed_at
       ) VALUES (?, ?, 'Governance', '{}', ?, '2026-10-11T00:00:00.000Z', ?)`,
      [
        workspaceId,
        `eap:${approvalId}:0`,
        logicalActionId,
        input.inboxConsumedAt,
      ],
    );
  });

const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    | SqlClient
    | ExecutableApprovalStore
    | IdGenerator
    | DomainEventJournal
    | InboxProjectionStore
    | TransactionPort
  >,
) => Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

describe("EA-DG-01 executable approval expiration", () => {
  it("expires Pending by exact CAS, consumes its Inbox key and journals one wake", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        const sql = yield* SqlClient;
        yield* runMigrations(P38_MIGRATIONS);
        yield* tx.transact(
          seedApproval({
            state: "Pending",
            revision: 0,
            inboxConsumedAt: null,
          }),
        );

        const first = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const replay = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const lateDecision = yield* tx.transact(
          store.decide({
            approvalId,
            commandId: "cmd_expiry_loser" as never,
            expectedRevision: 0,
            decision: "Approve",
            decidedAt: expiryObservedAt,
            decidedBy: parse(Principal)("user:expiry-test"),
            reason: null,
          }),
        );
        const rows = yield* sql.unsafe<{
          state: string;
          revision: number;
        }>(
          "SELECT state, revision FROM action_approvals WHERE approval_id = ?",
          [approvalId],
        );
        const inbox = yield* sql.unsafe<{ consumed_at: string | null }>(
          "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
          [workspaceId, `eap:${approvalId}:0`],
        );
        const events = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM domain_events WHERE event_type = 'ExecutableApprovalResolved' AND aggregate_ref = ?",
          [approvalId],
        );
        expect(first.map((row) => [row.state, row.revision])).toEqual([
          ["Expired", 1],
        ]);
        expect(replay).toEqual([]);
        expect(Option.isNone(lateDecision)).toBe(true);
        expect(rows).toEqual([{ state: "Expired", revision: 1 }]);
        expect(inbox[0]?.consumed_at).toBe(expiryObservedAt);
        expect(events).toHaveLength(1);
        expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({
          resolution: "Expired",
          reasonCode: "TTLExpired",
          revision: 1,
        });
      }),
    ));

  it("uses the same Pending revision CAS when a human decision arrives after TTL", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        const sql = yield* SqlClient;
        yield* runMigrations(P38_MIGRATIONS);
        yield* tx.transact(
          seedApproval({
            state: "Pending",
            revision: 0,
            inboxConsumedAt: null,
          }),
        );

        const decision = yield* tx.transact(
          store.decide({
            approvalId,
            commandId: "cmd_expiry_test" as never,
            expectedRevision: 0,
            decision: "Approve",
            decidedAt: expiryObservedAt,
            decidedBy: parse(Principal)("user:expiry-test"),
            reason: null,
          }),
        );
        const scan = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const rows = yield* sql.unsafe<{ state: string; revision: number }>(
          "SELECT state, revision FROM action_approvals WHERE approval_id = ?",
          [approvalId],
        );
        const events = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM domain_events WHERE event_type = 'ExecutableApprovalResolved' AND aggregate_ref = ?",
          [approvalId],
        );
        expect(Option.isSome(decision)).toBe(true);
        expect(Option.isSome(decision) && decision.value.state).toBe("Expired");
        expect(scan).toEqual([]);
        expect(rows).toEqual([{ state: "Expired", revision: 1 }]);
        expect(events).toHaveLength(1);
        expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({
          resolution: "Expired",
          reasonCode: "TTLExpired",
        });
      }),
    ));

  it("expires an already Approved row once without reopening its consumed Inbox", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        const sql = yield* SqlClient;
        yield* runMigrations(P38_MIGRATIONS);
        yield* tx.transact(
          seedApproval({
            state: "Approved",
            revision: 1,
            inboxConsumedAt: "2026-10-11T00:01:00.000Z",
          }),
        );

        const expired = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const inbox = yield* sql.unsafe<{ consumed_at: string | null }>(
          "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
          [workspaceId, `eap:${approvalId}:0`],
        );
        expect(expired.map((row) => [row.state, row.revision])).toEqual([
          ["Expired", 2],
        ]);
        expect(inbox[0]?.consumed_at).toBe("2026-10-11T00:01:00.000Z");
      }),
    ));
});
