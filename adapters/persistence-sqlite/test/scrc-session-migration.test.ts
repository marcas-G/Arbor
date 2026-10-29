import { ProjectId, parse, SessionId, WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P18_MIGRATIONS,
  P19_MIGRATIONS,
  P20_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");

const seedLegacySession = Effect.gen(function* () {
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,0,?)",
        [sessionId, "WorkspacePrimary", workspaceId, "t"],
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
        "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at) VALUES (?,?,?,?,?)",
        [
          sessionId,
          0,
          "Observation",
          JSON.stringify({
            observation: { text: "callRef:invented-from-text" },
          }),
          "t",
        ],
      );
    }),
  );
});

describe("SCRC migration 0019", () => {
  it("preserves v18 rows as explicit legacy evidence and is re-entrant", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P18_MIGRATIONS);
      yield* seedLegacySession;
      const firstRun = yield* runMigrations(P19_MIGRATIONS);
      const sql = yield* SqlClient;
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const columns = yield* sql.unsafe<{ name: string }>(
        "PRAGMA table_info(session_entries)",
      );
      const rows = yield* sql.unsafe<{
        item_type: string;
        schema_version: number;
        context_epoch: number | null;
        payload_json: string;
        source_ref: string | null;
      }>(
        "SELECT item_type, schema_version, context_epoch, payload_json, source_ref FROM session_entries WHERE session_id = ? ORDER BY sequence",
        [sessionId],
      );
      const secondRun = yield* runMigrations(P19_MIGRATIONS);
      return {
        firstRun,
        secondRun,
        version: Number(version[0]?.user_version),
        columns: columns.map((column) => column.name),
        rows,
      };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, layer({ filename: ":memory:" })),
    );
    expect(result.firstRun).toBe(1);
    expect(result.secondRun).toBe(0);
    expect(result.version).toBe(19);
    expect(result.columns).toEqual(
      expect.arrayContaining(["item_type", "schema_version", "context_epoch"]),
    );
    expect(result.rows).toEqual([
      {
        item_type: "LegacyObservation",
        schema_version: 1,
        context_epoch: null,
        payload_json: JSON.stringify({
          observation: { text: "callRef:invented-from-text" },
        }),
        source_ref: null,
      },
    ]);
  });

  it("adds the bounded overflow chain table once", async () => {
    const program = Effect.gen(function* () {
      const first = yield* runMigrations(P20_MIGRATIONS);
      const second = yield* runMigrations(P20_MIGRATIONS);
      const sql = yield* SqlClient;
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const tables = yield* sql.unsafe<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_loop_step_provider_turns'",
      );
      return { first, second, version: version[0]?.user_version, tables };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, layer({ filename: ":memory:" })),
    );
    expect(result.first).toBe(20);
    expect(result.second).toBe(0);
    expect(result.version).toBe(20);
    expect(result.tables).toHaveLength(1);
  });
});
