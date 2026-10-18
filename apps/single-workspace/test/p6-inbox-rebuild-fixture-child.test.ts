import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createSchema48TestDatabase } from "../../../tests/support/schema44-database.js";

if (process.env.ARBOR_P6_FIXTURE_CHILD === "1") {
  it("creates and holds a private disposable schema-48 fixture for the operator process test", async () => {
    const filename = process.env.ARBOR_P6_FIXTURE_RESULT;
    if (filename === undefined) throw new Error("fixture result path missing");
    const fixture = await createSchema48TestDatabase();
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
      const projectId = "prj_p6_operator_fixture";
      const rootWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a455";
      const parentWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a457";
      const ownerWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a458";
      const commandId = "cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
      const admittedAt = "2026-10-18T00:00:00.000Z";
      db.prepare(
        `INSERT INTO projects (
          project_id,name,root_workspace_id,project_policy,project_policy_revision,
          default_configuration,environment_ref,resource_source_json,lifecycle,
          revision,created_at,updated_at
        ) VALUES (?, 'P6 operator fixture', ?, '{}', 0, '{}', 'local', '{}',
          'Open', 0, 't0', 't0')`,
      ).run(projectId, rootWorkspaceId);
      db.prepare(
        `INSERT INTO sessions (
          session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
        ) VALUES ('ses_p6_root','WorkspacePrimary',?,NULL,0,'t0')`,
      ).run(rootWorkspaceId);
      db.prepare(
        `INSERT INTO workspaces (
          workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
          responsibility_revision,resource_boundary,resource_boundary_revision,
          agent_binding,primary_session_id,current_work_id,workspace_policy,
          workspace_policy_revision,revision,lifecycle,created_at,updated_at
        ) VALUES (?, ?, NULL, 'root', '{}',0,'{}',0,'{}','ses_p6_root',
          NULL,'{}',0,0,'Active','t0','t0')`,
      ).run(rootWorkspaceId, projectId);
      for (const [workspaceId, sessionId, parentId] of [
        [parentWorkspaceId, "ses_p6_parent", rootWorkspaceId],
        [ownerWorkspaceId, "ses_p6_owner", parentWorkspaceId],
      ] as const) {
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
          ) VALUES (?, ?, ?, ?, '{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t0','t0')`,
        ).run(workspaceId, projectId, parentId, workspaceId, sessionId);
      }
      db.prepare(
        `INSERT INTO works (
          work_id,project_id,workspace_id,objective,why,constraints,
          completion_expectation,verification_mission,provenance,lifecycle,
          revision,created_at,updated_at
        ) VALUES ('wrk_p6_operator_fixture',?,?, 'legacy', 'legacy', '[]',
          'legacy','{}','{}','Open',0,'t0','t0')`,
      ).run(projectId, ownerWorkspaceId);
      db.prepare(
        `INSERT INTO verifications (
          verification_id,project_id,work_id,target_work_revision,owner_workspace_id,
          mission_snapshot,target_deliverables,target_artifact_versions,
          target_environment_revision,environment_snapshot_ref,
          verification_execution_ids,state,verdict,conclusion_reason,created_at,
          updated_at,summary_ref,criteria_results,snapshot_status
        ) VALUES ('ver_p6_operator_fixture',?,'wrk_p6_operator_fixture',0,?,'{}','[]','[]',
          NULL,NULL,'[]','Concluded','Unknown','Orphaned','t0','t0','blob:p6-operator',
          '[]','NotApplicableOrphaned')`,
      ).run(projectId, ownerWorkspaceId);
      db.prepare(
        `INSERT INTO commands (
          command_id,project_id,semantic_request_fingerprint,schema_version,
          fingerprint_algorithm_version,resolution,result_json,terminal_error_json,
          created_at,settled_at
        ) VALUES (?,?,?,'1',1,'Committed','{}',NULL,?,?)`,
      ).run(commandId, projectId, `fp:${commandId}`, admittedAt, admittedAt);
      db.prepare(
        `INSERT INTO retry_verification_legacy_dispositions (
          command_id,project_id,source_work_id,source_verification_id,
          disposition,reason_code,created_at
        ) VALUES (?,?,'wrk_p6_operator_fixture','ver_p6_operator_fixture',
          'UnboundLegacy','OriginEvidenceIncomplete',?)`,
      ).run(commandId, projectId, admittedAt);
      db.exec("COMMIT");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
    writeFileSync(
      filename,
      JSON.stringify({
        directory: fixture.directory,
        databaseFilename: fixture.databaseFilename,
        p39ReportFilename: fixture.p39ReportFilename,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }, 120_000);
} else {
  it.skip("is a private helper launched only by the operator process qualification", () => {});
}
