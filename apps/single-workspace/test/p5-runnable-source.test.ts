import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { RunnableWorkSource, TransactionPort } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { buildSliceLayer, P4_MIGRATIONS, runMigrations } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workA = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workB = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2");

const seed = (current: WorkId | null) =>
  Effect.gen(function* () {
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
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
            current,
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
        for (const workId of [workA, workB]) {
          yield* sql.unsafe(
            "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              workId,
              projectId,
              workspaceId,
              "o",
              "w",
              "[]",
              "done",
              "{}",
              "{}",
              "Open",
              0,
              "t",
              "t",
            ],
          );
        }
      }),
    );
  });

const classify = (current: WorkId | null) => {
  const dir = mkdtempSync(join(tmpdir(), "p5-rs-"));
  const app = buildSliceLayer({ databaseFile: join(dir, "slice.db") });
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P4_MIGRATIONS);
        yield* seed(current);
        const source = yield* RunnableWorkSource;
        return yield* source.classify(workspaceId);
      }),
      app,
    ) as unknown as Effect.Effect<
      {
        current: { _tag: string; value?: string };
        runnable: ReadonlyArray<string>;
      },
      unknown,
      never
    >,
  );
};

describe("P5 provisional RunnableWorkSource", () => {
  it("classifies the current Open work and the remaining open work", async () => {
    const result = await classify(workA);
    expect(result.current._tag).toBe("Some");
    if (result.current._tag === "Some") {
      expect(result.current.value).toBe(workA);
    }
    expect([...result.runnable]).toEqual([workB]);
  });

  it("treats an unset current work as None and returns all open work", async () => {
    const result = await classify(null);
    expect(result.current._tag).toBe("None");
    expect([...result.runnable].sort()).toEqual([workA, workB].sort());
  });
});

void TransactionPort;
