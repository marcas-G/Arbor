import { DatabaseSync } from "node:sqlite";
import {
  InboxProjectionStore,
  RetryVerificationOriginRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema44TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  InboxProjectionStoreLive,
  layer,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  RetryVerificationOriginRepositoryLive,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const runP45 = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P45_RETRY_VERIFICATION_ORIGIN_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename }),
      ),
    ),
  );

describe("P45 RetryVerification origin and UnboundLegacy schema", () => {
  it("preserves existing Inbox rows and adds exact revision/timestamp state", async () => {
    const fixture = await createSchema44TestDatabase();
    try {
      const before = new DatabaseSync(fixture.databaseFilename);
      let source: Record<string, unknown>;
      let sourceCount: number;
      try {
        const projectId = "prj_p45_inbox_fixture";
        const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a455";
        const sessionId = "ses_p45_inbox_fixture";
        before.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        before
          .prepare(
            `INSERT INTO projects (
             project_id,name,root_workspace_id,project_policy,project_policy_revision,
             default_configuration,environment_ref,resource_source_json,lifecycle,
             revision,created_at,updated_at
           ) VALUES (?, 'P45 fixture', ?, '{}', 0, '{}', 'local',
             '{"_tag":"TrustedProjectResources","resources":[]}',
             'Open', 0, 't0', 't0')`,
          )
          .run(projectId, workspaceId);
        before
          .prepare(
            `INSERT INTO sessions (
             session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
           ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
          )
          .run(sessionId, workspaceId);
        before
          .prepare(
            `INSERT INTO workspaces (
             workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
             responsibility_revision,resource_boundary,resource_boundary_revision,
             agent_binding,primary_session_id,current_work_id,workspace_policy,
             workspace_policy_revision,revision,lifecycle,created_at,updated_at
           ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0,
             0, 'Active', 't0', 't0')`,
          )
          .run(workspaceId, projectId, sessionId);
        before
          .prepare(
            `INSERT INTO inbox_entries
               (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at)
             VALUES (?, 'p45-row', 'Governance', 'preserved', 'corr-p45', '2026-10-17T00:00:00.000Z', NULL)`,
          )
          .run(workspaceId);
        source = before
          .prepare("SELECT * FROM inbox_entries WHERE entry_key = 'p45-row'")
          .get() as Record<string, unknown>;
        sourceCount = Number(
          (
            before
              .prepare("SELECT COUNT(*) AS count FROM inbox_entries")
              .get() as { count: number }
          ).count,
        );
        const foreignKeyTargets = before
          .prepare(
            `SELECT m.name AS table_name, f."table" AS referenced_table
               FROM sqlite_master m, pragma_foreign_key_list(m.name) f
              WHERE m.type = 'table' AND f."table" = 'inbox_entries'`,
          )
          .all();
        expect(foreignKeyTargets).toEqual([]);
        before.exec("COMMIT");
      } finally {
        if (before.isTransaction) before.exec("ROLLBACK");
        before.close();
      }

      expect(await runP45(fixture.databaseFilename)).toBe(1);
      expect(await runP45(fixture.databaseFilename)).toBe(0);

      const after = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          (
            after.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(45);
        const rows = after
          .prepare("SELECT * FROM inbox_entries")
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(sourceCount);
        expect(rows.find((row) => row.entry_key === "p45-row")).toEqual({
          ...source,
          revision: 1,
          updated_at: "2026-10-17T00:00:00.000Z",
        });
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          after
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inbox_unconsumed'",
            )
            .get(),
        ).toMatchObject({
          sql: expect.stringContaining("WHERE consumed_at IS NULL"),
        });
        const info = after
          .prepare("PRAGMA table_info(inbox_entries)")
          .all() as Array<{ name: string }>;
        expect(info.map((column) => column.name)).toEqual([
          "workspace_id",
          "entry_key",
          "kind",
          "summary",
          "correlation_id",
          "admitted_at",
          "consumed_at",
          "revision",
          "updated_at",
        ]);
        expect(
          after
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'retry_verification_%_immutable_%' ORDER BY name",
            )
            .all(),
        ).toHaveLength(4);
      } finally {
        after.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("rolls back all P45 DDL when a later statement fails", async () => {
    const fixture = await createSchema44TestDatabase();
    try {
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        db.exec(
          "DROP INDEX idx_inbox_unconsumed; CREATE TABLE p45_index_name_collision (value TEXT); CREATE INDEX idx_inbox_unconsumed ON p45_index_name_collision(value);",
        );
      } finally {
        db.close();
      }
      await expect(runP45(fixture.databaseFilename)).rejects.toThrow();
      const after = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          (
            after.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(44);
        expect(
          after
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('inbox_entries','inbox_entries_schema44','retry_verification_origins','retry_verification_legacy_dispositions') ORDER BY name",
            )
            .all(),
        ).toEqual([{ name: "inbox_entries" }]);
      } finally {
        after.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("moves one stable UnboundLegacy key once, preserves admission time, and treats a no-op as unchanged", async () => {
    const fixture = await createSchema44TestDatabase();
    try {
      expect(await runP45(fixture.databaseFilename)).toBe(1);
      const sqlite = layer({ filename: fixture.databaseFilename });
      const services = Layer.mergeAll(
        sqlite,
        Layer.provide(TransactionPortLive, sqlite),
        Layer.provide(InboxProjectionStoreLive, sqlite),
        Layer.provide(RetryVerificationOriginRepositoryLive, sqlite),
      );
      const entry = {
        recipientWorkspaceId:
          "ws_018f2b3c-4d5e-7abc-8def-01234567a455" as never,
        entryKey:
          "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a456",
        kind: "Governance" as const,
        summary:
          "A historical RetryVerification receipt has incomplete origin evidence.",
        correlationId: "cmd_018f2b3c-4d5e-7abc-8def-01234567a456",
        admittedAt: "2026-10-17T00:00:00.000Z",
      };
      const reconcile = (recipientWorkspaceId: string, updatedAt: string) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const transaction = yield* TransactionPort;
                const inbox = yield* InboxProjectionStore;
                yield* transaction.transact(
                  inbox.reconcileRetryVerificationUnboundLegacy(
                    {
                      ...entry,
                      recipientWorkspaceId: recipientWorkspaceId as never,
                    },
                    updatedAt,
                  ),
                );
              }),
              services,
            ),
          ),
        );
      await reconcile(entry.recipientWorkspaceId, "2026-10-17T00:00:01.000Z");
      const first = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      let firstRow: Record<string, unknown>;
      try {
        firstRow = first
          .prepare("SELECT * FROM inbox_entries WHERE entry_key = ?")
          .get(entry.entryKey) as Record<string, unknown>;
      } finally {
        first.close();
      }
      expect(firstRow).toMatchObject({
        workspace_id: entry.recipientWorkspaceId,
        admitted_at: entry.admittedAt,
        revision: 1,
        updated_at: entry.admittedAt,
      });

      await reconcile(entry.recipientWorkspaceId, "2026-10-17T00:00:02.000Z");
      const parentWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a457";
      await reconcile(parentWorkspaceId, "2026-10-17T00:00:03.000Z");
      const moved = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        const rows = moved
          .prepare(
            "SELECT workspace_id, admitted_at, revision, updated_at FROM inbox_entries WHERE entry_key = ?",
          )
          .all(entry.entryKey);
        expect(rows).toEqual([
          {
            workspace_id: parentWorkspaceId,
            admitted_at: entry.admittedAt,
            revision: 2,
            updated_at: "2026-10-17T00:00:03.000Z",
          },
        ]);
      } finally {
        moved.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("commits Parent route and same-key Inbox movement together or rolls both back", async () => {
    const fixture = await createSchema44TestDatabase();
    try {
      expect(await runP45(fixture.databaseFilename)).toBe(1);
      const projectId = "prj_p45_inbox_fixture";
      const rootWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a455";
      const parentWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a457";
      const ownerWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a458";
      const commandId = "cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
      const entryKey = `retry-verification-unbound:${commandId}`;
      const admittedAt = "2026-10-17T00:00:00.000Z";
      const sourceDb = new DatabaseSync(fixture.databaseFilename);
      try {
        sourceDb.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        sourceDb
          .prepare(
            `INSERT INTO projects (
             project_id,name,root_workspace_id,project_policy,project_policy_revision,
             default_configuration,environment_ref,resource_source_json,lifecycle,
             revision,created_at,updated_at
           ) VALUES (?, 'P45 route fixture', ?, '{}', 0, '{}', 'local', '{}',
             'Open', 0, 't0', 't0')`,
          )
          .run(projectId, rootWorkspaceId);
        sourceDb
          .prepare(
            `INSERT INTO sessions (
             session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
           ) VALUES ('ses_p45_root','WorkspacePrimary',?,NULL,0,'t0')`,
          )
          .run(rootWorkspaceId);
        sourceDb
          .prepare(
            `INSERT INTO workspaces (
             workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
             responsibility_revision,resource_boundary,resource_boundary_revision,
             agent_binding,primary_session_id,current_work_id,workspace_policy,
             workspace_policy_revision,revision,lifecycle,created_at,updated_at
           ) VALUES (?, ?, NULL, 'root', '{}',0,'{}',0,'{}','ses_p45_root',
             NULL,'{}',0,0,'Active','t0','t0')`,
          )
          .run(rootWorkspaceId, projectId);
        for (const [workspaceId, sessionId, parentId] of [
          [parentWorkspaceId, "ses_p45_parent", rootWorkspaceId],
          [ownerWorkspaceId, "ses_p45_owner", parentWorkspaceId],
        ] as const) {
          sourceDb
            .prepare(
              `INSERT INTO sessions (
               session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
             ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
            )
            .run(sessionId, workspaceId);
          sourceDb
            .prepare(
              `INSERT INTO workspaces (
               workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
               responsibility_revision,resource_boundary,resource_boundary_revision,
               agent_binding,primary_session_id,current_work_id,workspace_policy,
               workspace_policy_revision,revision,lifecycle,created_at,updated_at
             ) VALUES (?,?,?,?, '{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t0','t0')`,
            )
            .run(workspaceId, projectId, parentId, workspaceId, sessionId);
        }
        sourceDb
          .prepare(
            `INSERT INTO works (
             work_id,project_id,workspace_id,objective,why,constraints,
             completion_expectation,verification_mission,provenance,lifecycle,
             revision,created_at,updated_at
           ) VALUES ('wrk_p45_route',?,?, 'route', 'route', '[]','route','{}','{}',
             'Open',0,'t0','t0')`,
          )
          .run(projectId, ownerWorkspaceId);
        sourceDb
          .prepare(
            `INSERT INTO verifications (
             verification_id,project_id,work_id,target_work_revision,owner_workspace_id,
             mission_snapshot,target_deliverables,target_artifact_versions,
             target_environment_revision,environment_snapshot_ref,
             verification_execution_ids,state,verdict,conclusion_reason,created_at,
             updated_at,summary_ref
           ) VALUES ('ver_p45_route',?,'wrk_p45_route',0,?,'{}','[]','[]',NULL,NULL,
             '[]','Concluded','Unknown','Orphaned','t0','t0','blob:route')`,
          )
          .run(projectId, ownerWorkspaceId);
        sourceDb
          .prepare(
            `INSERT INTO commands (
             command_id,project_id,semantic_request_fingerprint,schema_version,
             fingerprint_algorithm_version,resolution,result_json,terminal_error_json,
             created_at,settled_at
           ) VALUES (?,?,?,'1',1,'Committed','{}',NULL,?,?)`,
          )
          .run(commandId, projectId, `fp:${commandId}`, admittedAt, admittedAt);
        sourceDb
          .prepare(
            `INSERT INTO retry_verification_legacy_dispositions (
             command_id,project_id,source_work_id,source_verification_id,
             disposition,reason_code,created_at
           ) VALUES (?,?,'wrk_p45_route','ver_p45_route',
             'UnboundLegacy','OriginEvidenceIncomplete',?)`,
          )
          .run(commandId, projectId, admittedAt);
        sourceDb.exec("COMMIT");
      } finally {
        sourceDb.close();
      }

      const sqlite = layer({ filename: fixture.databaseFilename });
      const services = Layer.mergeAll(
        sqlite,
        Layer.provide(TransactionPortLive, sqlite),
        Layer.provide(InboxProjectionStoreLive, sqlite),
        Layer.provide(RetryVerificationOriginRepositoryLive, sqlite),
      );
      const entry = {
        recipientWorkspaceId: parentWorkspaceId as never,
        entryKey,
        kind: "Governance" as const,
        summary:
          "A historical RetryVerification receipt has incomplete origin evidence.",
        correlationId: commandId,
        admittedAt,
      };
      const withTransaction = (failAfterMove: boolean): Promise<void> =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const transaction = yield* TransactionPort;
                const inbox = yield* InboxProjectionStore;
                const sql = yield* SqlClient;
                yield* transaction.transact(
                  inbox.reconcileRetryVerificationUnboundLegacy(
                    entry,
                    "2026-10-17T00:00:01.000Z",
                  ),
                );
                yield* transaction.transact(
                  Effect.gen(function* () {
                    yield* sql.unsafe(
                      "UPDATE workspaces SET parent_workspace_id = ? WHERE workspace_id = ?",
                      [rootWorkspaceId, ownerWorkspaceId],
                    );
                    yield* inbox.reconcileRetryVerificationUnboundLegacy(
                      {
                        ...entry,
                        recipientWorkspaceId: rootWorkspaceId as never,
                      },
                      "2026-10-17T00:00:02.000Z",
                    );
                    if (failAfterMove)
                      return yield* Effect.fail("InjectedRollback");
                  }),
                );
              }),
              services,
            ),
          ),
        );

      await expect(withTransaction(true)).rejects.toBe("InjectedRollback");
      const afterRollback = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          afterRollback
            .prepare(
              "SELECT parent_workspace_id FROM workspaces WHERE workspace_id = ?",
            )
            .get(ownerWorkspaceId),
        ).toEqual({ parent_workspace_id: parentWorkspaceId });
        expect(
          afterRollback
            .prepare(
              "SELECT workspace_id,revision,updated_at FROM inbox_entries WHERE entry_key = ?",
            )
            .get(entryKey),
        ).toEqual({
          workspace_id: parentWorkspaceId,
          revision: 1,
          updated_at: admittedAt,
        });
      } finally {
        afterRollback.close();
      }

      await withTransaction(false);
      const afterCommit = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          afterCommit
            .prepare(
              "SELECT parent_workspace_id FROM workspaces WHERE workspace_id = ?",
            )
            .get(ownerWorkspaceId),
        ).toEqual({ parent_workspace_id: rootWorkspaceId });
        expect(
          afterCommit
            .prepare(
              "SELECT workspace_id,admitted_at,revision,updated_at FROM inbox_entries WHERE entry_key = ?",
            )
            .get(entryKey),
        ).toEqual({
          workspace_id: rootWorkspaceId,
          admitted_at: admittedAt,
          revision: 2,
          updated_at: "2026-10-17T00:00:02.000Z",
        });
      } finally {
        afterCommit.close();
      }

      const corruptRetention = new DatabaseSync(fixture.databaseFilename);
      try {
        corruptRetention.exec(
          `PRAGMA foreign_keys = OFF;
           BEGIN IMMEDIATE;
           DELETE FROM commands WHERE command_id = '${commandId}';
           DELETE FROM domain_events;
           DELETE FROM inbox_entries WHERE entry_key = '${entryKey}';
           COMMIT;`,
        );
      } finally {
        corruptRetention.close();
      }
      const rebuiltCount = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const transaction = yield* TransactionPort;
              const origins = yield* RetryVerificationOriginRepository;
              return yield* transaction.transact(
                origins.rebuildUnboundLegacyInboxProjections(
                  "2026-10-17T00:00:04.000Z",
                ),
              );
            }),
            services,
          ),
        ),
      );
      expect(rebuiltCount).toBe(1);
      const rebuilt = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const transaction = yield* TransactionPort;
              const origins = yield* RetryVerificationOriginRepository;
              return yield* transaction.transact(
                origins.listCurrentUnboundLegacyInbox(rootWorkspaceId as never),
              );
            }),
            services,
          ),
        ),
      );
      expect(rebuilt).toMatchObject([
        {
          commandId,
          projectId,
          sourceWorkId: "wrk_p45_route",
          sourceVerificationId: "ver_p45_route",
          disposition: "UnboundLegacy",
          reasonCode: "OriginEvidenceIncomplete",
          recipientWorkspaceId: rootWorkspaceId,
          createdAt: admittedAt,
          revision: 1,
          updatedAt: admittedAt,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  }, 180_000);
});
