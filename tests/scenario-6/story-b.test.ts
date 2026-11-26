import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P35_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeProposeChildWorkspaceHandler } from "../../apps/single-workspace/src/legacy-directive-handlers.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  ContextEpochNumber,
  makeWorkspacePolicy,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  TransactionPort,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import {
  seedCurrentOpenWork,
  workEpisode,
} from "../support/execution-episode-fixtures.js";
import {
  CHILD_B_STORY_WORK,
  CHILD_B1,
  CHILD_B1_SESSION,
  countRows,
  EXE_CHILD,
  executionContext,
  executionOf,
  FORCED_CHILD,
  FORCED_SESSION,
  idFromText,
  inboxOf,
  makeAcceptanceApp,
  PRINCIPAL,
  PROJECT,
  proposalDraft,
  ROOT,
  runAcceptance,
  SIBLING_CREATE_COMMAND,
  scalar,
  seedLineage,
  seedProject,
  ses,
  ws,
} from "./support.js";

describe("-acceptance", () => {
  it("Story B: deep autonomous formation is gate-free and ceiling-guarded", async () => {
    const CHILD_B_STORY = ws("b1");
    const CHILD_B_STORY_SESSION = ses("b1");
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_B_STORY,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_STORY_SESSION,
        },
        {
          workspaceId: CHILD_B1,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B1_SESSION,
        },
      ]);
      yield* seedCurrentOpenWork(PROJECT, CHILD_B_STORY, CHILD_B_STORY_WORK);
      const worksBeforeFormation = yield* countRows("works");

      const handler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const outcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("grandchild-deep"),
        },
        execution: executionOf(
          EXE_CHILD,
          CHILD_B_STORY,
          null,
          workEpisode(CHILD_B_STORY_WORK),
        ),
        context: executionContext(EXE_CHILD),
      });
      const grandchildId = parse(WorkspaceId)(
        outcome._tag === "Observation"
          ? (idFromText(outcome.observation.text, "ws_") ?? "")
          : "",
      );
      const grandchildParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [grandchildId],
      );
      const childParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [CHILD_B_STORY],
      );
      const directCounts = {
        workspaces: yield* countRows("workspaces"),
        worksAdded: (yield* countRows("works")) - worksBeforeFormation,
        proposals: yield* countRows("formation_proposals"),
      };
      const parentWorkOwner = yield* scalar<string | null>(
        "SELECT workspace_id AS value FROM works WHERE work_id = ?",
        [CHILD_B_STORY_WORK],
      );
      const sql = yield* SqlClient;
      const grandchildWorkRows = yield* sql.unsafe<{
        work_id: string;
        workspace_id: string;
      }>("SELECT work_id, workspace_id FROM works WHERE workspace_id = ?", [
        grandchildId,
      ]);
      const childInbox = yield* inboxOf(CHILD_B_STORY);

      const ceilingOutcome = yield* handler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("grandchild-escape", [
            { _tag: "FileTree", path: "outside/parent/boundary" },
          ]),
        },
        execution: executionOf(
          EXE_CHILD,
          CHILD_B_STORY,
          null,
          workEpisode(CHILD_B_STORY_WORK),
        ),
        context: executionContext(EXE_CHILD),
      });
      const afterCeilingWorkspaces = yield* countRows("workspaces");
      const afterCeilingProposals = yield* countRows("formation_proposals");

      const gw = yield* CommandGateway;
      const forcedPayload = {
        parentWorkspaceId: CHILD_B1,
        workspaceId: FORCED_CHILD,
        primarySession: {
          sessionId: FORCED_SESSION,
          contextEpoch: parse(ContextEpochNumber)(0),
        },
        name: "sibling-forced-child",
        responsibilityDefinition: {
          purpose: "p",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: parse(ResponsibilityRevision)(1),
        resourceBoundary: {
          basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
          addresses: [],
        },
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        agentBinding: responsibilityBound(FORCED_CHILD),
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
      };
      const siblingReceipt = yield* gw.execute(
        {
          commandType: "CreateChildWorkspace",
          commandId: SIBLING_CREATE_COMMAND,
          projectId: PROJECT,
          actor: PRINCIPAL as never,
          issuedAt: "t",
          payload: forcedPayload,
        },
        executionContext(EXE_CHILD),
        {
          _tag: "CreateChildWorkspaceAuthority",
          principal: PRINCIPAL,
          commandId: SIBLING_CREATE_COMMAND,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "CreateChildWorkspace",
            projectId: PROJECT,
            actor: PRINCIPAL as never,
            schemaVersion: "1",
            payload: forcedPayload,
          }),
          projectId: PROJECT,
          parentWorkspaceId: CHILD_B_STORY,
        },
      );
      const afterSiblingWorkspaces = yield* countRows("workspaces");

      return {
        outcome,
        grandchildId,
        grandchildParent,
        childParent,
        childId: CHILD_B_STORY,
        directCounts,
        parentWorkOwner,
        grandchildWorkRows,
        childInbox,
        ceilingOutcome,
        afterCeilingWorkspaces,
        afterCeilingProposals,
        siblingReceipt,
        afterSiblingWorkspaces,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.outcome._tag).toBe("Observation");
    expect(result.childParent).toBe(ROOT);
    expect(result.grandchildParent).toBe(result.childId);
    expect(result.directCounts).toEqual({
      workspaces: 4,
      worksAdded: 1,
      proposals: 0,
    });
    expect(result.parentWorkOwner).toBe(result.childId);
    expect(result.grandchildWorkRows).toHaveLength(1);
    expect(result.grandchildWorkRows[0]?.workspace_id).toBe(
      result.grandchildId,
    );
    expect(result.grandchildWorkRows[0]?.work_id).not.toBe(CHILD_B_STORY_WORK);
    expect(result.childInbox).toHaveLength(0);

    expect(result.ceilingOutcome._tag).toBe("Observation");
    if (result.ceilingOutcome._tag === "Observation") {
      expect(result.ceilingOutcome.observation.text).toContain(
        "AuthorityDenied",
      );
      expect(result.ceilingOutcome.observation.text).toContain(
        "escapes parent boundary",
      );
    }
    expect(result.afterCeilingWorkspaces).toBe(4);
    expect(result.afterCeilingProposals).toBe(0);

    expect(result.siblingReceipt.resolution._tag).toBe("TerminalRejected");
    if (result.siblingReceipt.resolution._tag === "TerminalRejected") {
      expect(result.siblingReceipt.resolution.error._tag).toBe(
        "AuthorityDenied",
      );
      if (result.siblingReceipt.resolution.error._tag === "AuthorityDenied") {
        expect(result.siblingReceipt.resolution.error.reason).toContain(
          "target mismatch",
        );
      }
    }
    expect(result.afterSiblingWorkspaces).toBe(4);
  });
});
