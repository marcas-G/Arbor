import {
  admitFormationProposal,
  type ChildWorkspaceProposal,
  FormationProposalId,
  parse,
  ResponsibilityRevision,
  WorkspaceId,
} from "../../packages/domain/src/index.js";

export const FPR_1 = parse(FormationProposalId)(
  "fpr_00000000-0000-7000-8000-000000000001",
);
export const WS_ROOT = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000001",
);
export const WS_CHILD = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000002",
);

export const minimalProposal = (): ChildWorkspaceProposal => ({
  name: "child-1",
  responsibilityDraft: {
    purpose: "own the integration slice",
    ownedResponsibilities: ["integration"],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  resourceBoundaryDraft: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
    addresses: [], // minimal draft never escapes a parent boundary; ceiling
    // violations are exercised explicitly in tests/p6-ceiling.test.ts
  },
  rationale: "parallelizable responsibility block",
  initialWork: {
    objective: "make the slice pass",
    why: "downstream integration",
    constraints: [],
    completionExpectation: "all suites green",
  },
  formationDepthHint: "Single",
});

export const pendingProposal = () =>
  admitFormationProposal({
    proposalId: FPR_1,
    parentWorkspaceId: WS_ROOT,
    proposal: minimalProposal(),
  });
