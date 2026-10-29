import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  layer,
  P30_MIGRATIONS,
  P31_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const directories: string[] = [];

describe("MAC-P2 formation fulfillment migration", () => {
  it("backfills governance state without claiming application success and is re-entrant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p2-fulfillment-"));
    directories.push(directory);
    const app = layer({ filename: join(directory, "slice.db") });
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P30_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_m','p','ws_m','{}',0,'{}','local','Open',0,'t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_m','WorkspacePrimary','ws_m',NULL,0,'t')",
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_m','prj_m',NULL,'root','{}',0,'{}',0,'{}','ses_m',NULL,'{}',0,0,'Active','t','t')",
              );
              for (const [suffix, state] of [
                ["1", "Pending"],
                ["2", "Approved"],
                ["3", "Rejected"],
              ] as const) {
                yield* sql.unsafe(
                  "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES (?, 'ws_m', ?, 1, ?, 't', 't')",
                  [
                    `fpr_00000000-0000-7000-8000-00000000000${suffix}`,
                    JSON.stringify({
                      name: `p${suffix}`,
                      responsibilityDraft: { purpose: `r${suffix}` },
                      resourceBoundaryDraft: { addresses: [] },
                      ...(suffix === "2"
                        ? { initialWork: { objective: "initial" } }
                        : {}),
                    }),
                    state,
                  ],
                );
              }
            }),
          );
          yield* runMigrations(P31_MIGRATIONS);
          yield* runMigrations(P31_MIGRATIONS);
          return yield* sql.unsafe<{
            proposal_id: string;
            expected_child_workspace_id: string;
            expected_initial_work_id: string | null;
            state: string;
            typed_block: string | null;
          }>(
            "SELECT proposal_id, expected_child_workspace_id, expected_initial_work_id, state, typed_block FROM formation_fulfillments ORDER BY proposal_id",
          );
        }),
        app,
      ),
    );
    expect(rows.map((row) => row.state)).toEqual([
      "AwaitingDecision",
      "PendingApplication",
      "Blocked",
    ]);
    expect(rows[0]?.expected_child_workspace_id).toBe(
      "ws_00000000-0000-7000-8000-000000000001",
    );
    expect(rows[1]?.expected_initial_work_id).toBe(
      "wrk_00000000-0000-7000-8000-000000000002",
    );
    expect(rows[2]?.typed_block).toBe("FormationRejected");
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
