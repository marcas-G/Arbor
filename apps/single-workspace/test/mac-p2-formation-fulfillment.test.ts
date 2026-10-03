import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway, semanticRequestFingerprint } from "@arbor/application";
import {
  Actor,
  CommandId,
  FormationProposalId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  ProductionDaemonService,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-012345678a21");
const rootWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345678a21",
);
const proposalId = parse(FormationProposalId)(
  "fpr_018f2b3c-4d5e-7abc-8def-012345678a22",
);
const principal = parse(Principal)("user:mac-p2-governor");
const actor = parse(Actor)("user:mac-p2-governor");
const directories: string[] = [];

describe("MAC-P2 formation fulfillment", () => {
  it("separates Approved from asynchronously Applied and replays without duplicates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mac-p2-formation-"));
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
                [projectId, "formation", rootWorkspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_018f2b3c-4d5e-7abc-8def-012345678a21','WorkspacePrimary',?,NULL,0,'t')",
                [rootWorkspaceId],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root',?,0,?,0,'{}','ses_018f2b3c-4d5e-7abc-8def-012345678a21',NULL,'{}',0,0,'Active','t','t')",
                [
                  rootWorkspaceId,
                  projectId,
                  JSON.stringify({
                    purpose: "own root",
                    ownedResponsibilities: [],
                    obligations: [],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  }),
                  JSON.stringify({
                    basisResponsibilityRevision: 0,
                    addresses: [],
                  }),
                ],
              );
              const proposal = {
                name: "research",
                rationale: "long-lived responsibility",
                responsibilityDraft: {
                  purpose: "own research",
                  ownedResponsibilities: [],
                  obligations: [],
                  includes: [],
                  excludes: [],
                  interfaces: [],
                },
                resourceBoundaryDraft: {
                  basisResponsibilityRevision: 0,
                  addresses: [],
                },
                initialWork: {
                  objective: "produce first research report",
                  why: "bootstrap",
                  constraints: ["do not place real orders"],
                  completionExpectation: "verified report",
                  verificationMission: {
                    goal: "verify report",
                    criteria: [
                      {
                        criterionId: "report",
                        requirement: "report exists",
                        required: true,
                      },
                    ],
                    riskRequirements: ["no real orders"],
                  },
                },
              };
              yield* sql.unsafe(
                "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES (?,?,?,1,'Pending','t','t')",
                [proposalId, rootWorkspaceId, JSON.stringify(proposal)],
              );
              yield* sql.unsafe(
                "INSERT INTO formation_fulfillments (proposal_id, proposal_revision, expected_child_workspace_id, expected_initial_work_id, state, typed_block, last_attempt_at, revision) VALUES (?,1,'ws_018f2b3c-4d5e-7abc-8def-012345678a22','wrk_018f2b3c-4d5e-7abc-8def-012345678a22','AwaitingDecision',NULL,NULL,0)",
                [proposalId],
              );
              yield* sql.unsafe(
                "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, admitted_at, consumed_at) VALUES (?,?,'Governance','awaiting','t',NULL)",
                [rootWorkspaceId, `gov:${proposalId}:1`],
              );
            }),
          );
          const gateway = yield* CommandGateway;
          const commandId = parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-012345678a22",
          );
          const payload = {
            proposalId,
            expectedProposalRevision: 1,
            outcome: { _tag: "Approve" as const },
          };
          const decision = yield* gateway.execute(
            {
              commandType: "RecordDecision",
              commandId,
              projectId,
              actor,
              issuedAt: "2026-10-04T00:00:00.000Z",
              payload,
            },
            { _tag: "External", principal },
            {
              _tag: "RecordDecisionAuthority",
              principal,
              commandId,
              semanticRequestFingerprint: semanticRequestFingerprint({
                commandType: "RecordDecision",
                projectId,
                actor,
                schemaVersion: "1",
                payload,
              }),
              projectId,
              proposalId,
            },
          );
          const before = yield* sql.unsafe<{ state: string }>(
            "SELECT state FROM formation_fulfillments WHERE proposal_id = ?",
            [proposalId],
          );
          const daemon = yield* ProductionDaemonService;
          yield* daemon.daemon.pollConsumers;
          yield* daemon.daemon.pollConsumers;
          const after = yield* sql.unsafe<{
            state: string;
            revision: number;
            typed_block: string | null;
          }>(
            "SELECT state, revision, typed_block FROM formation_fulfillments WHERE proposal_id = ?",
            [proposalId],
          );
          const counts = yield* sql.unsafe<{
            workspaces: number;
            works: number;
          }>(
            "SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM works) AS works",
          );
          return { decision: decision.resolution._tag, before, after, counts };
        }),
        app,
      ),
    );
    expect(result.decision).toBe("Committed");
    expect(result.before).toEqual([{ state: "PendingApplication" }]);
    expect(result.after).toEqual([
      { state: "Applied", revision: 3, typed_block: null },
    ]);
    expect(result.counts).toEqual([{ workspaces: 2, works: 1 }]);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
