import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  P35_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeProposeChildWorkspaceHandler } from "../../apps/single-workspace/src/legacy-directive-handlers.js";
import { makeRequestGovernanceHandler } from "../../apps/single-workspace/src/legacy-governance-directive-handler.js";
import { CommandGateway } from "../../packages/application/src/index.js";
import {
  FormationProposalId,
  type FormationProposalRecord,
  parse,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import {
  APPROVE_COMMAND,
  countRows,
  EXE_ROOT,
  eventTypes,
  executionContext,
  executionOf,
  idFromText,
  inboxOf,
  journalEvents,
  MODIFY_COMMAND,
  makeAcceptanceApp,
  proposalDraft,
  ROOT,
  runAcceptance,
  runConsume,
  STALE_COMMAND,
  scalar,
  seedProject,
} from "./support.js";
import { submitDecision } from "./support-submit.js";

describe("-acceptance", () => {
  it("Story A: first-layer formation under the human gate (D1)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seedProject;

      const proposeHandler = makeProposeChildWorkspaceHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const govHandler = makeRequestGovernanceHandler({
        gateway: yield* CommandGateway,
        proposals: yield* FormationProposalStore,
        inbox: yield* InboxProjectionStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
        workspaces: yield* WorkspaceRepository,
        messages: yield* MessageStore,
      });
      const proposals = yield* FormationProposalStore;
      const tx = yield* TransactionPort;
      const gw = yield* CommandGateway;

      const proposeOutcome = yield* proposeHandler.handle({
        directive: {
          _tag: "ProposeChildWorkspace",
          spec: proposalDraft("child-integration"),
        },
        execution: executionOf(EXE_ROOT, ROOT),
        context: executionContext(EXE_ROOT),
      });
      const proposalId = parse(FormationProposalId)(
        proposeOutcome._tag === "Observation"
          ? (idFromText(proposeOutcome.observation.text, "fpr_") ?? "")
          : "",
      );
      const record = yield* tx.transact(proposals.findById(proposalId));

      const govOutcome = yield* govHandler.handle({
        directive: {
          _tag: "RequestGovernance",
          request: {
            _tag: "FormationApproval",
            proposalId,
            proposalRevision: 1,
          },
        },
        execution: executionOf(EXE_ROOT, ROOT),
        context: executionContext(EXE_ROOT),
      });
      const afterProposeEventTypes = yield* eventTypes;
      const afterProposeInbox = yield* inboxOf(ROOT);

      const modify = yield* submitDecision(gw, {
        commandId: MODIFY_COMMAND,
        proposalId,
        expectedProposalRevision: 1,
        outcome: {
          _tag: "Modify",
          proposal: proposalDraft("child-integration-v2"),
        },
      });
      const modified = yield* tx.transact(proposals.findById(proposalId));

      const stale = yield* submitDecision(gw, {
        commandId: STALE_COMMAND,
        proposalId,
        expectedProposalRevision: 1,
        outcome: { _tag: "Approve" },
      });
      const afterStaleEventTypes = yield* eventTypes;
      const afterStaleInbox = yield* inboxOf(ROOT);

      const approve = yield* submitDecision(gw, {
        commandId: APPROVE_COMMAND,
        proposalId,
        expectedProposalRevision: 2,
        outcome: { _tag: "Approve" },
      });
      const approveReplay = yield* submitDecision(gw, {
        commandId: APPROVE_COMMAND,
        proposalId,
        expectedProposalRevision: 2,
        outcome: { _tag: "Approve" },
      });
      const afterApproveEvents = yield* journalEvents;
      const afterApproveWorkspaces = yield* countRows("workspaces");

      const consumed = yield* runConsume;
      const eventsAfterConsume = yield* journalEvents;
      const createdEvents = eventsAfterConsume.filter(
        (event) => event.eventType === "WorkspaceCreated",
      );
      const createdPayload = createdEvents[1]?.payload as {
        workspaceId: WorkspaceId;
        parentWorkspaceId: WorkspaceId;
      };
      const childParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [createdPayload.workspaceId],
      );
      const rootParent = yield* scalar<string | null>(
        "SELECT parent_workspace_id AS value FROM workspaces WHERE workspace_id = ?",
        [ROOT],
      );
      const countsAfterConsume = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };

      yield* runConsume;
      const countsAfterReplayConsume = {
        workspaces: yield* countRows("workspaces"),
        works: yield* countRows("works"),
        sessions: yield* countRows("sessions"),
      };

      return {
        proposeOutcome,
        record,
        govOutcome,
        afterProposeEventTypes,
        afterProposeInbox,
        modify,
        modified,
        stale,
        afterStaleEventTypes,
        afterStaleInbox,
        approve,
        approveReplay,
        afterApproveEvents,
        eventsAfterConsume,
        afterApproveWorkspaces,
        consumed,
        createdEvents,
        createdPayload,
        childParent,
        rootParent,
        countsAfterConsume,
        countsAfterReplayConsume,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.proposeOutcome._tag).toBe("Observation");
    expect(Option.isSome(result.record)).toBe(true);
    if (Option.isSome(result.record)) {
      expect(result.record.value.state).toBe("Pending");
      expect(result.record.value.revision).toBe(1);
      expect(result.record.value.parentWorkspaceId).toBe(ROOT);
      expect(result.record.value.proposal.name).toBe("child-integration");
    }

    expect(result.govOutcome._tag).toBe("Observation");
    expect(
      result.afterProposeEventTypes.filter((t) => t === "WorkspaceCreated"),
    ).toHaveLength(1);
    expect(result.afterProposeInbox).toHaveLength(1);
    expect(result.afterProposeInbox[0]?.kind).toBe("Governance");
    expect(result.afterProposeInbox[0]?.entryKey).toBe(
      `gov:${(Option.getOrThrow(result.record) as FormationProposalRecord).proposalId}:1`,
    );

    expect(result.modify.resolution._tag).toBe("Committed");
    expect(Option.isSome(result.modified)).toBe(true);
    if (Option.isSome(result.modified)) {
      expect(result.modified.value.state).toBe("Pending");
      expect(result.modified.value.revision).toBe(2);
      expect(result.modified.value.proposal.name).toBe("child-integration-v2");
    }

    expect(result.stale.resolution._tag).toBe("TerminalRejected");
    if (result.stale.resolution._tag === "TerminalRejected") {
      expect(result.stale.resolution.error._tag).toBe("RevisionConflict");
    }
    expect(
      result.afterStaleEventTypes.filter((t) => t === "DecisionRecorded"),
    ).toHaveLength(1);
    expect(result.afterStaleInbox).toHaveLength(2);

    expect(result.approve.resolution._tag).toBe("Committed");
    if (result.approve.resolution._tag === "Committed") {
      expect(result.approve.resolution.result.proposalRevision).toBe(2);
    }
    expect(result.approveReplay).toEqual(result.approve);
    const approveFact = result.afterApproveEvents.find(
      (event) =>
        event.eventType === "DecisionRecorded" &&
        (event.payload as { decision: string }).decision === "Approve",
    );
    expect(approveFact?.payload).toEqual(
      expect.objectContaining({ proposalRevision: 2 }),
    );
    expect(result.afterApproveWorkspaces).toBe(1);
    expect(
      result.afterApproveEvents.filter(
        (event) => event.eventType === "WorkspaceCreated",
      ),
    ).toHaveLength(1);

    expect(result.consumed).toEqual(["CreateChildWorkspace", "AssignWork"]);
    expect(result.createdEvents).toHaveLength(2);
    expect(result.createdPayload.parentWorkspaceId).toBe(ROOT);
    expect(result.childParent).toBe(ROOT);
    expect(result.rootParent).toBeNull();
    expect(result.countsAfterConsume).toEqual({
      workspaces: 2,
      works: 1,
      sessions: 2,
    });
    expect(result.countsAfterReplayConsume).toEqual(result.countsAfterConsume);
    expect(
      result.eventsAfterConsume.some(
        (event) => event.eventType === "WorkAssigned",
      ),
    ).toBe(true);
  });
});
