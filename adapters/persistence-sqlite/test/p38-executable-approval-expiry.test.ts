import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionId, Principal, parse } from "@arbor/domain";
import {
  type DomainEventJournal,
  ExecutableApprovalStore,
  IdGenerator,
  type InboxProjectionStore,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  ExecutableApprovalStoreLive,
  InboxProjectionStoreLive,
  layer,
  P12_MIGRATIONS,
  P38_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const approvalId = "eap_expiry_test";
const projectId = "prj_expiry_test";
const workspaceId = "ws_expiry_test";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const logicalActionId = "lac_expiry_test";
const toolInvocationId = "tin_expiry_test";
const expiredAt = "2026-10-11T00:15:00.000Z";
const expiryObservedAt = "2026-10-11T00:15:00.001Z";

const makeApp = (
  filename = ":memory:",
  transactionBarrier?: { readonly wait: () => Promise<void> },
  idPrefix = "evt_expiry",
) => {
  const db = layer({ filename });
  let sequence = 0;
  const ids = Layer.succeed(IdGenerator, {
    generate: <T>(_kind: string) =>
      Effect.succeed(`${idPrefix}_${++sequence}` as T),
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
  const transactionPort =
    transactionBarrier === undefined
      ? Layer.provide(TransactionPortLive, db)
      : Layer.provide(
          Layer.effect(
            TransactionPort,
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              const run = (statement: string) =>
                sql.unsafe(statement).pipe(
                  Effect.mapError(
                    (cause): TransactionOperationalFailure => ({
                      _tag: "TransactionOperationalFailure",
                      cause: { statement, cause },
                    }),
                  ),
                );
              const transact: TransactionPortService["transact"] = <A, E, R>(
                body: Effect.Effect<A, E, R | TransactionScope>,
              ) =>
                Effect.gen(function* () {
                  yield* Effect.promise(() => transactionBarrier.wait());
                  yield* run("BEGIN IMMEDIATE");
                  const exit = yield* Effect.exit(
                    Effect.provideService(body, TransactionScope, {
                      session: { id: "p38-race" },
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
          ),
          db,
        );
  return Layer.mergeAll(db, ids, inbox, journal, approvals, transactionPort);
};

const makeStartBarrier = (participants: number) => {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      arrivals += 1;
      if (arrivals === participants) release();
      await released;
    },
  };
};

const seedApproval = (input: {
  readonly state: "Pending" | "Approved";
  readonly revision: number;
  readonly inboxConsumedAt: string | null;
  readonly approvalId?: string;
  readonly logicalActionId?: string;
  readonly toolInvocationId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rowApprovalId = input.approvalId ?? approvalId;
    const rowLogicalActionId = input.logicalActionId ?? logicalActionId;
    const rowToolInvocationId = input.toolInvocationId ?? toolInvocationId;
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
        rowApprovalId,
        projectId,
        workspaceId,
        executionId,
        input.state,
        input.revision,
        expiredAt,
        input.state === "Approved" ? "2026-10-11T00:01:00.000Z" : null,
        input.state === "Approved" ? "user:expiry-test" : null,
        input.state === "Approved" ? "Approve" : null,
        rowLogicalActionId,
        rowToolInvocationId,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO inbox_entries (
         workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
         consumed_at
       ) VALUES (?, ?, 'Governance', '{}', ?, '2026-10-11T00:00:00.000Z', ?)`,
      [
        workspaceId,
        `eap:${rowApprovalId}:0`,
        rowLogicalActionId,
        input.inboxConsumedAt,
      ],
    );
  });

const seedStopExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const sessionId = "ses_p38_stop_race";
  const stoppedAt = "2026-10-11T00:01:00.000Z";
  yield* sql.unsafe(
    `INSERT INTO projects (
       project_id, name, root_workspace_id, project_policy,
       project_policy_revision, default_configuration, environment_ref,
       lifecycle, revision, created_at, updated_at
     ) VALUES (?, 'P38 Stop race', ?, '{}', 0, '{}', 'env_p38_stop',
               'Open', 0, ?, ?)`,
    [projectId, workspaceId, stoppedAt, stoppedAt],
  );
  yield* sql.unsafe(
    `INSERT INTO workspaces (
       workspace_id, project_id, parent_workspace_id, name,
       responsibility_definition, responsibility_revision, resource_boundary,
       resource_boundary_revision, agent_binding, primary_session_id,
       current_work_id, workspace_policy, workspace_policy_revision, revision,
       lifecycle, created_at, updated_at
     ) VALUES (?, ?, NULL, 'P38 Stop race', '{}', 0, '{}', 0, '{}', ?, NULL,
               '{}', 0, 0, 'Active', ?, ?)`,
    [workspaceId, projectId, sessionId, stoppedAt, stoppedAt],
  );
  yield* sql.unsafe(
    `INSERT INTO sessions (
       session_id, binding_kind, workspace_id, execution_id, context_epoch,
       created_at
     ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, ?)`,
    [sessionId, workspaceId, stoppedAt],
  );
  yield* sql.unsafe(
    `INSERT INTO executions (
       execution_id, project_id, binding_kind, workspace_id, episode_kind,
       episode_ref, episode_revision, parent_execution_id, mission, session_id,
       admitted_at, stop_requested_at, settlement_kind, settlement_json,
       settled_at
     ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', 'wrk_p38_stop_race', 0,
               NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
    [executionId, projectId, workspaceId, sessionId, stoppedAt],
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
  filename?: string,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, makeApp(filename ?? ":memory:"))),
  );

const makeRetainedDatabaseFile = (label: string) => {
  const directory = mkdtempSync(join(tmpdir(), `arbor-p38-${label}-`));
  const databaseFile = join(directory, "approval.sqlite");
  console.info(
    `P38 retained SQLite fixture: label=${label} database=${databaseFile}`,
  );
  return databaseFile;
};

describe("EA-DG-01 executable approval expiration", () => {
  it("treats pre-0038 schema as an empty approval ledger", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        yield* runMigrations(P12_MIGRATIONS);
        const pending = yield* tx.transact(
          store.findPendingForExecution(
            parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a2"),
          ),
        );
        expect(Option.isNone(pending)).toBe(true);
      }),
    ));

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
        const recovered = yield* tx.transact(store.listResolved(executionId));
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
        expect(recovered.map((row) => [row.state, row.revision])).toEqual([
          ["Expired", 1],
        ]);
        expect(Option.isNone(lateDecision)).toBe(true);
        expect(rows).toEqual([{ state: "Expired", revision: 1 }]);
        expect(inbox[0]?.consumed_at).toEqual(expect.any(String));
        expect(Date.parse(inbox[0]?.consumed_at ?? "")).toBeGreaterThan(0);
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

  it("makes TTL expiry the only resolver when expiry commits before Stop cancellation", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        const sql = yield* SqlClient;
        yield* runMigrations(P38_MIGRATIONS);
        yield* tx.transact(seedStopExecution);
        yield* tx.transact(
          seedApproval({
            state: "Pending",
            revision: 0,
            inboxConsumedAt: null,
          }),
        );

        const expired = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const stopped = yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
              [expiryObservedAt, executionId],
            );
            return yield* store.cancelForExecution({
              executionId,
              cancelledAt: expiryObservedAt,
              cancelledBy: parse(Principal)("user:p38-stop-test"),
              reason: "StopRequested",
            });
          }),
        );
        const replayedExpiry = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const row = yield* sql.unsafe<{
          readonly state: string;
          readonly revision: number;
        }>(
          "SELECT state, revision FROM action_approvals WHERE approval_id = ?",
          [approvalId],
        );
        const events = yield* sql.unsafe<{ readonly event_type: string }>(
          `SELECT event_type FROM domain_events
            WHERE aggregate_ref = ? AND event_type = 'ExecutableApprovalResolved'`,
          [approvalId],
        );
        expect(
          expired.map((approval) => [approval.state, approval.revision]),
        ).toEqual([["Expired", 1]]);
        expect(stopped).toEqual([]);
        expect(replayedExpiry).toEqual([]);
        expect(row).toEqual([{ state: "Expired", revision: 1 }]);
        expect(events).toHaveLength(1);
      }),
      makeRetainedDatabaseFile("ttl-wins-stop-race"),
    ));

  it("makes Stop cancellation the only resolver when Stop commits before TTL expiry", () =>
    runDb(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ExecutableApprovalStore;
        const sql = yield* SqlClient;
        yield* runMigrations(P38_MIGRATIONS);
        yield* tx.transact(seedStopExecution);
        yield* tx.transact(
          seedApproval({
            state: "Pending",
            revision: 0,
            inboxConsumedAt: null,
          }),
        );

        const stopped = yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
              ["2026-10-11T00:01:00.000Z", executionId],
            );
            return yield* store.cancelForExecution({
              executionId,
              cancelledAt: "2026-10-11T00:01:00.000Z",
              cancelledBy: parse(Principal)("user:p38-stop-test"),
              reason: "StopRequested",
            });
          }),
        );
        const expired = yield* tx.transact(
          store.expireDue({
            now: expiryObservedAt,
            expiredBy: parse(Principal)("runtime:system"),
          }),
        );
        const row = yield* sql.unsafe<{
          readonly state: string;
          readonly revision: number;
          readonly cancelled_at: string | null;
        }>(
          "SELECT state, revision, cancelled_at FROM action_approvals WHERE approval_id = ?",
          [approvalId],
        );
        const inbox = yield* sql.unsafe<{
          readonly consumed_at: string | null;
        }>(
          "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
          [workspaceId, `eap:${approvalId}:0`],
        );
        expect(
          stopped.map((approval) => [approval.state, approval.revision]),
        ).toEqual([["Cancelled", 1]]);
        expect(expired).toEqual([]);
        expect(row).toEqual([
          {
            state: "Cancelled",
            revision: 1,
            cancelled_at: "2026-10-11T00:01:00.000Z",
          },
        ]);
        expect(inbox).toEqual([{ consumed_at: "2026-10-11T00:01:00.000Z" }]);
      }),
      makeRetainedDatabaseFile("stop-wins-ttl-race"),
    ));

  it("arbitrates human Reject versus TTL expiry once across independent barrier-synchronized SQLite connections", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "arbor-p38-resolve-ttl-race-"),
    );
    const databaseFile = join(directory, "approval.sqlite");
    try {
      await runDb(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          yield* runMigrations(P38_MIGRATIONS);
          yield* tx.transact(seedStopExecution);
        }),
        databaseFile,
      );

      for (let round = 0; round < 8; round += 1) {
        const suffix = `round_${round}`;
        const raceApprovalId = `eap_${suffix}`;
        const raceLogicalActionId = `lac_${suffix}`;
        const raceToolInvocationId = `tin_${suffix}`;
        await runDb(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            yield* tx.transact(
              seedApproval({
                state: "Pending",
                revision: 0,
                inboxConsumedAt: null,
                approvalId: raceApprovalId,
                logicalActionId: raceLogicalActionId,
                toolInvocationId: raceToolInvocationId,
              }),
            );
          }),
          databaseFile,
        );

        const barrier = makeStartBarrier(2);
        const humanLayer = makeApp(databaseFile, barrier, `evt_human_${round}`);
        const expiryLayer = makeApp(
          databaseFile,
          barrier,
          `evt_expiry_${round}`,
        );
        const humanDecision = Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ExecutableApprovalStore;
          return yield* tx.transact(
            store.decide({
              approvalId: raceApprovalId,
              commandId: `cmd_${suffix}` as never,
              expectedRevision: 0,
              decision: "Reject",
              decidedAt: "2026-10-11T00:14:59.999Z",
              decidedBy: parse(Principal)("user:expiry-test"),
              reason: `barrier race ${suffix}`,
            }),
          );
        });
        const ttlExpiry = Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ExecutableApprovalStore;
          return yield* tx.transact(
            store.expireDue({
              now: expiryObservedAt,
              expiredBy: parse(Principal)("runtime:system"),
            }),
          );
        });
        const [decision, expired] = await Promise.all([
          Effect.runPromise(
            Effect.scoped(Effect.provide(humanDecision, humanLayer)),
          ),
          Effect.runPromise(
            Effect.scoped(Effect.provide(ttlExpiry, expiryLayer)),
          ),
        ]);

        const humanWon = Option.isSome(decision);
        const ttlWon = expired.length === 1;
        expect(Number(humanWon) + Number(ttlWon)).toBe(1);
        if (humanWon) {
          expect(decision.value).toMatchObject({
            state: "Rejected",
            revision: 1,
          });
          expect(expired).toEqual([]);
        } else {
          expect(expired[0]).toMatchObject({ state: "Expired", revision: 1 });
        }

        const persisted = await runDb(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const rows = yield* sql.unsafe<{
              readonly state: string;
              readonly revision: number;
            }>(
              "SELECT state, revision FROM action_approvals WHERE approval_id = ?",
              [raceApprovalId],
            );
            const inbox = yield* sql.unsafe<{
              readonly consumed_at: string | null;
            }>(
              "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
              [workspaceId, `eap:${raceApprovalId}:0`],
            );
            const events = yield* sql.unsafe<{
              readonly payload_json: string;
            }>(
              `SELECT payload_json FROM domain_events
                WHERE event_type = 'ExecutableApprovalResolved'
                  AND aggregate_ref = ?`,
              [raceApprovalId],
            );
            return { rows, inbox, events };
          }),
          databaseFile,
        );
        expect(persisted.rows).toEqual([
          {
            state: humanWon ? "Rejected" : "Expired",
            revision: 1,
          },
        ]);
        expect(persisted.inbox).toHaveLength(1);
        expect(persisted.inbox[0]?.consumed_at).toEqual(expect.any(String));
        expect(persisted.events).toHaveLength(1);
        expect(
          JSON.parse(persisted.events[0]?.payload_json ?? "{}"),
        ).toMatchObject({
          resolution: humanWon ? "Rejected" : "Expired",
          revision: 1,
          ...(humanWon ? {} : { reasonCode: "TTLExpired" }),
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it("arbitrates Stop cancellation versus TTL expiry once across independent barrier-synchronized SQLite connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p38-stop-ttl-race-"));
    const databaseFile = join(directory, "approval.sqlite");
    try {
      await runDb(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          yield* runMigrations(P38_MIGRATIONS);
          yield* tx.transact(seedStopExecution);
        }),
        databaseFile,
      );

      for (let round = 0; round < 8; round += 1) {
        const suffix = `stop_round_${round}`;
        const raceApprovalId = `eap_${suffix}`;
        const raceLogicalActionId = `lac_${suffix}`;
        const raceToolInvocationId = `tin_${suffix}`;
        await runDb(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            yield* tx.transact(
              seedApproval({
                state: "Pending",
                revision: 0,
                inboxConsumedAt: null,
                approvalId: raceApprovalId,
                logicalActionId: raceLogicalActionId,
                toolInvocationId: raceToolInvocationId,
              }),
            );
          }),
          databaseFile,
        );

        const barrier = makeStartBarrier(2);
        const stopLayer = makeApp(databaseFile, barrier, `evt_stop_${round}`);
        const expiryLayer = makeApp(
          databaseFile,
          barrier,
          `evt_stop_ttl_${round}`,
        );
        const stopCancellation = Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ExecutableApprovalStore;
          const sql = yield* SqlClient;
          return yield* tx.transact(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
                ["2026-10-11T00:01:00.000Z", executionId],
              );
              return yield* store.cancelForExecution({
                executionId,
                cancelledAt: "2026-10-11T00:01:00.000Z",
                cancelledBy: parse(Principal)("user:p38-stop-race"),
                reason: "StopRequested",
              });
            }),
          );
        });
        const ttlExpiry = Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ExecutableApprovalStore;
          return yield* tx.transact(
            store.expireDue({
              now: expiryObservedAt,
              expiredBy: parse(Principal)("runtime:system"),
            }),
          );
        });
        const [cancelled, expired] = await Promise.all([
          Effect.runPromise(
            Effect.scoped(Effect.provide(stopCancellation, stopLayer)),
          ),
          Effect.runPromise(
            Effect.scoped(Effect.provide(ttlExpiry, expiryLayer)),
          ),
        ]);
        const stopWon = cancelled.length === 1;
        const ttlWon = expired.length === 1;
        expect(Number(stopWon) + Number(ttlWon)).toBe(1);
        if (stopWon) {
          expect(cancelled[0]).toMatchObject({
            state: "Cancelled",
            revision: 1,
          });
          expect(expired).toEqual([]);
        } else {
          expect(expired[0]).toMatchObject({ state: "Expired", revision: 1 });
          expect(cancelled).toEqual([]);
        }

        const persisted = await runDb(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const rows = yield* sql.unsafe<{
              readonly state: string;
              readonly revision: number;
              readonly cancelled_at: string | null;
            }>(
              "SELECT state, revision, cancelled_at FROM action_approvals WHERE approval_id = ?",
              [raceApprovalId],
            );
            const inbox = yield* sql.unsafe<{
              readonly consumed_at: string | null;
            }>(
              "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
              [workspaceId, `eap:${raceApprovalId}:0`],
            );
            const events = yield* sql.unsafe<{
              readonly payload_json: string;
            }>(
              `SELECT payload_json FROM domain_events
                WHERE event_type = 'ExecutableApprovalResolved'
                  AND aggregate_ref = ?`,
              [raceApprovalId],
            );
            return { rows, inbox, events };
          }),
          databaseFile,
        );
        expect(persisted.rows).toEqual([
          {
            state: stopWon ? "Cancelled" : "Expired",
            revision: 1,
            cancelled_at: stopWon ? "2026-10-11T00:01:00.000Z" : null,
          },
        ]);
        expect(persisted.inbox).toHaveLength(1);
        expect(persisted.inbox[0]?.consumed_at).toEqual(expect.any(String));
        expect(persisted.events).toHaveLength(ttlWon ? 1 : 0);
        if (ttlWon) {
          expect(
            JSON.parse(persisted.events[0]?.payload_json ?? "{}"),
          ).toMatchObject({
            resolution: "Expired",
            revision: 1,
          });
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
