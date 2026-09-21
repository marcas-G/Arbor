import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  admitFormationProposal,
  CommandId,
  FormationProposalId,
  parse,
} from "../packages/domain/dist/index.js";
import {
  FormationProposalStore,
  InboxProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { FPR_1, minimalProposal, WS_ROOT } from "./harness/p6-fixtures.js";
import {
  makeP6App,
  p6EventTypes,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
  runP6,
} from "./support/p6-app.js";

const decisionCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const otherProposalId = parse(FormationProposalId)(
  "fpr_00000000-0000-7000-8000-0000000000ff",
);

const seedProposal = Effect.gen(function* () {
  yield* runMigrations(P6_MIGRATIONS);
  yield* p6SeedProject;
  const proposals = yield* FormationProposalStore;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    proposals.insert(
      admitFormationProposal({
        proposalId: FPR_1,
        parentWorkspaceId: p6RootWorkspace,
        proposal: minimalProposal(),
      }),
    ),
  );
});

const submitDecision = (
  gw: import("../packages/application/src/index.js").CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly proposalId: FormationProposalId;
    readonly expectedProposalRevision: number;
    readonly outcome: "Approve" | "Reject" | "Modify";
  },
) => {
  const payload = {
    proposalId: args.proposalId,
    expectedProposalRevision: args.expectedProposalRevision,
    outcome:
      args.outcome === "Modify"
        ? { _tag: "Modify" as const, proposal: minimalProposal() }
        : { _tag: args.outcome as "Approve" | "Reject" },
  };
  return gw.execute(
    {
      commandType: "RecordDecision",
      commandId: args.commandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: p6TestPrincipal },
    {
      _tag: "RecordDecisionAuthority",
      principal: p6TestPrincipal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "RecordDecision",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "1",
        payload,
      }),
      projectId: p6Project,
      proposalId: args.proposalId,
    },
  );
};

describe("P6-003 RecordDecision governance (D1)", () => {
  it("approve emits DecisionRecorded only — no WorkspaceCreated (governance fact, not mutation)", async () => {
    const program = Effect.gen(function* () {
      yield* seedProposal;
      const gw = yield* CommandGateway;
      const receipt = yield* submitDecision(gw, {
        commandId: decisionCommandId,
        proposalId: FPR_1,
        expectedProposalRevision: 1,
        outcome: "Approve",
      });
      return { receipt, events: yield* p6EventTypes };
    });
    const { receipt, events } = await runP6(program, makeP6App());
    expect(receipt.resolution._tag).toBe("Committed");
    expect(events).toContain("DecisionRecorded");
    // The only WorkspaceCreated is the CreateProject bootstrap's root
    // workspace (P1 `01` §5); the approval itself must not create one.
    expect(events.indexOf("DecisionRecorded")).toBeGreaterThan(
      events.lastIndexOf("WorkspaceCreated"),
    );
  });

  it("rejects a stale revision with RevisionConflict", async () => {
    const program = Effect.gen(function* () {
      yield* seedProposal;
      const gw = yield* CommandGateway;
      return yield* submitDecision(gw, {
        commandId: decisionCommandId,
        proposalId: FPR_1,
        expectedProposalRevision: 2,
        outcome: "Approve",
      });
    });
    const receipt = await runP6(program, makeP6App());
    expect(receipt.resolution._tag).toBe("TerminalRejected");
    if (receipt.resolution._tag === "TerminalRejected") {
      expect(receipt.resolution.error._tag).toBe("RevisionConflict");
    }
  });

  it("modify keeps the proposal Pending at revision 2; decision lands in the originating Inbox", async () => {
    const program = Effect.gen(function* () {
      yield* seedProposal;
      const gw = yield* CommandGateway;
      const receipt = yield* submitDecision(gw, {
        commandId: decisionCommandId,
        proposalId: FPR_1,
        expectedProposalRevision: 1,
        outcome: "Modify",
      });
      const proposals = yield* FormationProposalStore;
      const tx = yield* TransactionPort;
      const after = yield* tx.transact(proposals.findById(FPR_1));
      const inbox = yield* InboxProjectionStore;
      const entries = yield* tx.transact(inbox.listUnconsumed(p6RootWorkspace));
      return {
        receipt,
        state: Option.isSome(after) ? after.value.state : "missing",
        revision: Option.isSome(after) ? after.value.revision : -1,
        entries,
      };
    });
    const result = await runP6(program, makeP6App());
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.state).toBe("Pending");
    expect(result.revision).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.kind).toBe("Governance");
  });

  it("terminal proposals refuse further decisions; unknown proposals are a typed rejection", async () => {
    const program = Effect.gen(function* () {
      yield* seedProposal;
      const gw = yield* CommandGateway;
      const first = yield* submitDecision(gw, {
        commandId: decisionCommandId,
        proposalId: FPR_1,
        expectedProposalRevision: 1,
        outcome: "Reject",
      });
      const again = yield* submitDecision(gw, {
        commandId: decisionCommandId,
        proposalId: FPR_1,
        expectedProposalRevision: 1,
        outcome: "Approve",
      });
      const unknown = yield* submitDecision(gw, {
        commandId: parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d2"),
        proposalId: otherProposalId,
        expectedProposalRevision: 1,
        outcome: "Approve",
      });
      return { first, again, unknown };
    });
    const result = await runP6(program, makeP6App());
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.again.resolution._tag).toBe("TerminalRejected");
    expect(result.unknown.resolution._tag).toBe("TerminalRejected");
    if (result.unknown.resolution._tag === "TerminalRejected") {
      expect(result.unknown.resolution.error._tag).toBe(
        "FormationProposalNotFound",
      );
    }
  });
});

void WS_ROOT;
