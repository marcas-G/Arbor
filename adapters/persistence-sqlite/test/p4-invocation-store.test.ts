import {
  ExecutionId,
  LeaseGeneration,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema42TestDatabase } from "../../../tests/support/schema42-database.js";
import {
  layer,
  P36_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionFence = {
  executionId,
  workerId: "worker:p4-invocation-store",
  workerIncarnationId: "incarnation:p4-invocation-store",
  fencingGeneration: parse(LeaseGeneration)(0),
};
const fenceNow = "2026-10-12T00:00:00.000Z";

const makeApp = (filename = ":memory:") => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?,?)",
        [
          executionId,
          executionFence.workerId,
          executionFence.workerIncarnationId,
          0,
          "2999-01-01T00:00:00.000Z",
          "t",
        ],
      );
    }),
  );
});

describe("P4 tool invocation store", () => {
  it("persists intent before settlement and detects a dangling intent", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P36_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      yield* tx.transact(
        store.recordIntent(
          {
            invocationId,
            executionId,
            workspaceId,
            toolName: "shell",
            toolVersion: "1",
            sideEffectSemantics: "Reconcilable",
            argumentsJson: '{"command":"ls"}',
            resolvedRegions: [],
            approvalId: null,
            intentAt: "t1",
          },
          executionFence,
          fenceNow,
        ),
      );
      const dangling = yield* tx.transact(store.findUnsettled(executionId));
      const firstSettlementApplied = yield* tx.transact(
        store.settle(
          invocationId,
          { _tag: "Success" },
          null,
          "t2",
          executionFence,
          fenceNow,
        ),
      );
      const duplicateSettlementApplied = yield* tx.transact(
        store.settle(
          invocationId,
          { _tag: "OutcomeUnknown", reconciliationRefs: [invocationId] },
          null,
          "t3",
          executionFence,
          fenceNow,
        ),
      );
      const after = yield* tx.transact(store.findUnsettled(executionId));
      const canonical = yield* tx.transact(store.findById(invocationId));
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
        "SELECT settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [invocationId],
      );
      return {
        dangling,
        after,
        firstSettlementApplied,
        duplicateSettlementApplied,
        canonical,
        kind: rows[0]?.settlement_kind,
      };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((r as { dangling: ReadonlyArray<unknown> }).dangling).toHaveLength(
      1,
    );
    expect((r as { after: ReadonlyArray<unknown> }).after).toHaveLength(0);
    expect(
      (r as { firstSettlementApplied: boolean }).firstSettlementApplied,
    ).toBe(true);
    expect(
      (r as { duplicateSettlementApplied: boolean }).duplicateSettlementApplied,
    ).toBe(false);
    expect(
      (r as { canonical: { value: { settlement: { _tag: string } } } })
        .canonical.value.settlement._tag,
    ).toBe("Success");
    expect((r as { kind: string | null }).kind).toBe("Success");
  });

  it("records DeniedUnbound for fresh/provisional denial, preserves Bound denial, and rolls back both denied claim edges", async () => {
    const database = await createSchema42TestDatabase();
    const app = makeApp(database.databaseFilename);
    const freshDeniedId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const provisionalId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const boundId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a4",
    );
    const rollbackInsertId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a5",
    );
    const bindingSha = "a".repeat(64);
    const denial = (id: typeof freshDeniedId) => ({
      invocationId: id,
      executionId,
      workspaceId,
      toolName: "shell",
      toolVersion: "1",
      sideEffectSemantics: "ReadOnly" as const,
      argumentsJson: "{}",
      resolvedRegions: [] as const,
      approvalId: null,
      intentAt: "t1",
    });
    const program = Effect.gen(function* () {
      yield* seed;
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      const sql = yield* SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = OFF");
      const activeFence = yield* sql.unsafe<{ readonly execution_id: string }>(
        `SELECT e.execution_id
           FROM executions e
           JOIN execution_leases l ON l.execution_id = e.execution_id
          WHERE e.execution_id = ? AND e.settled_at IS NULL
            AND l.worker_id = ? AND l.worker_incarnation_id = ?
            AND l.generation = ? AND l.expires_at > ?`,
        [
          executionId,
          executionFence.workerId,
          executionFence.workerIncarnationId,
          executionFence.fencingGeneration,
          fenceNow,
        ],
      );
      expect(activeFence).toHaveLength(1);

      const freshDenied = yield* tx.transact(
        store.recordNoEffectDenial(
          denial(freshDeniedId),
          "ResourceAdmissionDenied",
          fenceNow,
          executionFence,
          fenceNow,
        ),
      );

      yield* tx.transact(
        store.recordIntent(denial(provisionalId), executionFence, fenceNow),
      );
      const provisionalRollback = yield* Effect.flip(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordNoEffectDenial(
              denial(provisionalId),
              "ResourceAdmissionDenied",
              fenceNow,
              executionFence,
              fenceNow,
            );
            return yield* Effect.fail("simulated-precommit-crash");
          }),
        ),
      );
      const provisionalAfterRollback = yield* tx.transact(
        store.findById(provisionalId),
      );
      const provisionalDenied = yield* tx.transact(
        store.recordNoEffectDenial(
          denial(provisionalId),
          "ResourceAdmissionDenied",
          fenceNow,
          executionFence,
          fenceNow,
        ),
      );

      yield* tx.transact(
        store.recordIntent(denial(boundId), executionFence, fenceNow),
      );
      yield* sql.unsafe(
        `INSERT INTO tool_invocation_recovery_bindings (
           invocation_id,binding_version,canonical_binding_json,binding_sha256,created_at
         ) VALUES (?,1,'{}',?,'t1')`,
        [boundId, bindingSha],
      );
      yield* sql.unsafe(
        `UPDATE tool_invocations SET recovery_binding_state='Bound',
           recovery_binding_sha256=? WHERE invocation_id=?`,
        [bindingSha, boundId],
      );
      yield* sql.unsafe(
        `INSERT INTO tool_invocation_effect_attempts (
           invocation_id,attempt_no,admission_state,tool_definition_hash,
           side_effect_semantics,profile_id,profile_version,profile_hash,
           profile_protocol,effect_key,binding_sha256,admitted_at,
           admission_source,admission_time_precision
         ) VALUES (?,0,'NotAdmitted',NULL,'ReadOnly',NULL,NULL,NULL,NULL,NULL,
                   ?,NULL,'P39Claim','NotAdmitted')`,
        [boundId, bindingSha],
      );
      const boundDenied = yield* tx.transact(
        store.recordNoEffectDenial(
          denial(boundId),
          "ResourceAdmissionDenied",
          fenceNow,
          executionFence,
          fenceNow,
        ),
      );

      const insertRollback = yield* Effect.flip(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordNoEffectDenial(
              denial(rollbackInsertId),
              "ResourceAdmissionDenied",
              fenceNow,
              executionFence,
              fenceNow,
            );
            return yield* Effect.fail("simulated-precommit-crash");
          }),
        ),
      );
      const rolledBackInsert = yield* tx.transact(
        store.findById(rollbackInsertId),
      );
      const rows = yield* sql.unsafe<{
        readonly invocation_id: string;
        readonly recovery_binding_state: string;
        readonly recovery_binding_sha256: string | null;
        readonly settlement_kind: string | null;
        readonly settlement_provenance: string | null;
        readonly result_ref: string | null;
      }>(
        `SELECT invocation_id,recovery_binding_state,recovery_binding_sha256,
                settlement_kind,settlement_provenance,result_ref
           FROM tool_invocations
          WHERE invocation_id IN (?,?,?) ORDER BY invocation_id`,
        [freshDeniedId, provisionalId, boundId],
      );
      return {
        freshDenied,
        provisionalRollback,
        provisionalAfterRollback,
        provisionalDenied,
        boundDenied,
        insertRollback,
        rolledBackInsert,
        rows,
      };
    });
    try {
      const result = await Effect.runPromise(
        Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
      );
      const value = result as {
        freshDenied: { readonly settlement: { readonly _tag: string } };
        provisionalRollback: string;
        provisionalAfterRollback: {
          readonly value: { readonly settlement: unknown };
        };
        provisionalDenied: { readonly settlement: { readonly _tag: string } };
        boundDenied: { readonly settlement: { readonly _tag: string } };
        insertRollback: string;
        rolledBackInsert: { readonly _tag: string };
        rows: ReadonlyArray<{
          readonly invocation_id: string;
          readonly recovery_binding_state: string;
          readonly recovery_binding_sha256: string | null;
          readonly settlement_kind: string | null;
          readonly settlement_provenance: string | null;
          readonly result_ref: string | null;
        }>;
      };
      expect(value.freshDenied.settlement._tag).toBe("Denied");
      expect(value.provisionalRollback).toBe("simulated-precommit-crash");
      expect(value.provisionalAfterRollback.value.settlement).toBeNull();
      expect(value.provisionalDenied.settlement._tag).toBe("Denied");
      expect(value.boundDenied.settlement._tag).toBe("Denied");
      expect(value.insertRollback).toBe("simulated-precommit-crash");
      expect(value.rolledBackInsert._tag).toBe("None");
      expect(value.rows).toEqual([
        {
          invocation_id: "tin_018f2b3c-4d5e-7abc-8def-0123456789a2",
          recovery_binding_state: "DeniedUnbound",
          recovery_binding_sha256: null,
          settlement_kind: "Denied",
          settlement_provenance: "Ordinary",
          result_ref: null,
        },
        {
          invocation_id: "tin_018f2b3c-4d5e-7abc-8def-0123456789a3",
          recovery_binding_state: "DeniedUnbound",
          recovery_binding_sha256: null,
          settlement_kind: "Denied",
          settlement_provenance: "Ordinary",
          result_ref: null,
        },
        {
          invocation_id: "tin_018f2b3c-4d5e-7abc-8def-0123456789a4",
          recovery_binding_state: "Bound",
          recovery_binding_sha256: bindingSha,
          settlement_kind: "Denied",
          settlement_provenance: "Ordinary",
          result_ref: null,
        },
      ]);
    } finally {
      database.cleanup();
    }
  });
});
