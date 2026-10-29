import type {
  Actor,
  FormationProposalId,
  FormationProposalRecord,
  Principal,
  ProjectId,
} from "@arbor/domain";
import { regionContains } from "@arbor/domain";
import type {
  FormationFulfillmentRecord,
  FormationFulfillmentStoreError,
  OwnershipWriteServiceService,
  ProjectEnvironmentPortService,
  TransactionOperationalFailure,
} from "@arbor/ports";
import { resourceRegionComparator } from "@arbor/ports";
import { Effect, Option } from "effect";
import { validateCapabilityCeiling } from "./capability-ceiling.js";
import {
  deriveFormationIds,
  type FormationDelegationApproval,
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
  readonly fulfillments?: {
    readonly put: (
      record: FormationFulfillmentRecord,
    ) => Effect.Effect<
      void,
      FormationFulfillmentStoreError | TransactionOperationalFailure,
      never
    >;
  };
  readonly ownershipWrite?: Pick<
    OwnershipWriteServiceService,
    "activateDelegatedOwnership"
  >;
  readonly environment?: Pick<ProjectEnvironmentPortService, "resolve">;
}

interface DecisionRecordedEvent {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly decision: "Approve" | "Reject" | "Modify";
  readonly decidedBy: Actor;
  readonly delegationApproval?: FormationDelegationApproval;
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
  let delegationApproval: FormationDelegationApproval | undefined;
  if (candidate.delegationApproval !== undefined) {
    const raw = candidate.delegationApproval;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const approval = raw as Record<string, unknown>;
    const integerFields = [
      "formationProposalRevision",
      "expectedParentWorkspaceRevision",
      "expectedChildWorkspaceRevision",
      "expectedParentBoundaryRevision",
      "expectedParentOwnershipRevision",
      "expectedChildOwnershipRevision",
    ];
    if (
      typeof approval.delegationSourceId !== "string" ||
      typeof approval.formationProposalId !== "string" ||
      !Array.isArray(approval.addresses) ||
      typeof approval.causedByCommandId !== "string" ||
      typeof approval.parentWorkspaceId !== "string" ||
      integerFields.some(
        (field) =>
          typeof approval[field] !== "number" ||
          !Number.isSafeInteger(approval[field]) ||
          (approval[field] as number) < 0,
      )
    ) {
      return null;
    }
    delegationApproval = approval as unknown as FormationDelegationApproval;
  }
  return {
    proposalId: candidate.proposalId as FormationProposalId,
    proposalRevision: candidate.proposalRevision,
    decision: candidate.decision,
    decidedBy: candidate.decidedBy as Actor,
    ...(delegationApproval === undefined ? {} : { delegationApproval }),
  };
};

const sameAddresses = (
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

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
    readonly occurredAt?: string;
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
        console.error(
          "[formation-consumer] approved decision without a proposal:",
          String(decision.proposalId),
        );
        continue;
      }
      const snapshot = found.value;
      if (
        snapshot.state !== "Approved" ||
        snapshot.revision !== decision.proposalRevision
      ) {
        console.error(
          "[formation-consumer] decision does not bind the current Approved proposal revision:",
          String(decision.proposalId),
          snapshot.state,
          `event revision ${decision.proposalRevision}`,
          `current revision ${snapshot.revision}`,
        );
        continue;
      }
      const proposedDelegation = snapshot.proposal.resourceOwnershipDelegation;
      if (
        (proposedDelegation === undefined) !==
          (decision.delegationApproval === undefined) ||
        (proposedDelegation !== undefined &&
          decision.delegationApproval !== undefined &&
          (decision.delegationApproval.formationProposalId !==
            snapshot.proposalId ||
            decision.delegationApproval.formationProposalRevision !==
              decision.proposalRevision ||
            decision.delegationApproval.parentWorkspaceId !==
              snapshot.parentWorkspaceId ||
            decision.delegationApproval.approvedBy !== decision.decidedBy ||
            decision.delegationApproval.delegationSourceId !==
              `formation:${snapshot.proposalId}:${decision.proposalRevision}` ||
            !sameAddresses(
              decision.delegationApproval.addresses,
              proposedDelegation.addresses,
            )))
      ) {
        console.error(
          "[formation-consumer] exact approved delegation evidence does not match the proposal:",
          String(decision.proposalId),
        );
        if (dependencies.fulfillments !== undefined) {
          const ids = deriveFormationIds(
            snapshot.proposalId,
            snapshot.revision,
          );
          yield* dependencies.fulfillments.put({
            proposalId: snapshot.proposalId,
            proposalRevision: snapshot.revision,
            expectedChildWorkspaceId: ids.workspaceId,
            expectedInitialWorkId:
              snapshot.proposal.initialWork === undefined ? null : ids.workId,
            state: "Blocked",
            typedBlock: "FormationDelegationApprovalEvidenceInvalid",
            lastAttemptAt: event.occurredAt ?? new Date().toISOString(),
            revision: 2,
          });
        }
        continue;
      }
      const parent = yield* dependencies.workspaces.findById(
        snapshot.parentWorkspaceId,
      );
      if (Option.isNone(parent)) {
        console.error(
          "[formation-consumer] unknown parent workspace:",
          String(snapshot.parentWorkspaceId),
        );
        continue;
      }
      // The gated path re-checks the ceiling at execution time too: the
      // parent boundary may have moved since admission (P6 `03` §2).
      let canonicalBoundarySubsetVerified = false;
      if (dependencies.environment !== undefined) {
        const [resolvedParent, resolvedDraft] = yield* Effect.all(
          [
            dependencies.environment.resolve(
              projectId,
              parent.value.resourceBoundary.addresses,
            ),
            dependencies.environment.resolve(
              projectId,
              snapshot.proposal.resourceBoundaryDraft.addresses,
            ),
          ],
          { concurrency: 1 },
        );
        canonicalBoundarySubsetVerified =
          resolvedParent.observedEnvironmentRevision ===
            resolvedDraft.observedEnvironmentRevision &&
          resolvedDraft.regions.every((draftRegion) =>
            resolvedParent.regions.some((parentRegion) =>
              regionContains(
                parentRegion,
                draftRegion,
                resourceRegionComparator,
              ),
            ),
          );
        if (!canonicalBoundarySubsetVerified) {
          console.error(
            "[formation-consumer] canonical resource boundary draft escapes parent boundary:",
            String(snapshot.proposalId),
          );
          continue;
        }
      }
      const ceilingError = validateCapabilityCeiling({
        parentBoundary: parent.value.resourceBoundary,
        draftBoundary: snapshot.proposal.resourceBoundaryDraft,
        canonicalBoundarySubsetVerified,
      });
      if (ceilingError !== null) {
        console.error(
          "[formation-consumer] capability ceiling rejected the draft:",
          JSON.stringify(ceilingError).slice(0, 220),
        );
        continue;
      }
      const principal = decision.decidedBy as unknown as Principal;
      const ids = deriveFormationIds(snapshot.proposalId, snapshot.revision);
      const attemptedAt = event.occurredAt ?? new Date().toISOString();
      const fulfillment = (
        state: FormationFulfillmentRecord["state"],
        revision: number,
        typedBlock: string | null = null,
      ): FormationFulfillmentRecord => ({
        proposalId: snapshot.proposalId,
        proposalRevision: snapshot.revision,
        expectedChildWorkspaceId: ids.workspaceId,
        expectedInitialWorkId:
          snapshot.proposal.initialWork === undefined ? null : ids.workId,
        state,
        typedBlock,
        lastAttemptAt: attemptedAt,
        revision,
      });
      if (dependencies.fulfillments !== undefined) {
        yield* dependencies.fulfillments.put(
          fulfillment("PendingApplication", 1),
        );
      }
      const create = formationCreatePlan({
        snapshot,
        ids,
        projectId,
        actor: decision.decidedBy,
        principal,
        ...(decision.delegationApproval === undefined
          ? {}
          : { ownershipDelegationApproval: decision.delegationApproval }),
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
        if (dependencies.fulfillments !== undefined) {
          yield* dependencies.fulfillments.put(
            fulfillment(
              "Blocked",
              2,
              JSON.stringify(createReceipt.resolution).slice(0, 300),
            ),
          );
        }
        continue;
      }
      executed.push("CreateChildWorkspace");
      if (dependencies.fulfillments !== undefined) {
        yield* dependencies.fulfillments.put(
          fulfillment("WorkspaceCreated", 2),
        );
      }
      if (decision.delegationApproval !== undefined) {
        if (dependencies.ownershipWrite === undefined) {
          if (dependencies.fulfillments !== undefined) {
            yield* dependencies.fulfillments.put(
              fulfillment(
                "Blocked",
                3,
                "DelegatedOwnershipActivationServiceUnavailable",
              ),
            );
          }
          continue;
        }
        const activated = yield* Effect.match(
          dependencies.ownershipWrite.activateDelegatedOwnership({
            projectId,
            childWorkspaceId: ids.workspaceId,
            childResourceBoundaryRevision:
              create.payload.resourceBoundaryRevision,
            delegationSourceId: decision.delegationApproval.delegationSourceId,
          }),
          {
            onFailure: (error) => {
              const tag =
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                typeof error._tag === "string"
                  ? error._tag
                  : "UnknownActivationFailure";
              console.error(
                "[formation-consumer] delegated resource activation remains pending:",
                String(snapshot.proposalId),
                tag,
              );
              return false;
            },
            onSuccess: () => true,
          },
        );
        if (!activated) continue;
        executed.push("ActivateDelegatedOwnership");
      }

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
          if (dependencies.fulfillments !== undefined) {
            yield* dependencies.fulfillments.put(fulfillment("Applied", 3));
          }
        } else if (dependencies.fulfillments !== undefined) {
          yield* dependencies.fulfillments.put(
            fulfillment(
              "Blocked",
              3,
              JSON.stringify(assignReceipt.resolution).slice(0, 300),
            ),
          );
        }
      } else if (dependencies.fulfillments !== undefined) {
        yield* dependencies.fulfillments.put(fulfillment("Applied", 3));
      }
    }
    return executed;
  });
