import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P2_MIGRATIONS, runMigrations } from "../src/index.js";
import { seedWorkspaceGraph } from "./support/seed-workspace.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

const PROJECT = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const WORKSPACE = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const SESSION = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";

const seed = seedWorkspaceGraph({
  projectId: PROJECT,
  workspaceId: WORKSPACE,
  sessionId: SESSION,
});

const insertMain = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
      [
        executionId,
        PROJECT,
        "workspace",
        WORKSPACE,
        "coordination",
        SESSION,
        "t",
      ],
    );
  });

const insertBound = (executionId: string, parent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,NULL,NULL,?,?,?,?,NULL,NULL,NULL,NULL)",
      [
        executionId,
        PROJECT,
        "execution_bound",
        WORKSPACE,
        parent,
        "m",
        SESSION,
        "t",
      ],
    );
  });

describe("DDL", () => {
  it("migrates to user_version 2", async () => {
    const version = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        return Number(rows[0]?.user_version);
      }),
    );
    expect(version).toBe(2);
  });

  it("rejects a second active main but allows ExecutionBound rows", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        yield* seed;
        yield* insertMain("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
        const secondMain = yield* insertMain(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
        ).pipe(Effect.exit);
        yield* insertBound(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
        );
        yield* insertBound(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789b2",
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
        );
        return { secondMain };
      }),
    );
    expect(result.secondMain._tag).toBe("Failure");
  });

  it("enforces binding/focus/settlement consistency checks", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const badFocus = yield* sql
          .unsafe(
            "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
            [
              "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
              PROJECT,
              "workspace",
              WORKSPACE,
              SESSION,
              "t",
            ],
          )
          .pipe(Effect.exit);
        const badSettlement = yield* sql
          .unsafe(
            "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,?,?,NULL)",
            [
              "exe_018f2b3c-4d5e-7abc-8def-0123456789c2",
              PROJECT,
              "workspace",
              WORKSPACE,
              "coordination",
              SESSION,
              "t",
              "Completed",
              "{}",
            ],
          )
          .pipe(Effect.exit);
        return { badFocus, badSettlement };
      }),
    );
    expect(result.badFocus._tag).toBe("Failure");
    expect(result.badSettlement._tag).toBe("Failure");
  });
});
