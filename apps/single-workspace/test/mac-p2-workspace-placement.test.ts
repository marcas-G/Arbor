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
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  TransactionPort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { assignWorkHandler } from "../src/control-actions.js";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-012345678a01");
const rootWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a01",
);
const directories: string[] = [];

const childId = (index: number): string =>
  `ws_018f2b3c-4d5e-7abc-8def-${String(12345678 + index).padStart(12, "0")}`;
const sessionId = (index: number): string =>
  `ses_018f2b3c-4d5e-7abc-8def-${String(12345678 + index).padStart(12, "0")}`;

describe("MAC-P2 WorkspacePlacementContext", () => {
  it("pages Active Direct Children, includes in-flight formation and rejects stale refs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p2-placement-"));
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
                [projectId, "placement", rootWorkspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_018f2b3c-4d5e-7abc-8def-012345678a01','WorkspacePrimary',?,NULL,0,'t')",
                [rootWorkspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root',?,0,'{}',0,'{}','ses_018f2b3c-4d5e-7abc-8def-012345678a01',NULL,'{}',0,0,'Active','t','t')",
                [
                  rootWorkspaceId,
                  projectId,
                  JSON.stringify({ purpose: "own the whole project" }),
                ],
              );
              for (let index = 0; index < 22; index += 1) {
                const workspace = childId(index);
                const session = sessionId(index);
                yield* sql.unsafe(
                  "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
                  [session, workspace],
                );
                yield* sql.unsafe(
                  "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
                  [
                    workspace,
                    projectId,
                    rootWorkspaceId,
                    `child-${String(index).padStart(2, "0")}`,
                    JSON.stringify({ purpose: `responsibility-${index}` }),
                    session,
                  ],
                );
              }
              yield* sql.unsafe(
                "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES ('fpr_018f2b3c-4d5e-7abc-8def-012345678a01',?,?,1,'Pending','t','t'), ('fpr_018f2b3c-4d5e-7abc-8def-012345678a02',?,?,1,'Rejected','t','t')",
                [
                  rootWorkspaceId,
                  JSON.stringify({
                    name: "pending-research",
                    rationale: "durable responsibility",
                    responsibilityDraft: { purpose: "pending research" },
                    resourceBoundaryDraft: {
                      basisResponsibilityRevision: 0,
                      addresses: [],
                    },
                    initialWork: {
                      objective: "first research outcome",
                      why: "seed",
                      constraints: [],
                      completionExpectation: "report",
                      verificationMission: {
                        goal: "verify",
                        criteria: [],
                        riskRequirements: [],
                      },
                    },
                  }),
                  rootWorkspaceId,
                  JSON.stringify({
                    name: "rejected",
                    rationale: "rejected",
                    responsibilityDraft: { purpose: "rejected" },
                    resourceBoundaryDraft: {
                      basisResponsibilityRevision: 0,
                      addresses: [],
                    },
                  }),
                ],
              );
            }),
          );
          const placement = yield* WorkspacePlacementPort;
          const first = yield* placement.list({ rootWorkspaceId });
          if (first.nextCursor === null) {
            return yield* Effect.die("first placement page has no cursor");
          }
          const second = yield* placement.list({
            rootWorkspaceId,
            cursor: first.nextCursor,
          });
          const queried = yield* placement.list({
            rootWorkspaceId,
            query: "child-21",
          });
          const staleRef = queried.directChildren[0]?.ref ?? "missing";
          const handler = assignWorkHandler({
            gateway: yield* CommandGateway,
            workspaces: yield* WorkspaceRepository,
            clock: yield* Clock,
            tx: yield* TransactionPort,
            placement,
          });
          const assigned = yield* handler.handle({
            action: {
              _tag: "AssignWork",
              targetWorkspaceRef: staleRef,
              objective: "bounded child outcome",
              why: "the existing child owns this responsibility",
              constraints: ["read only"],
              completionExpectation: "verified child report",
              verificationMission: {
                goal: "verify child report",
                criteria: [
                  {
                    criterionId: "report",
                    requirement: "report exists",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              reason: "assign to existing responsibility",
            },
            invocation: {
              providerTurnId: "ptn_child_assign" as never,
              outputPosition: 0,
              callRef: "child-assign",
              toolName: "assign_work",
              argumentsJson: JSON.stringify({ targetWorkspaceRef: staleRef }),
            },
            execution: {
              executionId: parse(ExecutionId)(
                "exe_018f2b3c-4d5e-7abc-8def-012345678a01",
              ),
              projectId,
              workspaceId: rootWorkspaceId,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId: rootWorkspaceId,
                episode: {
                  _tag: "ConversationResponseEpisode",
                  messageId:
                    "msg_018f2b3c-4d5e-7abc-8def-012345678a01" as never,
                  responseJobRevision: 0,
                },
              },
              sessionId: parse(SessionId)(
                "ses_018f2b3c-4d5e-7abc-8def-012345678a01",
              ),
              admittedAt: "t",
              stopRequestedAt: null,
              state: { status: "Active", settlement: null },
            },
            context: {
              _tag: "System",
              principal: parse(Principal)("runtime:placement-test"),
              causationRef: "placement-test",
            },
          });
          const assignedRows = yield* sql.unsafe<{
            workspace_id: string;
            objective: string;
          }>("SELECT workspace_id, objective FROM works");
          yield* sql.unsafe(
            "UPDATE workspaces SET revision = revision + 1 WHERE workspace_id = ?",
            [childId(21)],
          );
          const resolvedAfterRevision = yield* placement.resolveChildRef(
            rootWorkspaceId,
            staleRef,
          );
          return {
            first,
            second,
            queried,
            assigned,
            assignedRows,
            resolvedAfterRevision,
          };
        }),
        app,
      ),
    );
    expect(result.first.current).toMatchObject({
      ref: "current",
      name: "root",
      responsibilitySummary: "own the whole project",
    });
    expect(result.first.directChildren).toHaveLength(20);
    expect(result.first.nextCursor).toBe("pc_20");
    expect(result.second.directChildren).toHaveLength(2);
    expect(result.second.nextCursor).toBeNull();
    expect(result.queried.directChildren).toHaveLength(1);
    expect(result.queried.directChildren[0]?.name).toBe("child-21");
    expect(result.queried.directChildren[0]?.ref).toMatch(/^wref_/);
    expect(String(result.queried.directChildren[0]?.ref)).not.toContain("ws_");
    expect(result.assigned._tag).toBe("Observation");
    expect(result.assignedRows).toEqual([
      { workspace_id: childId(21), objective: "bounded child outcome" },
    ]);
    expect(result.first.inFlightFormations).toEqual([
      expect.objectContaining({
        proposedName: "pending-research",
        governanceState: "Pending",
        initialWorkSummary: "first research outcome",
      }),
    ]);
    expect(Option.isNone(result.resolvedAfterRevision)).toBe(true);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
