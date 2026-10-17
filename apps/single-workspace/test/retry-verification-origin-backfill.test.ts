import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  splitStatements,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  createSchema44TestDatabase,
  type Schema44TestDatabase,
} from "../../../tests/support/schema44-database.js";
import { backfillRetryVerificationOrigins } from "../src/retry-verification-origin-backfill.js";

const fixtures: Schema44TestDatabase[] = [];

const seedProjectAndSourceRows = (db: DatabaseSync) => {
  const projectId = "prj_p45_backfill";
  const rootWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a455";
  const sessionId = "ses_p45_backfill";
  db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  db.prepare(
    `INSERT INTO projects (
       project_id,name,root_workspace_id,project_policy,project_policy_revision,
       default_configuration,environment_ref,resource_source_json,lifecycle,
       revision,created_at,updated_at
     ) VALUES (?, 'P45 backfill', ?, '{}', 0, '{}', 'local', '{}', 'Open',
       0, 't0', 't0')`,
  ).run(projectId, rootWorkspaceId);
  db.prepare(
    `INSERT INTO sessions (
       session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
     ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
  ).run(sessionId, rootWorkspaceId);
  db.prepare(
    `INSERT INTO workspaces (
       workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
       responsibility_revision,resource_boundary,resource_boundary_revision,
       agent_binding,primary_session_id,current_work_id,workspace_policy,
       workspace_policy_revision,revision,lifecycle,created_at,updated_at
     ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0,
       0, 'Active', 't0', 't0')`,
  ).run(rootWorkspaceId, projectId, sessionId);
  for (const workId of [
    "wrk_018f2b3c-4d5e-7abc-8def-01234567b451",
    "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
  ]) {
    db.prepare(
      `INSERT INTO works (
         work_id,project_id,workspace_id,objective,why,constraints,
         completion_expectation,verification_mission,provenance,lifecycle,
         revision,created_at,updated_at
       ) VALUES (?,?,?,'one bounded Work','test','[]','inspectable','{}','{}',
         'Open',0,'t0','t0')`,
    ).run(workId, projectId, rootWorkspaceId);
  }
  const insertVerification = db.prepare(
    `INSERT INTO verifications (
       verification_id,project_id,work_id,target_work_revision,owner_workspace_id,
       mission_snapshot,target_deliverables,target_artifact_versions,
       target_environment_revision,environment_snapshot_ref,
       verification_execution_ids,state,verdict,conclusion_reason,created_at,
       updated_at,summary_ref
     ) VALUES (?,?,?,?,?,'{}','[]','[]',NULL,NULL,?,?,?,?,?,?,'blob:p45')`,
  );
  for (const row of [
    [
      "ver_018f2b3c-4d5e-7abc-8def-01234567b452",
      "wrk_018f2b3c-4d5e-7abc-8def-01234567b451",
      '["exe_018f2b3c-4d5e-7abc-8def-01234567b453"]',
      "Concluded",
      "Unknown",
      "Orphaned",
    ],
    [
      "ver_018f2b3c-4d5e-7abc-8def-01234567b454",
      "wrk_018f2b3c-4d5e-7abc-8def-01234567b451",
      '["exe_018f2b3c-4d5e-7abc-8def-01234567b455"]',
      "Open",
      null,
      null,
    ],
    [
      "ver_018f2b3c-4d5e-7abc-8def-01234567b462",
      "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
      '["exe_018f2b3c-4d5e-7abc-8def-01234567b463"]',
      "Concluded",
      "Unknown",
      "Orphaned",
    ],
    [
      "ver_018f2b3c-4d5e-7abc-8def-01234567b464",
      "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
      '["exe_018f2b3c-4d5e-7abc-8def-01234567b465"]',
      "Open",
      null,
      null,
    ],
  ] as const) {
    insertVerification.run(
      row[0],
      projectId,
      row[1],
      0,
      rootWorkspaceId,
      row[2],
      row[3],
      row[4],
      row[5],
      "t0",
      "t0",
    );
  }
  db.exec("COMMIT");
  return { projectId };
};

const addReceipt = (
  db: DatabaseSync,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly workId: string;
    readonly sourceVerificationId: string;
    readonly successorVerificationId: string;
    readonly verifierExecutionId: string;
    readonly settledAt: string;
  },
) => {
  const result = {
    workId: input.workId,
    orphanedVerificationId: input.sourceVerificationId,
    successorVerificationId: input.successorVerificationId,
    verifierExecutionId: input.verifierExecutionId,
    state: "OrphanedAndRetried",
  };
  db.prepare(
    `INSERT INTO commands (
       command_id,project_id,semantic_request_fingerprint,schema_version,
       fingerprint_algorithm_version,resolution,result_json,terminal_error_json,
       created_at,settled_at
     ) VALUES (?,?,?,'1',1,'Committed',?,NULL,?,?)`,
  ).run(
    input.commandId,
    input.projectId,
    `fp:${input.commandId}`,
    JSON.stringify(result),
    input.settledAt,
    input.settledAt,
  );
};

const addExactEvents = (
  db: DatabaseSync,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly workId: string;
    readonly sourceVerificationId: string;
    readonly successorVerificationId: string;
    readonly settledAt: string;
  },
) => {
  const insert = db.prepare(
    `INSERT INTO domain_events (
       event_id,project_id,sequence,event_type,event_version,occurred_at,
       aggregate_ref,actor,caused_by_command_id,caused_by_event_id,
       correlation_ref,payload_json
     ) VALUES (?,?,? ,?,1,?,?,?, ?,NULL,NULL,?)`,
  );
  insert.run(
    `evt:${input.commandId}:1`,
    input.projectId,
    1,
    "VerificationConcluded",
    input.settledAt,
    input.sourceVerificationId,
    input.actor,
    input.commandId,
    JSON.stringify({
      verificationId: input.sourceVerificationId,
      workId: input.workId,
      targetWorkRevision: 0,
      verdict: "Unknown",
      conclusionReason: "Orphaned",
      evidenceRefs: [],
      summaryRef: "blob:p45",
    }),
  );
  insert.run(
    `evt:${input.commandId}:2`,
    input.projectId,
    2,
    "VerificationStarted",
    input.settledAt,
    input.successorVerificationId,
    input.actor,
    input.commandId,
    JSON.stringify({
      verificationId: input.successorVerificationId,
      workId: input.workId,
      targetWorkRevision: 0,
      missionDigest: "p45-mission",
    }),
  );
};

describe("P45 RetryVerification legacy backfill", () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  it("trusts only the exact decoded event pair and otherwise preserves the receipt as UnboundLegacy", async () => {
    const fixture = await createSchema44TestDatabase({
      prefix: ".p45-backfill-",
    });
    fixtures.push(fixture);
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      const { projectId } = seedProjectAndSourceRows(db);
      const proved = {
        commandId: "cmd_018f2b3c-4d5e-7abc-8def-01234567b456",
        projectId,
        workId: "wrk_018f2b3c-4d5e-7abc-8def-01234567b451",
        sourceVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b452",
        successorVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b454",
        verifierExecutionId: "exe_018f2b3c-4d5e-7abc-8def-01234567b455",
        settledAt: "2026-10-17T00:00:00.000Z",
      };
      const unbound = {
        commandId: "cmd_018f2b3c-4d5e-7abc-8def-01234567b466",
        projectId,
        workId: "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
        sourceVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b462",
        successorVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b464",
        verifierExecutionId: "exe_018f2b3c-4d5e-7abc-8def-01234567b465",
        settledAt: "2026-10-17T00:00:01.000Z",
      };
      addReceipt(db, proved);
      addExactEvents(db, { ...proved, actor: "user:legacy" });
      addReceipt(db, unbound);

      db.exec("BEGIN IMMEDIATE");
      for (const statement of splitStatements(
        P45_RETRY_VERIFICATION_ORIGIN_MIGRATION.sql,
      )) {
        db.exec(statement);
      }
      const backfill = backfillRetryVerificationOrigins(db);
      db.exec("PRAGMA user_version = 45; COMMIT");

      expect(backfill).toEqual({ origins: 1, unboundLegacy: 1 });
      expect(
        db
          .prepare(
            "SELECT command_id,actor,source_work_id,source_verification_id,successor_verification_id,successor_verifier_execution_id FROM retry_verification_origins",
          )
          .all(),
      ).toEqual([
        {
          command_id: proved.commandId,
          actor: "user:legacy",
          source_work_id: proved.workId,
          source_verification_id: proved.sourceVerificationId,
          successor_verification_id: proved.successorVerificationId,
          successor_verifier_execution_id: proved.verifierExecutionId,
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT command_id,project_id,source_work_id,source_verification_id,disposition,reason_code,created_at FROM retry_verification_legacy_dispositions",
          )
          .all(),
      ).toEqual([
        {
          command_id: unbound.commandId,
          project_id: projectId,
          source_work_id: unbound.workId,
          source_verification_id: unbound.sourceVerificationId,
          disposition: "UnboundLegacy",
          reason_code: "OriginEvidenceIncomplete",
          created_at: unbound.settledAt,
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT workspace_id,entry_key,kind,correlation_id,admitted_at,revision,updated_at FROM inbox_entries WHERE entry_key LIKE 'retry-verification-unbound:%'",
          )
          .all(),
      ).toEqual([
        {
          workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a455",
          entry_key: `retry-verification-unbound:${unbound.commandId}`,
          kind: "Governance",
          correlation_id: unbound.commandId,
          admitted_at: unbound.settledAt,
          revision: 1,
          updated_at: unbound.settledAt,
        },
      ]);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  }, 180_000);

  it("aborts the migration transaction when the current Parent recipient is unresolvable", async () => {
    const fixture = await createSchema44TestDatabase({
      prefix: ".p45-route-abort-",
    });
    fixtures.push(fixture);
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      const { projectId } = seedProjectAndSourceRows(db);
      const orphanOwnerId = "ws_018f2b3c-4d5e-7abc-8def-01234567a456";
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO sessions (
           session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
         ) VALUES ('ses_p45_orphan_owner','WorkspacePrimary',?,NULL,0,'t0')`,
      ).run(orphanOwnerId);
      db.prepare(
        `INSERT INTO workspaces (
           workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
           responsibility_revision,resource_boundary,resource_boundary_revision,
           agent_binding,primary_session_id,current_work_id,workspace_policy,
           workspace_policy_revision,revision,lifecycle,created_at,updated_at
         ) VALUES (?, ?, NULL, 'orphan-owner', '{}', 0, '{}', 0, '{}',
           'ses_p45_orphan_owner', NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
      ).run(orphanOwnerId, projectId);
      db.prepare("UPDATE works SET workspace_id = ? WHERE work_id = ?").run(
        orphanOwnerId,
        "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
      );
      db.prepare(
        "UPDATE verifications SET owner_workspace_id = ? WHERE work_id = ?",
      ).run(orphanOwnerId, "wrk_018f2b3c-4d5e-7abc-8def-01234567b461");
      db.exec("COMMIT");
      addReceipt(db, {
        commandId: "cmd_018f2b3c-4d5e-7abc-8def-01234567b467",
        projectId,
        workId: "wrk_018f2b3c-4d5e-7abc-8def-01234567b461",
        sourceVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b462",
        successorVerificationId: "ver_018f2b3c-4d5e-7abc-8def-01234567b464",
        verifierExecutionId: "exe_018f2b3c-4d5e-7abc-8def-01234567b465",
        settledAt: "2026-10-17T00:00:02.000Z",
      });
      db.exec("PRAGMA user_version = 44");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of splitStatements(
          P45_RETRY_VERIFICATION_ORIGIN_MIGRATION.sql,
        )) {
          db.exec(statement);
        }
        backfillRetryVerificationOrigins(db);
        db.exec("PRAGMA user_version = 45; COMMIT");
      } catch (cause) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw cause;
      }
    } catch (cause) {
      expect(String(cause)).toContain("no exact current Parent route");
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ).toBe(44);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'retry_verification_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  }, 180_000);
});
