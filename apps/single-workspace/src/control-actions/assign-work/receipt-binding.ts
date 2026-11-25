import type { AgentAction, AgentActionError } from "@arbor/agent-runtime";
import { workEpisode } from "@arbor/domain";
import type {
  AssignWorkBindingFailureCode,
  AssignWorkTargetBinding,
  ControlApprovalStoreService,
  DomainEventJournalService,
  PermissionGrantRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  actionOperationalFailure,
  type PriorCommittedCommandReceipt,
} from "../command-receipts.js";

export const validateAssignWorkReceiptBinding = (input: {
  readonly binding: AssignWorkTargetBinding;
  readonly prior: PriorCommittedCommandReceipt;
  readonly action: Extract<AgentAction, { readonly _tag: "AssignWork" }>;
  readonly execution: import("@arbor/domain").Execution;
  readonly invocation: import("@arbor/model-context").ToolInvocation;
  readonly logicalActionId: string;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly tx: TransactionPortService;
  readonly journal: DomainEventJournalService;
  readonly grants: Pick<PermissionGrantRepositoryService, "findById">;
  readonly approvals: Pick<ControlApprovalStoreService, "findById">;
}): Effect.Effect<AssignWorkBindingFailureCode | null, AgentActionError> =>
  Effect.gen(function* () {
    const { binding, prior, action, execution, invocation } = input;
    const receipt = prior;
    if (
      binding.schemaVersion !== 1 ||
      binding.targetRefEncodingVersion !== 1 ||
      binding.targetLifecycleAtCommit !== "Active"
    ) {
      return "MalformedBinding";
    }
    if (
      binding.commandId !== receipt.commandId ||
      binding.projectId !== execution.projectId ||
      receipt.projectId !== execution.projectId ||
      binding.executionId !== execution.executionId
    ) {
      return "ReceiptMismatch";
    }
    if (
      binding.parentWorkspaceId !== execution.workspaceId ||
      binding.targetWorkspaceRef !== action.targetWorkspaceRef ||
      binding.targetWorkspaceRef === undefined ||
      binding.targetWorkspaceRef === "current"
    ) {
      return "RefMismatch";
    }
    if (
      binding.providerTurnId !== invocation.providerTurnId ||
      binding.logicalActionId !== input.logicalActionId ||
      binding.callRef !== invocation.callRef
    ) {
      return "SourceActionMismatch";
    }
    const actionDigest = sha256Hex(
      JSON.stringify({
        stableActionId: "core.control.assign-work",
        action,
      }),
    );
    if (
      binding.authority.actionDigest !== actionDigest ||
      binding.authority.targetRef !== binding.targetWorkspaceRef
    ) {
      return "AuthorityMismatch";
    }
    const receiptResult = receipt.resolution.result;
    if (
      typeof receiptResult !== "object" ||
      receiptResult === null ||
      !("workId" in receiptResult) ||
      receiptResult.workId !== binding.workId ||
      !("workspaceId" in receiptResult) ||
      receiptResult.workspaceId !== binding.targetWorkspaceId ||
      !("lifecycle" in receiptResult) ||
      receiptResult.lifecycle !== "Open" ||
      !("revision" in receiptResult) ||
      receiptResult.revision !== 0
    ) {
      return "ReceiptMismatch";
    }
    const parent = yield* input.tx.transact(
      input.workspaces.findById(binding.parentWorkspaceId),
    );
    const target = yield* input.tx.transact(
      input.workspaces.findById(binding.targetWorkspaceId),
    );
    const parentWork = yield* input.tx.transact(
      input.works.findById(binding.parentWorkId),
    );
    const work = yield* input.tx.transact(input.works.findById(binding.workId));
    if (
      Option.isNone(parent) ||
      Option.isNone(target) ||
      parent.value.projectId !== binding.projectId ||
      target.value.projectId !== binding.projectId ||
      target.value.parentWorkspaceId !== binding.parentWorkspaceId
    ) {
      return "ForeignTarget";
    }
    if (
      Option.isNone(parentWork) ||
      parentWork.value.projectId !== binding.projectId ||
      parentWork.value.workspaceId !== binding.parentWorkspaceId ||
      binding.parentWorkId !== workEpisode(execution)?.workId
    ) {
      return "PlacementMismatch";
    }
    const expectedProvenance = {
      predecessorWorkId: binding.parentWorkId,
      reason: action.reason,
    };
    if (
      binding.predecessorWorkId !== binding.parentWorkId ||
      binding.workProvenanceJson !== JSON.stringify(expectedProvenance)
    ) {
      return "ProvenanceMismatch";
    }
    if (
      Option.isNone(work) ||
      work.value.projectId !== binding.projectId ||
      work.value.workspaceId !== binding.targetWorkspaceId ||
      work.value.objective !== action.objective ||
      work.value.why !== action.why ||
      JSON.stringify(work.value.constraints) !==
        JSON.stringify(action.constraints) ||
      work.value.completionExpectation !== action.completionExpectation ||
      JSON.stringify(work.value.verificationMission) !==
        JSON.stringify(action.verificationMission) ||
      JSON.stringify(work.value.provenance) !== binding.workProvenanceJson
    ) {
      return "WorkMismatch";
    }
    if (binding.authority._tag === "PermissionGrant") {
      const grant = yield* input.tx.transact(
        input.grants.findById(binding.authority.permissionGrantId),
      );
      if (
        Option.isNone(grant) ||
        grant.value.revision !== binding.authority.permissionGrantRevision ||
        grant.value.capability !== binding.authority.capability ||
        grant.value.target !== binding.authority.targetRef ||
        grant.value.validFrom !== binding.authority.validFrom ||
        (grant.value.expiresAt ?? null) !== binding.authority.expiresAt ||
        (binding.authority.subjectKind === "WorkspaceAgent" &&
          (grant.value.subject?._tag !== "WorkspaceAgent" ||
            grant.value.subject.workspaceId !==
              binding.authority.subjectRef)) ||
        (binding.authority.subjectKind === "Execution" &&
          (grant.value.subject?._tag !== "Execution" ||
            grant.value.subject.executionId !== binding.authority.subjectRef))
      ) {
        return "AuthorityMismatch";
      }
    } else {
      const approval = yield* input.tx.transact(
        input.approvals.findById(binding.authority.approvalId),
      );
      if (
        Option.isNone(approval) ||
        approval.value.bindingProven !== true ||
        approval.value.state !== "Consumed" ||
        approval.value.revision !== binding.authority.approvalRevision + 1 ||
        approval.value.consumedBy !== binding.commandId ||
        approval.value.projectId !== binding.authority.projectId ||
        approval.value.workspaceId !== binding.authority.workspaceId ||
        approval.value.executionId !== binding.authority.executionId ||
        approval.value.stableActionId !== binding.authority.stableActionId ||
        approval.value.actionDigest !== binding.authority.actionDigest ||
        approval.value.targetRef !== binding.authority.targetRef ||
        approval.value.controlBasisDigest !==
          binding.authority.controlBasisDigest ||
        approval.value.expiresAt !== binding.authority.expiresAt
      ) {
        return "AuthorityMismatch";
      }
    }
    const events = yield* input.tx.transact(
      Effect.gen(function* () {
        const last = yield* input.journal.lastSequence(binding.projectId);
        return last === 0
          ? []
          : yield* input.journal.readAfter(binding.projectId, 0, last);
      }),
    );
    const workAssigned = events.filter((event) => {
      if (
        event.eventType !== "WorkAssigned" ||
        event.causedByCommandId !== binding.commandId ||
        event.aggregateRef !== binding.targetWorkspaceId
      ) {
        return false;
      }
      const payload =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      return (
        payload.workId === binding.workId &&
        payload.workspaceId === binding.targetWorkspaceId &&
        payload.projectId === binding.projectId &&
        payload.objective === action.objective
      );
    });
    if (workAssigned.length !== 1) return "EventMismatch";
    return null;
  }).pipe(
    Effect.mapError(actionOperationalFailure("AssignWork.bindingValidation")),
  );
