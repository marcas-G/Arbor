import {
  Actor,
  CommandId,
  ContextEpochNumber,
  FormationProposalId,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  type Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeCreateChildWorkspaceHandler } from "../src/commands/create-child-workspace.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a2");
const actor = parse(Actor)("user:formation-test");
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2");
const address = { _tag: "FileTree" as const, path: "src/child" };

describe("CreateChildWorkspace delegated activation intent", () => {
  it("persists exact decision provenance and frozen revisions with the Child", async () => {
    const inserted: unknown[] = [];
    const handler = makeCreateChildWorkspaceHandler({
      workspaces: {
        findById: () =>
          Effect.succeed(
            Option.some({
              projectId,
              lifecycle: "Active",
              revision: parse(Revision)(7),
              resourceBoundaryRevision: parse(ResourceBoundaryRevision)(9),
            } as unknown as Workspace),
          ),
        create: () => Effect.void,
      } as never,
      sessions: { create: () => Effect.void } as never,
      activations: {
        insertPending: (intent: unknown) => {
          inserted.push(intent);
          return Effect.void;
        },
      } as never,
    });
    const approval = {
      delegationSourceId:
        "formation:fpr_018f2b3c-4d5e-7abc-8def-0123456789a1:3",
      formationProposalId: parse(FormationProposalId)(
        "fpr_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
      formationProposalRevision: 3,
      addresses: [address],
      approvedBy: actor,
      causedByCommandId: parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
      ),
      parentWorkspaceId,
      expectedParentWorkspaceRevision: parse(Revision)(7),
      expectedChildWorkspaceRevision: parse(Revision)(0),
      expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(9),
      expectedParentOwnershipRevision: 13,
      expectedChildOwnershipRevision: 0,
    };
    const result = await Effect.runPromise(
      Effect.provideService(
        handler.execute(
          {
            commandType: "CreateChildWorkspace",
            commandId,
            projectId,
            actor,
            issuedAt: "2026-10-26T00:00:00.000Z",
            payload: {
              parentWorkspaceId,
              workspaceId: childWorkspaceId,
              primarySession: {
                sessionId,
                contextEpoch: parse(ContextEpochNumber)(0),
              },
              name: "child",
              responsibilityDefinition: {
                purpose: "bounded responsibility",
                ownedResponsibilities: [],
                obligations: [],
                includes: [],
                excludes: [],
                interfaces: [],
              },
              responsibilityRevision: parse(ResponsibilityRevision)(1),
              resourceBoundary: {
                basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
                addresses: [address],
              },
              resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
              agentBinding: responsibilityBound(childWorkspaceId),
              workspacePolicy: makeWorkspacePolicy(),
              workspacePolicyRevision: parse(Revision)(0),
              revision: parse(Revision)(0),
              ownershipDelegationApproval: approval,
            },
          } as never,
          { _tag: "External", principal: actor as never },
        ),
        TransactionScope,
        { session: { id: "create-child-delegation-test" } },
      ),
    );
    expect(result.ok).toBe(true);
    expect(inserted).toEqual([
      {
        projectId,
        workspaceId: childWorkspaceId,
        resourceBoundaryRevision: 1,
        status: "Pending",
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
        activatedAt: null,
        delegation: approval,
      },
    ]);
  });
});
