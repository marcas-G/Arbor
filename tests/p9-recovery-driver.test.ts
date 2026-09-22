import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { Principal, parse } from "../packages/domain/dist/index.js";
import {
  preDispatchCheck,
  runRecovery,
  startupRecovery,
  sweepRecovery,
} from "../packages/execution-runtime/src/index.js";
import {
  makeP7App,
  p7Project,
  p7SeedProject,
  runP7,
} from "./support/p7-app.js";

const principal = parse(Principal)("user:gov");

const ROOT_WS = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";

const INSERT_EXECUTION = (executionId: string, stopRequested: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const sesId = `ses_${executionId}`;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [sesId, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', ?, NULL, NULL, NULL)",
      [executionId, p7Project, ROOT_WS, sesId, stopRequested],
    );
  });

/** Durable completion fact (P9 `01` §2 B-2): an `ExecutionSettled(Completed)`
 * journal event persisted for an execution whose row never settled — the
 * crash-window fixture between settlement-trace persistence and row settle. */
const INSERT_COMPLETION_FACT = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const settlement = {
      _tag: "Completed",
      result: {
        _tag: "CompletionClaimed",
        workRevision: 3,
        claimRef: "claim_p9_b2",
      },
    };
    yield* sql.unsafe(
      "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1",
      [p7Project],
    );
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "SELECT last_sequence FROM project_event_sequences WHERE project_id = ?",
      [p7Project],
    );
    const sequence = Number(rows[0]!.last_sequence);
    yield* sql.unsafe(
      "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        `evt_${executionId}_${sequence}`,
        p7Project,
        sequence,
        "ExecutionSettled",
        1,
        "t",
        executionId,
        "user:gov",
        JSON.stringify({ executionId, settlement }),
      ],
    );
    return settlement;
  });

const INSERT_LEASE = (executionId: string, expiresAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,0,?,'t') ON CONFLICT(execution_id) DO UPDATE SET expires_at = excluded.expires_at, worker_id = excluded.worker_id",
      [executionId, "worker:other", expiresAt],
    );
  });

const executionRow = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      settlement_kind: string | null;
      settlement_json: string | null;
    }>(
      "SELECT settlement_kind, settlement_json FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows[0]
      ? {
          kind: rows[0].settlement_kind,
          settlement: JSON.parse(rows[0].settlement_json ?? "null") as unknown,
        }
      : { kind: "missing" as const, settlement: null };
  });

const countEvents = (executionId: string, eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ? AND aggregate_ref = ?",
      [eventType, executionId],
    );
    return Number(rows[0]!.count);
  });

const countCommands = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
      [commandId],
    );
    return Number(rows[0]!.count);
  });

describe("P9-003 completion-fact settle + recovery drive (B-2, T1, T4)", () => {
  it("B-2 [crash-injected]: durable Completed(CompletionClaimed) fact on an unsettled execution settles the corresponding Completed form via RecoveryController authority", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        const fact = yield* INSERT_COMPLETION_FACT("exe_p9_b2");
        yield* INSERT_EXECUTION("exe_p9_b2", null);
        const result = yield* runRecovery(principal);
        expect(result.settled).toContain("exe_p9_b2");
        const row = yield* executionRow("exe_p9_b2");
        expect(row.kind).toBe("Completed");
        expect(row.settlement).toEqual(fact);
        const commands = yield* countCommands(
          "cmd_recovery_completion_exe_p9_b2",
        );
        expect(commands).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("T1 [crash-injected]: startup pass settles the fact and idempotent re-entry converges — no double settlement, no duplicate fact events (D2)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_COMPLETION_FACT("exe_p9_t1");
        yield* INSERT_EXECUTION("exe_p9_t1", null);
        const first = yield* startupRecovery(principal);
        expect(first.recovery.settled).toEqual(["exe_p9_t1"]);
        // Crash during/after T1 → restart re-runs T1: idempotent re-entry.
        const second = yield* startupRecovery(principal);
        expect(second.recovery.settled).toEqual([]);
        expect(second.recovery.escalated).toEqual([]);
        const row = yield* executionRow("exe_p9_t1");
        expect(row.kind).toBe("Completed");
        // One seeded fact + one settle event — never two settles.
        expect(yield* countEvents("exe_p9_t1", "ExecutionSettled")).toBe(2);
        expect(yield* countCommands("cmd_recovery_completion_exe_p9_t1")).toBe(
          1,
        );
      }),
      makeP7App(),
    );
  });

  it("T2/T3: the sweep entry is the same pass as T1 (completion fact settles through sweepRecovery too)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_COMPLETION_FACT("exe_p9_t2");
        yield* INSERT_EXECUTION("exe_p9_t2", null);
        const swept = yield* sweepRecovery(principal);
        expect(swept.recovery.settled).toEqual(["exe_p9_t2"]);
        const row = yield* executionRow("exe_p9_t2");
        expect(row.kind).toBe("Completed");
      }),
      makeP7App(),
    );
  });

  it("T4 (GQ3): pre-dispatch check is the lease-fence predicate ONLY — zero recovery observables (no journal rows, no settles, no commands)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_t4a", null);
        yield* INSERT_EXECUTION("exe_p9_t4b", null);
        const sql = yield* SqlClient;
        const snapshot = Effect.gen(function* () {
          const events = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM domain_events",
          );
          const commands = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM commands",
          );
          const settled = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM executions WHERE settled_at IS NOT NULL",
          );
          return {
            events: Number(events[0]!.count),
            commands: Number(commands[0]!.count),
            settled: Number(settled[0]!.count),
          };
        });
        const before = yield* snapshot;
        // Live, unexpired lease fences the dispatch → skip.
        yield* INSERT_LEASE(
          "exe_p9_t4a",
          new Date(Date.now() + 60_000).toISOString(),
        );
        expect(yield* preDispatchCheck("exe_p9_t4a" as never)).toBe(false);
        // Expired lease: lazy invalidation at acquisition (P2 `06` §3) → proceed.
        yield* INSERT_LEASE("exe_p9_t4a", "2000-01-01T00:00:00.000Z");
        expect(yield* preDispatchCheck("exe_p9_t4a" as never)).toBe(true);
        // No lease at all → proceed.
        expect(yield* preDispatchCheck("exe_p9_t4b" as never)).toBe(true);
        const after = yield* snapshot;
        expect(after).toEqual(before);
      }),
      makeP7App(),
    );
  });
});
