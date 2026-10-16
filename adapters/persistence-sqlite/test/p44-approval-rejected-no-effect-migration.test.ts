import { DatabaseSync } from "node:sqlite";
import {
  ExecutionId,
  LeaseGeneration,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { executableApprovalTerminalDenial } from "../../../packages/tool-runtime/src/index.js";
import { createSchema42TestDatabase } from "../../../tests/support/schema42-database.js";
import {
  layer,
  P40_TOOL_OBSERVATION_REPLAY_DDL,
  P43_BLOCKED_WORKEPISODE_MIGRATION,
  P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_p44_fixture";
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-01234567a441",
);
const sessionId = "ses_p44_fixture";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-01234567a441",
);
const workerId = "worker:p44-approval-denial";
const workerIncarnationId = "wic_p44-approval-denial";
const now = "2026-10-16T00:00:01.000Z";
const fence = {
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: parse(LeaseGeneration)(0),
};
const appFor = (filename: string) => {
  const sqlite = layer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const seedExecution = (filename: string): void => {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN");
    db.prepare(
      `INSERT INTO projects (
         project_id,name,root_workspace_id,project_policy,project_policy_revision,
         default_configuration,environment_ref,lifecycle,revision,created_at,updated_at
       ) VALUES (?, 'P44', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
    ).run(projectId, workspaceId);
    db.prepare(
      `INSERT INTO sessions (
         session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
       ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
    ).run(sessionId, workspaceId);
    db.prepare(
      `INSERT INTO workspaces (
         workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
         responsibility_revision,resource_boundary,resource_boundary_revision,
         agent_binding,primary_session_id,current_work_id,workspace_policy,
         workspace_policy_revision,revision,lifecycle,created_at,updated_at
       ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0,
         'Active', 't0', 't0')`,
    ).run(workspaceId, projectId, sessionId);
    db.prepare(
      `INSERT INTO executions (
         execution_id,project_id,binding_kind,workspace_id,mission,session_id,
         admitted_at,stop_requested_at,settlement_kind,settlement_json,settled_at
       ) VALUES (?, ?, 'execution_bound', ?, 'P44 fixture', ?, 't0', NULL, NULL, NULL, NULL)`,
    ).run(executionId, projectId, workspaceId, sessionId);
    db.prepare(
      `INSERT INTO execution_leases (
         execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at
       ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
    ).run(executionId, workerId, workerIncarnationId);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  } finally {
    db.close();
  }
};

const runP43ThenP44 = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([
          {
            id: P43_BLOCKED_WORKEPISODE_MIGRATION.migrationVersion,
            name: "blocked_work_episode_ledger_test_only",
            requiresUserVersion: 42,
            sql: P43_BLOCKED_WORKEPISODE_MIGRATION.sql,
          },
          P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
        ]),
        layer({ filename }),
      ),
    ),
  );

const guardSql = (filename: string, name: string): string => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        )
        .get(name) as { readonly sql: string }
    ).sql;
  } finally {
    db.close();
  }
};

const expectedP40Guard = (name: string): string => {
  const start = P40_TOOL_OBSERVATION_REPLAY_DDL.indexOf(
    `CREATE TRIGGER ${name}`,
  );
  const nextMarker =
    name === "tool_invocations_observation_insert_guard"
      ? "\nCREATE TRIGGER tool_invocations_observation_update_guard"
      : "\nCREATE TABLE tool_observation_replay_attention_facts";
  const end = P40_TOOL_OBSERVATION_REPLAY_DDL.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`Missing P40 guard ${name}`);
  return P40_TOOL_OBSERVATION_REPLAY_DDL.slice(start, end)
    .trim()
    .replaceAll(
      "'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',",
      "'InvocationAuthorityDenied','ApprovalRequired','ApprovalRejected','ApprovalNotFound',",
    )
    .replace(/;\s*$/u, "");
};

describe("P44 ApprovalRejected no-effect migration", () => {
  it("refuses direct application on schema 42 without changing the version or P40 guards", async () => {
    const fixture = await createSchema42TestDatabase();
    try {
      const before = [
        guardSql(
          fixture.databaseFilename,
          "tool_invocations_observation_insert_guard",
        ),
        guardSql(
          fixture.databaseFilename,
          "tool_invocations_observation_update_guard",
        ),
      ];
      const direct = Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            runMigrations([P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION]),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
      await expect(direct).rejects.toThrow(
        "migration 44 requires database user_version 43, found 42",
      );
      const db = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        const version = db.prepare("PRAGMA user_version").get() as {
          readonly user_version: number;
        };
        expect(version.user_version).toBe(42);
      } finally {
        db.close();
      }
      expect([
        guardSql(
          fixture.databaseFilename,
          "tool_invocations_observation_insert_guard",
        ),
        guardSql(
          fixture.databaseFilename,
          "tool_invocations_observation_update_guard",
        ),
      ]).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("applies only after isolated dormant P43, preserves P43 tables/relations, and changes exactly the P40 denial allowlist", async () => {
    const fixture = await createSchema42TestDatabase();
    try {
      const before = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      const foreignKeysBefore = before
        .prepare("PRAGMA foreign_key_list(tool_invocations)")
        .all();
      const indexesBefore = before
        .prepare("PRAGMA index_list(tool_invocations)")
        .all();
      before.close();

      expect(await runP43ThenP44(fixture.databaseFilename)).toBe(2);
      const after = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        const version = after.prepare("PRAGMA user_version").get() as {
          readonly user_version: number;
        };
        expect(version.user_version).toBe(44);
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          after.prepare("PRAGMA foreign_key_list(tool_invocations)").all(),
        ).toEqual(foreignKeysBefore);
        expect(
          after.prepare("PRAGMA index_list(tool_invocations)").all(),
        ).toEqual(indexesBefore);
        expect(
          after
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='work_blockers'",
            )
            .all(),
        ).toHaveLength(1);
        expect(
          after.prepare("PRAGMA foreign_key_check(work_blockers)").all(),
        ).toEqual([]);
      } finally {
        after.close();
      }
      for (const name of [
        "tool_invocations_observation_insert_guard",
        "tool_invocations_observation_update_guard",
      ]) {
        expect(guardSql(fixture.databaseFilename, name)).toBe(
          expectedP40Guard(name),
        );
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("records P38 Reject/Expire P4 denials on insert and update, while preserving other P40 guard failures", async () => {
    const fixture = await createSchema42TestDatabase();
    try {
      await runP43ThenP44(fixture.databaseFilename);
      seedExecution(fixture.databaseFilename);
      const insertedId = parse(ToolInvocationId)(
        "tin_018f2b3c-4d5e-7abc-8def-01234567a441",
      );
      const updatedId = parse(ToolInvocationId)(
        "tin_018f2b3c-4d5e-7abc-8def-01234567a442",
      );
      const invalidId = parse(ToolInvocationId)(
        "tin_018f2b3c-4d5e-7abc-8def-01234567a443",
      );
      const rejectedReason = executableApprovalTerminalDenial(
        { state: "Rejected", expiresAt: "2999-01-01T00:00:00.000Z" },
        now,
      );
      const expiredReason = executableApprovalTerminalDenial(
        { state: "Pending", expiresAt: "2000-01-01T00:00:00.000Z" },
        now,
      );
      expect(rejectedReason).toBe("ApprovalRejected");
      expect(expiredReason).toBe("ApprovalExpired");
      const invocation = (invocationId: typeof insertedId) => ({
        invocationId,
        executionId,
        workspaceId,
        toolName: "shell",
        toolVersion: "2",
        sideEffectSemantics: "Reconcilable" as const,
        argumentsJson: "{}",
        resolvedRegions: [] as const,
        approvalId: "eap:p44-test",
        intentAt: now,
      });
      const program = Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const store = yield* ToolInvocationStore;
        const sql = yield* SqlClient;
        const rejected = yield* tx.transact(
          store.recordNoEffectDenial(
            invocation(insertedId),
            rejectedReason as "ApprovalRejected",
            now,
            fence,
            now,
          ),
        );
        yield* tx.transact(
          store.recordIntent(invocation(updatedId), fence, now),
        );
        const expired = yield* tx.transact(
          store.recordNoEffectDenial(
            invocation(updatedId),
            expiredReason as "ApprovalExpired",
            now,
            fence,
            now,
          ),
        );
        const unknownReason = yield* Effect.exit(
          tx.transact(
            store.recordNoEffectDenial(
              invocation(invalidId),
              "NotAClosedDenialReason" as never,
              now,
              fence,
              now,
            ),
          ),
        );
        const canonicalGuard = yield* Effect.exit(
          sql.unsafe(
            `UPDATE tool_invocations SET settled_at = ?,
                 settlement_kind = 'Success', settlement_json = ?,
                 observation_format_version = 'p4-canonical-tool-observation-v1',
                 observation_json = ?, observation_sha256 = ?
               WHERE invocation_id = ?`,
            [
              now,
              JSON.stringify({ _tag: "Success" }),
              Buffer.from("{}", "utf8"),
              "a".repeat(64),
              updatedId,
            ],
          ),
        );
        const rows = yield* sql.unsafe<{
          readonly invocation_id: string;
          readonly settlement_kind: string | null;
          readonly settlement_json: string | null;
        }>(
          `SELECT invocation_id,settlement_kind,settlement_json
             FROM tool_invocations WHERE invocation_id IN (?,?) ORDER BY invocation_id`,
          [insertedId, updatedId],
        );
        return { rejected, expired, unknownReason, canonicalGuard, rows };
      });
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(program, appFor(fixture.databaseFilename)),
        ),
      );
      if (
        result.rejected === "ExecutionStopping" ||
        result.expired === "ExecutionStopping"
      ) {
        throw new Error("P44 fixture unexpectedly stopped before denial.");
      }
      expect(result.rejected.settlement).toEqual({
        _tag: "Denied",
        projectionVersion: 1,
        reasonCode: "ApprovalRejected",
      });
      expect(result.expired.settlement).toEqual({
        _tag: "Denied",
        projectionVersion: 1,
        reasonCode: "ApprovalExpired",
      });
      expect(Exit.isFailure(result.unknownReason)).toBe(true);
      expect(Exit.isFailure(result.canonicalGuard)).toBe(true);
      expect(
        result.rows.map(({ settlement_kind, settlement_json }) => ({
          settlement_kind,
          reasonCode:
            settlement_json === null
              ? null
              : (JSON.parse(settlement_json) as { readonly reasonCode: string })
                  .reasonCode,
        })),
      ).toEqual([
        { settlement_kind: "Denied", reasonCode: "ApprovalRejected" },
        { settlement_kind: "Denied", reasonCode: "ApprovalExpired" },
      ]);
    } finally {
      fixture.cleanup();
    }
  }, 180_000);
});
