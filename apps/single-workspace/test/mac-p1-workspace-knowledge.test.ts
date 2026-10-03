import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectId, parse, WorkspaceId } from "@arbor/domain";
import { WorkspaceKnowledgePort } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789f1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f1",
);
const directories: string[] = [];

const seedWork = (
  workId: string,
  objective: string,
  verificationId: string,
  verdict: "Pass" | "Fail",
  accepted: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql
      .unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Completed',0,'t','t')",
        [
          workId,
          projectId,
          workspaceId,
          objective,
          "accepted knowledge test",
          "[]",
          `${objective} completed`,
          "{}",
          "{}",
        ],
      )
      .pipe(
        Effect.mapError((cause) => new Error("seed work failed", { cause })),
      );
    yield* sql
      .unsafe(
        "INSERT INTO verifications (verification_id, project_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, verdict, conclusion_reason, created_at, updated_at, summary_ref) VALUES (?,?,?,?,?,'{}','[]',?,NULL,NULL,'[]','Concluded',?,NULL,'t','t',?)",
        [
          verificationId,
          projectId,
          workId,
          0,
          workspaceId,
          "[]",
          verdict,
          `blob-summary-${verificationId}`,
        ],
      )
      .pipe(
        Effect.mapError(
          (cause) => new Error("seed verification failed", { cause }),
        ),
      );
    if (accepted) {
      yield* sql
        .unsafe(
          "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,'user:test','2026-10-04T00:00:00.000Z')",
          [`acc_${workId.slice(4)}`, projectId, workId, 0, verificationId],
        )
        .pipe(
          Effect.mapError(
            (cause) => new Error("seed acceptance failed", { cause }),
          ),
        );
    }
  });

describe("MAC-P1 WorkspaceKnowledgeView", () => {
  it("includes only accepted PASS outcomes and rebuilds deterministically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p1-knowledge-"));
    directories.push(directory);
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(directory, "slice.db"),
      projectId,
      providerTurns: [],
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,'{}',0,'{}','local','Open',0,'t','t')",
                [projectId, "knowledge", workspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_018f2b3c-4d5e-7abc-8def-0123456789f1','WorkspacePrimary',?,NULL,0,'t')",
                [workspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',0,'{}',0,'{}','ses_018f2b3c-4d5e-7abc-8def-0123456789f1',NULL,'{}',0,0,'Active','t','t')",
                [workspaceId, projectId],
              );
              yield* seedWork(
                "wrk_018f2b3c-4d5e-7abc-8def-0123456789f2",
                "accepted pass",
                "ver_018f2b3c-4d5e-7abc-8def-0123456789f2",
                "Pass",
                true,
              );
              yield* seedWork(
                "wrk_018f2b3c-4d5e-7abc-8def-0123456789f3",
                "unaccepted pass",
                "ver_018f2b3c-4d5e-7abc-8def-0123456789f3",
                "Pass",
                false,
              );
              yield* seedWork(
                "wrk_018f2b3c-4d5e-7abc-8def-0123456789f4",
                "accepted fail must not promote",
                "ver_018f2b3c-4d5e-7abc-8def-0123456789f4",
                "Fail",
                true,
              );
            }),
          );
          const knowledge = yield* WorkspaceKnowledgePort;
          const first = yield* knowledge.load(workspaceId);
          const second = yield* knowledge.load(workspaceId);
          return { first, second };
        }),
        app,
      ),
    );
    expect(result.first).toEqual(result.second);
    expect(result.first.fingerprint).toMatch(/^wkv_/);
    expect(result.first.entries).toEqual([
      expect.objectContaining({
        _tag: "AcceptedWorkOutcome",
        objective: "accepted pass",
        provenance: "CanonicalAcceptance",
        verificationSummaryRef:
          "blob-summary-ver_018f2b3c-4d5e-7abc-8def-0123456789f2",
      }),
    ]);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
