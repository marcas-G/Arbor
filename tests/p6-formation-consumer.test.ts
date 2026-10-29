import { Effect, Option } from "effect";
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
  const ownershipActivations: unknown[] = [];
  const executed = yield* runFormationConsumer(
    events,
    {
      gateway: gw,
      workspaces: {
        findById: (id) => tx.transact(workspaces.findById(id)),
      },
      proposals: {
        findById: (id) => tx.transact(proposals.findById(id)),
      },
      ownershipWrite: {
        activateDelegatedOwnership: (input: unknown) => {
          ownershipActivations.push(input);
          return Effect.succeed({ _tag: "Activated" } as never);
        },
      } as never,
    },
    p6Project,
  );
  return { executed, ownershipActivations };
});

describe("P6-004 approve consumer (D1)", () => {
  it("does not apply an old Approve event to a later Modified-and-Approved snapshot", async () => {
    const latestProposal = {
      ...minimalProposal(),
      name: "revised-child",
      initialWork: undefined,
    };
    const latestSnapshot = {
      ...admitFormationProposal({
        proposalId: FPR_1,
        parentWorkspaceId: p6RootWorkspace,
        proposal: latestProposal,
      }),
      revision: 2,
      state: "Approved" as const,
    };
    const commands: unknown[] = [];
    const consumed = await Effect.runPromise(
      runFormationConsumer(
        [
          {
            eventType: "DecisionRecorded",
            eventId: "evt-old-approve",
            payload: {
              proposalId: FPR_1,
              proposalRevision: 1,
              decision: "Approve",
              decidedBy: p6TestActor,
            },
          },
        ],
        {
          gateway: {
            execute: (envelope: unknown) => {
              commands.push(envelope);
              return Effect.succeed({
                resolution: { _tag: "Committed", result: {} },
              } as never);
            },
          } as never,
          workspaces: {
            findById: () =>
              Effect.succeed(
                Option.some({
                  resourceBoundary: latestProposal.resourceBoundaryDraft,
                } as never),
              ),
          },
          proposals: {
            findById: () => Effect.succeed(Option.some(latestSnapshot)),
          },
        },
        p6Project,
      ),
    );
    expect(consumed).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("activates only the exact human-approved delegated subset after Child commit", async () => {
    const address = { _tag: "FileTree" as const, path: "services/child" };
    const proposal = {
      ...minimalProposal(),
      initialWork: undefined,
      resourceBoundaryDraft: {
        ...minimalProposal().resourceBoundaryDraft,
        addresses: [address],
      },
      resourceOwnershipDelegation: { addresses: [address] },
    };
    const snapshot = {
      ...admitFormationProposal({
        proposalId: FPR_1,
        parentWorkspaceId: p6RootWorkspace,
        proposal,
      }),
      state: "Approved" as const,
    };
    const approval = {
      delegationSourceId: `formation:${FPR_1}:1`,
      formationProposalId: FPR_1,
      formationProposalRevision: 1,
      addresses: [address],
      approvedBy: p6TestActor,
      causedByCommandId: decisionCommandId,
      parentWorkspaceId: p6RootWorkspace,
      expectedParentWorkspaceRevision: 0,
      expectedChildWorkspaceRevision: 0,
      expectedParentBoundaryRevision: 1,
      expectedParentOwnershipRevision: 1,
      expectedChildOwnershipRevision: 0,
    };
    const commands: Array<{ commandType: string; payload: unknown }> = [];
    const activations: unknown[] = [];
    const consumed = await Effect.runPromise(
      runFormationConsumer(
        [
          {
            eventType: "DecisionRecorded",
            eventId: "evt-decision-1",
            payload: {
              proposalId: FPR_1,
              proposalRevision: 1,
              decision: "Approve",
              decidedBy: p6TestActor,
              delegationApproval: approval,
            },
          },
        ],
        {
          gateway: {
            execute: (envelope: { commandType: string; payload: unknown }) => {
              commands.push(envelope);
              return Effect.succeed({
                resolution: { _tag: "Committed", result: {} },
              } as never);
            },
          } as never,
          workspaces: {
            findById: () =>
              Effect.succeed(
                Option.some({
                  resourceBoundary: proposal.resourceBoundaryDraft,
                } as never),
              ),
          },
          proposals: { findById: () => Effect.succeed(Option.some(snapshot)) },
          ownershipWrite: {
            activateDelegatedOwnership: (input: unknown) => {
              activations.push(input);
              return Effect.succeed({ _tag: "Activated" } as never);
            },
          } as never,
        },
        p6Project,
      ),
    );
    expect(consumed).toEqual([
      "CreateChildWorkspace",
      "ActivateDelegatedOwnership",
    ]);
    expect(commands[0]?.commandType).toBe("CreateChildWorkspace");
    const createPayload = commands[0]?.payload as
      | { ownershipDelegationApproval?: unknown }
      | undefined;
    expect(createPayload?.ownershipDelegationApproval).toEqual(approval);
    expect(activations).toEqual([
      {
        projectId: p6Project,
        childWorkspaceId: expect.any(String),
        childResourceBoundaryRevision: 1,
        delegationSourceId: approval.delegationSourceId,
      },
    ]);
  });

  it("keeps a delegated formation recoverable when resource activation is temporarily unavailable", async () => {
    const address = { _tag: "FileTree" as const, path: "services/pending" };
    const proposal = {
      ...minimalProposal(),
      resourceBoundaryDraft: {
        ...minimalProposal().resourceBoundaryDraft,
        addresses: [address],
      },
      resourceOwnershipDelegation: { addresses: [address] },
    };
    const snapshot = {
      ...admitFormationProposal({
        proposalId: FPR_1,
        parentWorkspaceId: p6RootWorkspace,
        proposal,
      }),
      state: "Approved" as const,
    };
    const approval = {
      delegationSourceId: `formation:${FPR_1}:1`,
      formationProposalId: FPR_1,
      formationProposalRevision: 1,
      addresses: [address],
      approvedBy: p6TestActor,
      causedByCommandId: decisionCommandId,
      parentWorkspaceId: p6RootWorkspace,
      expectedParentWorkspaceRevision: 0,
      expectedChildWorkspaceRevision: 0,
      expectedParentBoundaryRevision: 1,
      expectedParentOwnershipRevision: 1,
      expectedChildOwnershipRevision: 0,
    };
    const commands: string[] = [];
    const fulfillmentStates: string[] = [];
    let activationAttempts = 0;
    const dependencies = {
      gateway: {
        execute: (envelope: { commandType: string }) => {
          commands.push(envelope.commandType);
          return Effect.succeed({
            resolution: { _tag: "Committed", result: {} },
          } as never);
        },
      } as never,
      workspaces: {
        findById: () =>
          Effect.succeed(
            Option.some({
              resourceBoundary: proposal.resourceBoundaryDraft,
            } as never),
          ),
      },
      proposals: { findById: () => Effect.succeed(Option.some(snapshot)) },
      fulfillments: {
        put: (record: { readonly state: string }) =>
          Effect.sync(() => {
            fulfillmentStates.push(record.state);
          }),
      },
      ownershipWrite: {
        activateDelegatedOwnership: () => {
          activationAttempts += 1;
          return activationAttempts === 1
            ? Effect.fail({
                _tag: "EnvironmentError" as const,
                cause: "delegated resource is not present yet",
              })
            : Effect.succeed({ _tag: "Activated" } as never);
        },
      } as never,
    };
    const event = {
      eventType: "DecisionRecorded",
      eventId: "evt-decision-recoverable",
      payload: {
        proposalId: FPR_1,
        proposalRevision: 1,
        decision: "Approve" as const,
        decidedBy: p6TestActor,
        delegationApproval: approval,
      },
    };

    const first = await Effect.runPromise(
      runFormationConsumer([event], dependencies, p6Project),
    );
    expect(first).toEqual(["CreateChildWorkspace"]);
    expect(commands).toEqual(["CreateChildWorkspace"]);
    expect(fulfillmentStates.at(-1)).toBe("WorkspaceCreated");

    const second = await Effect.runPromise(
      runFormationConsumer([event], dependencies, p6Project),
    );
    expect(second).toEqual([
      "CreateChildWorkspace",
      "ActivateDelegatedOwnership",
      "AssignWork",
    ]);
    expect(commands).toEqual([
      "CreateChildWorkspace",
      "CreateChildWorkspace",
      "AssignWork",
    ]);
    expect(fulfillmentStates.at(-1)).toBe("Applied");
  });

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
    expect(result.first.executed).toEqual([
      "CreateChildWorkspace",
      "AssignWork",
    ]);
    expect(result.first.ownershipActivations).toEqual([]);
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
    expect(result.consumed.executed).toEqual([]);
    expect(result.consumed.ownershipActivations).toEqual([]);
    expect(result.workspaces).toBe(1);
  });
});
