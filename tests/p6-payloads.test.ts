import { describe, expect, it } from "vitest";
import {
  admitFormationProposal,
  decideFormationProposal,
  ExecutionId,
  type InboxArrival,
  parse,
  promoteInboxArrival,
  settlementFingerprint,
  specialistSettlementEntryKey,
} from "../packages/domain/src/index.js";

import {
  FPR_1,
  minimalProposal,
  WS_CHILD,
  WS_ROOT,
} from "./harness/p6-fixtures.js";

const EXE_9 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000009");

describe("P6-001 formation payloads", () => {
  it("admits a proposal at revision 1 in Pending", () => {
    const record = admitFormationProposal({
      proposalId: FPR_1,
      parentWorkspaceId: WS_ROOT,
      proposal: minimalProposal(),
    });
    expect(record.revision).toBe(1);
    expect(record.state).toBe("Pending");
  });

  it("rejects a stale decision with RevisionConflict (D1)", () => {
    const record = admitFormationProposal({
      proposalId: FPR_1,
      parentWorkspaceId: WS_ROOT,
      proposal: minimalProposal(),
    });
    const outcome = decideFormationProposal(record, {
      expectedProposalRevision: 2,
      outcome: { _tag: "Approve" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error._tag).toBe("RevisionConflict");
    }
  });

  it("modify supersedes content and increments revision (stays Pending)", () => {
    const record = admitFormationProposal({
      proposalId: FPR_1,
      parentWorkspaceId: WS_ROOT,
      proposal: minimalProposal(),
    });
    const modified = decideFormationProposal(record, {
      expectedProposalRevision: 1,
      outcome: {
        _tag: "Modify",
        proposal: { ...minimalProposal(), name: "child-2" },
      },
    });
    expect(modified.ok).toBe(true);
    if (modified.ok) {
      expect(modified.value.record.revision).toBe(2);
      expect(modified.value.record.state).toBe("Pending");
      expect(modified.value.record.proposal.name).toBe("child-2");
    }
  });

  it("approve is terminal and records only a governance fact (D1)", () => {
    const record = admitFormationProposal({
      proposalId: FPR_1,
      parentWorkspaceId: WS_ROOT,
      proposal: minimalProposal(),
    });
    const approved = decideFormationProposal(record, {
      expectedProposalRevision: 1,
      outcome: { _tag: "Approve" },
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.record.state).toBe("Approved");
      expect(approved.value.fact.proposalRevision).toBe(1);
    }
    const again = decideFormationProposal(
      approved.ok ? approved.value.record : record,
      { expectedProposalRevision: 1, outcome: { _tag: "Approve" } },
    );
    expect(again.ok).toBe(false);
  });
});

describe("P6-001 communication payloads", () => {
  it("promotion closes correlation only for Reply (D2: Report has no canonical effect)", () => {
    const reply: InboxArrival = {
      recipientWorkspaceId: WS_CHILD,
      kind: "Reply",
      correlationId: "cor_query-1",
    };
    expect(promoteInboxArrival(reply)).toEqual({
      closesCorrelation: "cor_query-1",
      triggersReevaluation: false,
    });

    const report: InboxArrival = {
      recipientWorkspaceId: WS_CHILD,
      kind: "Report",
    };
    expect(promoteInboxArrival(report)).toEqual({
      closesCorrelation: null,
      triggersReevaluation: false,
    });

    const decisionRequest: InboxArrival = {
      recipientWorkspaceId: WS_CHILD,
      kind: "DecisionRequest",
    };
    expect(promoteInboxArrival(decisionRequest)).toEqual({
      closesCorrelation: null,
      triggersReevaluation: true,
    });
  });

  it("settlement fingerprint is deterministic and keyed (D3)", () => {
    const settlement = {
      _tag: "Completed" as const,
      result: {
        _tag: "CompletionClaimed" as const,
        workRevision: 3 as never,
        claimRef: "c1",
      },
    };
    const a = settlementFingerprint(settlement);
    const b = settlementFingerprint(settlement);
    expect(a).toBe(b);
    expect(
      settlementFingerprint({
        _tag: "Completed",
        result: {
          _tag: "Yielded" as const,
          reason: "r",
          waitSpec: [] as never,
        },
      }),
    ).not.toBe(a);
    expect(specialistSettlementEntryKey(EXE_9, a)).toBe(`spc:${EXE_9}:${a}`);
  });
});

describe("P6-001 type-level payload constraints", () => {
  it("message kinds are a closed set of exactly four (D2)", async () => {
    const { MESSAGE_KINDS } = await import("../packages/domain/src/index.js");
    expect([...MESSAGE_KINDS]).toEqual([
      "Query",
      "Reply",
      "Report",
      "DecisionRequest",
    ]);
    // @ts-expect-error - Deliver is not a P6 message kind (P7)
    const kind: (typeof MESSAGE_KINDS)[number] = "Deliver";
    expect(MESSAGE_KINDS).not.toContain(kind);
  });
});
