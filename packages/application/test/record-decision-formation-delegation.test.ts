import {
  Actor,
  admitFormationProposal,
  CommandId,
  FormationProposalId,
  type FormationProposalRecord,
  Principal,
  ProjectId,
  parse,
  ResponsibilityRevision,
  type Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeRecordDecisionHandler } from "../src/commands/record-decision.js";

const actor = parse(Actor)("user:formation-test");
const principal = parse(Principal)("user:formation-test");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const proposalId = parse(FormationProposalId)(
  "fpr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const address = { _tag: "FileTree" as const, path: "src/child" };
const proposal = {
  name: "child",
  rationale: "bounded responsibility",
  responsibilityDraft: {
    purpose: "own the child slice",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  resourceBoundaryDraft: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
    addresses: [address],
  },
  resourceOwnershipDelegation: { addresses: [address] },
} as const;

const pending = (): FormationProposalRecord =>
  admitFormationProposal({ proposalId, parentWorkspaceId, proposal });

const invoke = async (
  claims: ReadonlyArray<{ readonly claimRevision: number }>,
) => {
  let decided: FormationProposalRecord | undefined;
  const handler = makeRecordDecisionHandler({
    proposals: {
      findById: (_proposalId: FormationProposalId) =>
        Effect.succeed(Option.some(decided ?? pending())),
      decideIfPendingRevision: (
        _proposalId: FormationProposalId,
        _expectedRevision: number,
        next: FormationProposalRecord,
      ) => {
        decided = next;
        return Effect.succeed(Option.some(next));
      },
    } as never,
    inbox: {
      markConsumed: () => Effect.void,
      admitUpsert: () => Effect.void,
    } as never,
    workspaces: {
      findById: () =>
        Effect.succeed(
          Option.some({
            lifecycle: "Active",
            revision: 7,
            resourceBoundaryRevision: 9,
          } as unknown as Workspace),
        ),
    } as never,
    resourceOwnership: {
      listActiveByWorkspace: () => Effect.succeed(claims as never),
    } as never,
    originatingWorkspaceOf: () => parentWorkspaceId,
  });
  return Effect.runPromise(
    Effect.provideService(
      handler.execute(
        {
          commandType: "RecordDecision",
          commandId,
          projectId,
          actor,
          issuedAt: "2026-10-26T00:00:00.000Z",
          payload: {
            proposalId,
            expectedProposalRevision: 1,
            outcome: { _tag: "Approve" },
          },
        } as never,
        { _tag: "External", principal },
      ),
      TransactionScope,
      { session: { id: "formation-delegation-test" } },
    ),
  );
};

describe("RecordDecision formation ownership delegation provenance", () => {
  it("persists exact human decision and frozen Parent/Child revisions", async () => {
    const result = await invoke([{ claimRevision: 13 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.value.events.find(
      (candidate) => candidate.eventType === "DecisionRecorded",
    );
    expect(event?.payload).toMatchObject({
      proposalId,
      proposalRevision: 1,
      decision: "Approve",
      decidedBy: actor,
      delegationApproval: {
        delegationSourceId: `formation:${proposalId}:1`,
        formationProposalId: proposalId,
        formationProposalRevision: 1,
        addresses: [address],
        approvedBy: actor,
        causedByCommandId: commandId,
        parentWorkspaceId,
        expectedParentWorkspaceRevision: 7,
        expectedChildWorkspaceRevision: 0,
        expectedParentBoundaryRevision: 9,
        expectedParentOwnershipRevision: 13,
        expectedChildOwnershipRevision: 0,
      },
    });
  });

  it("fails closed when Parent ownership cannot be bound to one exact claim", async () => {
    const result = await invoke([{ claimRevision: 13 }, { claimRevision: 14 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AuthorityDenied",
      reason: expect.stringContaining("exactly one active Parent claim"),
    });
  });
});
