import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway } from "@arbor/application";
import {
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  AcceptanceRepository,
  Clock,
  TransactionPort,
  WorkRepository,
  WorkspacePlacementPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { acceptResultHandler } from "../src/control-actions.js";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  ProductionDaemonService,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-012345678a11");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a11",
);
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a12",
);
const parentSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-012345678a11",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-012345678a12");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-012345678a11",
);
const directories: string[] = [];

describe("MAC-P2 Parent Agent acceptance", () => {
  it("accepts one exact direct-child PASS result through an opaque result ref", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p2-accept-result-"));
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
                [projectId, "accept", parentWorkspaceId],
              );
              for (const [session, workspace] of [
                [parentSessionId, parentWorkspaceId],
                ["ses_018f2b3c-4d5e-7abc-8def-012345678a12", childWorkspaceId],
              ]) {
                yield* sql.unsafe(
                  "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
                  [session, workspace],
                );
              }
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'parent',?,0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
                [
                  parentWorkspaceId,
                  projectId,
                  JSON.stringify({ purpose: "own parent outcome" }),
                  parentSessionId,
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,'child',?,0,'{}',0,'{}','ses_018f2b3c-4d5e-7abc-8def-012345678a12',?,'{}',0,0,'Active','t','t')",
                [
                  childWorkspaceId,
                  projectId,
                  parentWorkspaceId,
                  JSON.stringify({ purpose: "own child research" }),
                  workId,
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,'child result','parent needs it','[]','verified result','{}','{}','Open',0,'t','t')",
                [workId, projectId, childWorkspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO verifications (verification_id, project_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, verdict, conclusion_reason, created_at, updated_at, summary_ref) VALUES ('ver_018f2b3c-4d5e-7abc-8def-012345678a12',?,?,0,?,'{}','[]','[]',NULL,NULL,'[]','Concluded','Pass',NULL,'t','t','blob-pass-summary')",
                [projectId, workId, childWorkspaceId],
              );
            }),
          );
          const placement = yield* WorkspacePlacementPort;
          const snapshot = yield* placement.list({
            rootWorkspaceId: parentWorkspaceId,
          });
          const resultRef =
            snapshot.directChildren[0]?.readyResults[0]?.resultRef;
          if (resultRef === undefined) {
            return yield* Effect.die("no ready child result ref");
          }
          const handler = acceptResultHandler({
            gateway: yield* CommandGateway,
            commandReceipts: {
              findResolution: () => Effect.succeed(Option.none()),
            } as never,
            acceptances: yield* AcceptanceRepository,
            works: yield* WorkRepository,
            tx: yield* TransactionPort,
            placement,
            clock: yield* Clock,
          });
          const outcome = yield* handler.handle({
            action: { _tag: "AcceptResult", resultRef },
            invocation: {
              providerTurnId: "ptn_accept_child" as never,
              outputPosition: 0,
              callRef: "accept-child",
              toolName: "accept_result",
              argumentsJson: JSON.stringify({ resultRef }),
            },
            execution: {
              executionId,
              projectId,
              workspaceId: parentWorkspaceId,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId: parentWorkspaceId,
                episode: {
                  _tag: "InboxEpisode",
                  entryKey: "child-result",
                  inputKind: "VerificationPass",
                },
              },
              sessionId: parentSessionId,
              admittedAt: "t",
              stopRequestedAt: null,
              state: { status: "Active", settlement: null },
            },
            context: {
              _tag: "System",
              principal: parse(Principal)("runtime:parent-agent"),
              causationRef: "child-result",
            },
          });
          const daemon = yield* ProductionDaemonService;
          yield* daemon.daemon.pollConsumers;
          yield* daemon.daemon.pollConsumers;
          const acceptances = yield* sql.unsafe<{
            work_id: string;
            verification_id: string;
          }>("SELECT work_id, verification_id FROM work_acceptances");
          const works = yield* sql.unsafe<{ lifecycle: string }>(
            "SELECT lifecycle FROM works WHERE work_id = ?",
            [workId],
          );
          const stale = yield* placement.resolveResultRef(
            parentWorkspaceId,
            resultRef,
          );
          return { outcome, acceptances, works, stale };
        }),
        app,
      ),
    );
    expect(result.outcome._tag).toBe("Observation");
    expect(result.acceptances).toEqual([
      {
        work_id: workId,
        verification_id: "ver_018f2b3c-4d5e-7abc-8def-012345678a12",
      },
    ]);
    expect(result.works).toEqual([{ lifecycle: "Completed" }]);
    expect(Option.isNone(result.stale)).toBe(true);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
