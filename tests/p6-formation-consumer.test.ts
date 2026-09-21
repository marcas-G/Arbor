import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  runFormationConsumer,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  admitFormationProposal,
  CommandId,
  parse,
} from "../packages/domain/dist/index.js";
import {
  DomainEventJournal,
  FormationProposalStore,
  TransactionPort,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import { FPR_1, minimalProposal } from "./harness/p6-fixtures.js";
import {
  makeP6App,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
  runP6,
} from "./support/p6-app.js";

const decisionCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e1",
);

const approveSetup = Effect.gen(function* () {
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
  const gw = yield* CommandGateway;
  const payload = {
    proposalId: FPR_1,
    expectedProposalRevision: 1,
    outcome: { _tag: "Approve" as const },
  };
  const receipt = yield* gw.execute(
    {
      commandType: "RecordDecision",
      commandId: decisionCommandId,
      projectId: p6Project,
      actor: p6TestActor,
      issuedAt: "t",
      payload,
    },
    { _tag: "External", principal: p6TestPrincipal },
    {
      _tag: "RecordDecisionAuthority",
      principal: p6TestPrincipal,
      commandId: decisionCommandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "RecordDecision",
        projectId: p6Project,
        actor: p6TestActor,
        schemaVersion: "1",
        payload,
      }),
      projectId: p6Project,
      proposalId: FPR_1,
    },
  );
  expect(receipt.resolution._tag).toBe("Committed");
});

const journalEvents = Effect.gen(function* () {
  const journal = yield* DomainEventJournal;
  const tx = yield* TransactionPort;
  const last = yield* tx.transact(journal.lastSequence(p6Project));
  const events = yield* tx.transact(journal.readAfter(p6Project, 0, last + 1));
  return events.map((event) => ({
    eventType: event.eventType,
    payload: event.payload,
    eventId: `${event.sequence}`,
  }));
});

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const runConsume = Effect.gen(function* () {
  const gw = yield* CommandGateway;
  const proposals = yield* FormationProposalStore;
  const workspaces = yield* WorkspaceRepository;
  const tx = yield* TransactionPort;
  const events = yield* journalEvents;
  return yield* runFormationConsumer(
    events,
    {
      gateway: gw,
      workspaces: {
        findById: (id) => tx.transact(workspaces.findById(id)),
      },
      proposals: {
        findById: (id) => tx.transact(proposals.findById(id)),
      },
    },
    p6Project,
  );
});

describe("P6-004 approve consumer (D1)", () => {
  it("executes CreateChildWorkspace + AssignWork after approve; replay is idempotent", async () => {
    const program = Effect.gen(function* () {
      yield* approveSetup;
      const first = yield* runConsume;
      const countsAfterFirst = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };
      const second = yield* runConsume;
      const countsAfterSecond = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };
      return { first, second, countsAfterFirst, countsAfterSecond };
    });
    const result = await runP6(program, makeP6App());
    expect(result.first).toEqual(["CreateChildWorkspace", "AssignWork"]);
    // Replay replays the same deterministic command ids: the gateway returns
    // the existing receipts and nothing new is created (D1).
    expect(result.countsAfterSecond).toEqual(result.countsAfterFirst);
    expect(result.countsAfterFirst).toEqual({
      workspaces: 2, // root + formed child
      works: 1, // initialWork assigned
      sessions: 2, // root primary + child primary
    });
  });

  it("a rejected proposal never reaches the consumer's command path", async () => {
    const program = Effect.gen(function* () {
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
      const gw = yield* CommandGateway;
      const payload = {
        proposalId: FPR_1,
        expectedProposalRevision: 1,
        outcome: { _tag: "Reject" as const },
      };
      const receipt = yield* gw.execute(
        {
          commandType: "RecordDecision",
          commandId: decisionCommandId,
          projectId: p6Project,
          actor: p6TestActor,
          issuedAt: "t",
          payload,
        },
        { _tag: "External", principal: p6TestPrincipal },
        {
          _tag: "RecordDecisionAuthority",
          principal: p6TestPrincipal,
          commandId: decisionCommandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "RecordDecision",
            projectId: p6Project,
            actor: p6TestActor,
            schemaVersion: "1",
            payload,
          }),
          projectId: p6Project,
          proposalId: FPR_1,
        },
      );
      expect(receipt.resolution._tag).toBe("Committed");
      const consumed = yield* runConsume;
      return { consumed, workspaces: yield* countRows("workspaces") };
    });
    const result = await runP6(program, makeP6App());
    expect(result.consumed).toEqual([]);
    expect(result.workspaces).toBe(1);
  });
});
