import type {
  Actor,
  FormationProposalId,
  FormationProposalRecord,
  Principal,
  ProjectId,
} from "@arbor/domain";
import type { WorkspaceRepositoryService } from "@arbor/ports";
import { Effect, Option } from "effect";
import { validateCapabilityCeiling } from "./capability-ceiling.js";
import {
  deriveFormationIds,
  formationAssignPlan,
  formationCreatePlan,
} from "./formation-plan.js";
import type { CommandGatewayService } from "./gateway.js";

export interface FormationConsumerDependencies {
  readonly gateway: CommandGatewayService;
  readonly workspaces: {
    readonly findById: (
      workspaceId: import("@arbor/domain").WorkspaceId,
    ) => Effect.Effect<
      Option.Option<import("@arbor/domain").Workspace>,
      unknown,
      never
    >;
  };
  readonly proposals: {
    readonly findById: (
      proposalId: FormationProposalId,
    ) => Effect.Effect<Option.Option<FormationProposalRecord>, unknown, never>;
  };
}

interface DecisionRecordedEvent {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly decision: "Approve" | "Reject" | "Modify";
  readonly decidedBy: Actor;
}

const asDecisionEvent = (payload: unknown): DecisionRecordedEvent | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.proposalId !== "string" ||
    typeof candidate.proposalRevision !== "number" ||
    (candidate.decision !== "Approve" &&
      candidate.decision !== "Reject" &&
      candidate.decision !== "Modify")
  ) {
    return null;
  }
  return {
    proposalId: candidate.proposalId as FormationProposalId,
    proposalRevision: candidate.proposalRevision,
    decision: candidate.decision,
    decidedBy: candidate.decidedBy as Actor,
  };
};

/** P6 `01` §4.2 (D1): the approve consumer turns a DecisionRecorded
 * governance fact into the canonical CreateChildWorkspace (+ AssignWork)
 * commands — governance fact and canonical mutation remain two steps.
 * Command ids are deterministic f(proposalId, revision); at-least-once
 * redelivery replays the same receipts (DID §5.4). */
export const runFormationConsumer = (
  events: ReadonlyArray<{
    readonly eventType: string;
    readonly payload: unknown;
    readonly eventId: string;
  }>,
  dependencies: FormationConsumerDependencies,
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.gen(function* () {
    const executed: string[] = [];
    for (const event of events) {
      if (event.eventType !== "DecisionRecorded") {
        continue;
      }
      const decision = asDecisionEvent(event.payload);
      if (decision === null || decision.decision !== "Approve") {
        continue;
      }
      const found = yield* dependencies.proposals.findById(decision.proposalId);
      if (Option.isNone(found)) {
        continue;
      }
      const snapshot = found.value;
      if (snapshot.state !== "Approved") {
        continue;
      }
      const parent = yield* dependencies.workspaces.findById(
        snapshot.parentWorkspaceId,
      );
      if (Option.isNone(parent)) {
        continue; // P1 §6 rejects unknown parents; nothing to consume
      }
      // The gated path re-checks the ceiling at execution time too: the
      // parent boundary may have moved since admission (P6 `03` §2).
      const ceilingError = validateCapabilityCeiling({
        parentBoundary: parent.value.resourceBoundary,
        draftBoundary: snapshot.proposal.resourceBoundaryDraft,
      });
      if (ceilingError !== null) {
        continue;
      }
      const principal = decision.decidedBy as unknown as Principal;
      const ids = deriveFormationIds(snapshot.proposalId, snapshot.revision);
      const create = formationCreatePlan({
        snapshot,
        ids,
        projectId,
        actor: decision.decidedBy,
        principal,
      });
      const createReceipt = yield* dependencies.gateway.execute(
        {
          commandType: "CreateChildWorkspace",
          commandId: ids.createCommandId,
          projectId,
          actor: decision.decidedBy,
          issuedAt: new Date().toISOString(),
          causationRef: event.eventId,
          payload: create.payload,
        },
        {
          _tag: "System",
          principal,
          causationRef: `formation-consumer:${event.eventId}`,
        },
        create.authority,
      );
      if (createReceipt.resolution._tag !== "Committed") {
        continue;
      }
      executed.push("CreateChildWorkspace");

      const assign = formationAssignPlan({
        snapshot,
        ids,
        projectId,
        actor: decision.decidedBy,
        principal,
      });
      if (assign !== null) {
        const assignReceipt = yield* dependencies.gateway.execute(
          {
            commandType: "AssignWork",
            commandId: ids.assignCommandId,
            projectId,
            actor: decision.decidedBy,
            issuedAt: new Date().toISOString(),
            causationRef: event.eventId,
            payload: assign.payload,
          },
          {
            _tag: "System",
            principal,
            causationRef: `formation-consumer:${event.eventId}`,
          },
          assign.authority,
        );
        if (assignReceipt.resolution._tag === "Committed") {
          executed.push("AssignWork");
        }
      }
    }
    return executed;
  });
