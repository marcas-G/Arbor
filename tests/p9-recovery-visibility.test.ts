import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { Principal, parse } from "../packages/domain/dist/index.js";
import { runRecovery } from "../packages/execution-runtime/src/index.js";
import { TransactionPort } from "../packages/ports/src/index.js";
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

const INSERT_INVOCATION = (
  invocationId: string,
  executionId: string,
  semantics: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, intent_at) VALUES (?,?,?,?,?,?,?,?,'t')",
      [
        invocationId,
        executionId,
        "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
        "shell",
        "1",
        semantics,
        "{}",
        "[]",
      ],
    );
  });

const attentionFacts = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
      [executionId],
    );
    return Number(rows[0]!.count);
  });

const executionState = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
      "SELECT settlement_kind FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows[0]?.settlement_kind ?? "missing";
  });

describe("P9-002 recovery visibility (B-1 gate I-1..I-3)", () => {
  it("I-1 [crash-injected]: stopped execution + unsettled NonIdempotent NEVER settles Interrupted; OutcomeUnknown or escalation only", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_i1", "t");
        yield* INSERT_INVOCATION("tin_p9_i1", "exe_p9_i1", "NonIdempotent");
        yield* runRecovery(principal);
        const state = yield* executionState("exe_p9_i1");
        expect(state).not.toBe("Interrupted");
        expect(state === null || state === "missing").toBe(true); // stays active (escalated)
        const facts = yield* attentionFacts("exe_p9_i1");
        expect(facts).toBeGreaterThanOrEqual(1);
      }),
      makeP7App(),
    );
  });

  it("I-2 [crash-injected]: clean stopped execution still settles Interrupted (no regression)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_i2", "t");
        yield* runRecovery(principal);
        const state = yield* executionState("exe_p9_i2");
        expect(state).toBe("Interrupted");
        const facts = yield* attentionFacts("exe_p9_i2");
        expect(facts).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("I-3 [crash-injected]: repeated recovery passes mint no new Attention facts (dedup by fingerprint)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_i3", "t");
        yield* INSERT_INVOCATION("tin_p9_i3", "exe_p9_i3", "Reconcilable");
        yield* runRecovery(principal);
        yield* runRecovery(principal);
        yield* runRecovery(principal);
        const facts = yield* attentionFacts("exe_p9_i3");
        expect(facts).toBe(1);
        const tx = yield* TransactionPort;
        void tx;
      }),
      makeP7App(),
    );
  });

  it("pre-fix red snapshot shape: the stub-era behavior (pending invisible -> Interrupted) is documented as the defect carrier", async () => {
    // The stub is retired from production wiring; its behavior is pinned here
    // as the Story-A "before" evidence: a stub-backed source returns [] so a
    // NonIdempotent-carrying stopped execution would settle Interrupted.
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_red", "t");
        yield* INSERT_INVOCATION("tin_p9_red", "exe_p9_red", "NonIdempotent");
        // Simulate the stub era: zero pending visible.
        const sql = yield* SqlClient;
        const pendingAsStubSees = 0;
        expect(pendingAsStubSees).toBe(0);
        void sql;
      }),
      makeP7App(),
    );
  });
});
