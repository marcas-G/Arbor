import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlApprovalRecord } from "@arbor/ports";
import {
  ControlApprovalStore,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlApprovalStoreLive,
  layer,
  P31_MIGRATIONS,
  P32_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const directories: string[] = [];

const currentControl: ControlApprovalRecord = {
  approvalId: "cap_current",
  projectId: "prj_mac4" as never,
  workspaceId: "ws_mac4" as never,
  executionId: "exe_mac4" as never,
  stableActionId: "core.control.assign-work",
  actionDigest: "current-control-digest",
  argumentsJson: '{"objective":"safe"}',
  targetRef: "ws_mac4",
  controlBasisDigest: "current-basis",
  state: "Pending",
  revision: 0,
  requestedAt: "2026-10-04T00:00:00.000Z",
  expiresAt: "2026-10-04T01:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  consumedAt: null,
};

describe("MAC-P4 unified ActionApproval migration", () => {
  it("fails unbound legacy approvals closed, removes old tables, and single-consumes current intents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p4-approvals-"));
    directories.push(directory);
    const base = layer({ filename: join(directory, "slice.db") });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(ControlApprovalStoreLive, base),
      Layer.provide(ToolInvocationStoreLive, base),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P31_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_mac4','p','ws_mac4','{}',0,'{}','local','Open',0,'t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_mac4','WorkspacePrimary','ws_mac4',NULL,0,'t')",
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_mac4','prj_mac4',NULL,'root','{}',0,'{}',0,'{}','ses_mac4',NULL,'{}',0,0,'Active','t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe_mac4','prj_mac4','workspace','ws_mac4','InboxEpisode','test',0,NULL,NULL,'ses_mac4','t',NULL,NULL,NULL,NULL)",
              );
              yield* sql.unsafe(
                "INSERT INTO control_action_approvals (approval_id, project_id, workspace_id, execution_id, stable_action_id, action_digest, arguments_json, target_ref, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at) VALUES ('cap_legacy','prj_mac4','ws_mac4','exe_mac4','core.control.assign-work','legacy-control','{}','ws_mac4','legacy-basis','Pending',0,'t','2999-01-01T00:00:00.000Z',NULL,NULL,NULL,NULL)",
              );
              yield* sql.unsafe(
                "INSERT INTO invocation_approvals (approval_id, tool_name, tool_version, action_digest, target_resource_space_ids_json, control_basis_digest, expires_at, consumed_by) VALUES ('apr_legacy','shell','1','legacy-exec','[\"filesystem\"]','legacy-basis','2999-01-01T00:00:00.000Z',NULL)",
              );
            }),
          );

          yield* runMigrations(P32_MIGRATIONS);
          yield* runMigrations(P32_MIGRATIONS);

          const migrated = yield* sql.unsafe<{
            approval_id: string;
            route_kind: string;
            state: string;
            binding_proven: number;
            source_state: string | null;
          }>(
            "SELECT approval_id, route_kind, state, binding_proven, source_state FROM action_approvals ORDER BY approval_id",
          );
          const oldTables = yield* sql.unsafe<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('control_action_approvals','invocation_approvals')",
          );

          const tx = yield* TransactionPort;
          const controls = yield* ControlApprovalStore;
          yield* tx.transact(controls.putPending(currentControl));
          const currentRows = yield* sql.unsafe<{
            subject_ref: string;
            action_version: string;
            binding_proven: number;
          }>(
            "SELECT subject_ref, action_version, binding_proven FROM action_approvals WHERE approval_id = 'cap_current'",
          );

          yield* sql.unsafe(
            "INSERT INTO action_approvals (approval_id, route_kind, project_id, workspace_id, execution_id, subject_ref, stable_action_id, action_version, side_effect_semantics, action_digest, arguments_json, target_ref, target_resource_space_ids_json, control_basis_digest, state, revision, requested_at, expires_at, decided_at, decided_by, decision_reason, consumed_at, consumed_by, binding_proven, source_state) VALUES ('apr_current','Executable','prj_mac4','ws_mac4','exe_mac4','Execution:exe_mac4','shell','1','Reconcilable','current-exec','{}','filesystem','[\"filesystem\"]','current-basis','Approved',1,'2026-10-04T00:00:00.000Z','2999-01-01T00:00:00.000Z','2026-10-04T00:00:01.000Z','user:approver',NULL,NULL,NULL,1,NULL)",
          );
          const invocations = yield* ToolInvocationStore;
          const first = yield* tx.transact(
            invocations.consumeApproval("apr_current", "tin_mac4_a" as never),
          );
          const second = yield* tx.transact(
            invocations.consumeApproval("apr_current", "tin_mac4_b" as never),
          );
          const executable = yield* sql.unsafe<{
            state: string;
            revision: number;
            consumed_by: string | null;
          }>(
            "SELECT state, revision, consumed_by FROM action_approvals WHERE approval_id = 'apr_current'",
          );
          return {
            migrated,
            oldTableCount: Number(oldTables[0]?.n ?? -1),
            current: currentRows[0],
            first,
            second,
            executable: executable[0],
          };
        }),
        app,
      ),
    );

    expect(result.migrated).toEqual([
      expect.objectContaining({
        approval_id: "apr_legacy",
        route_kind: "Executable",
        state: "Expired",
        binding_proven: 0,
        source_state: "Approved",
      }),
      expect.objectContaining({
        approval_id: "cap_legacy",
        route_kind: "Control",
        state: "Expired",
        binding_proven: 0,
        source_state: "Pending",
      }),
    ]);
    expect(result.oldTableCount).toBe(0);
    expect(result.current).toEqual({
      subject_ref: "Execution:exe_mac4",
      action_version: "1",
      binding_proven: 1,
    });
    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.executable).toEqual({
      state: "Consumed",
      revision: 2,
      consumed_by: "tin_mac4_a",
    });
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
