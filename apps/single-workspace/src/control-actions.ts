import type {
  AgentAction,
  AgentActionError,
  AgentActionHandler,
} from "@arbor/agent-runtime";
import { reviseLocalPlan } from "@arbor/agent-runtime";
import {
  type AcceptWorkOutcomePayload,
  type AcceptWorkOutcomeResult,
  type AssignWorkPayload,
  type AssignWorkResult,
  CommandGateway,
  type CommandGatewayService,
  type ConcludeVerificationPayload,
  type ConcludeVerificationResult,
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  deriveFormationIds,
  isChildWorkspaceProposal,
  makeSendMessageHandler,
  newFormationProposalId,
  newUuid7,
  type ProduceDeliverablePayload,
  type ProduceDeliverableResult,
  type RecordVerificationEvidencePayload,
  type RecordVerificationEvidenceResult,
  semanticRequestFingerprint,
  sendMessagePlan,
  submitDeliver,
  type VerifiedCommandAuthority,
} from "@arbor/application";
import {
  AcceptanceId,
  type ArtifactRole,
  admitFormationProposal,
  type ChildWorkspaceProposal,
  CommandId,
  type CommandId as CommandIdType,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  EvidenceId,
  executionEpisode,
  type MessageId,
  MessageId as MessageIdSchema,
  type OutboundMessage,
  parse,
  Revision,
  ToolInvocationId,
  WorkId,
  WorkRevision,
  workEpisode,
} from "@arbor/domain";
import {
  BlobStorePort,
  type BlobStorePortService,
  Clock,
  type ClockService,
  DecisionRequestStore,
  type DecisionRequestStoreService,
  DeliverableRepository,
  type DeliverableRepositoryService,
  DomainEventJournal,
  type DomainEventJournalService,
  FormationFulfillmentStore,
  type FormationFulfillmentStoreService,
  FormationProposalStore,
  type FormationProposalStoreService,
  IdGenerator,
  type IdGeneratorService,
  InboxProjectionStore,
  type InboxProjectionStoreService,
  LocalPlanStore,
  type LocalPlanStoreService,
  type MessageRecord,
  MessageStore,
  type MessageStoreService,
  SessionRepository,
  type SessionRepositoryService,
  ToolInvocationStore,
  type ToolInvocationStoreService,
  TransactionPort,
  type TransactionPortService,
  VerificationRepository,
  type VerificationRepositoryService,
  WorkRepository,
  type WorkRepositoryService,
  WorkspacePlacementPort,
  type WorkspacePlacementPortService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
  WorkWaitStore,
  type WorkWaitStoreService,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export class SingleWorkspaceControlActionHandlers extends Context.Service<
  SingleWorkspaceControlActionHandlers,
  ReadonlyArray<AgentActionHandler>
>()("arbor/SingleWorkspaceControlActionHandlers") {}

export interface SendMessageDependencies {
  readonly gateway: CommandGatewayService;
  readonly blobs: BlobStorePortService;
  readonly clock: ClockService;
  readonly messages: MessageStoreService;
  readonly tx: TransactionPortService;
  readonly workspaces: WorkspaceRepositoryService;
}

export interface ClaimCompletionDependencies {
  readonly works: WorkRepositoryService;
  readonly tx: TransactionPortService;
  readonly waits?: Pick<
    WorkWaitStoreService,
    "upsert" | "findByWork" | "clear"
  >;
  readonly clock: ClockService;
}

export interface AssignWorkDependencies {
  readonly gateway: CommandGatewayService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly placement?: WorkspacePlacementPortService;
}

export interface WorkspacePlacementDependencies {
  readonly placement: WorkspacePlacementPortService;
}

export interface AcceptResultDependencies {
  readonly gateway: CommandGatewayService;
  readonly placement: WorkspacePlacementPortService;
  readonly clock: ClockService;
}

export interface UpdatePlanDependencies {
  readonly works: WorkRepositoryService;
  readonly plans: LocalPlanStoreService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
}

export interface SelectCurrentWorkDependencies {
  readonly gateway: CommandGatewayService;
  readonly decisions: DecisionRequestStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
}

export interface ProposeChildDependencies {
  readonly proposals: FormationProposalStoreService;
  readonly fulfillments?: Pick<FormationFulfillmentStoreService, "put">;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
  readonly clock: ClockService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly tx: TransactionPortService;
}

export interface DeclareDependencyDependencies {
  readonly gateway: CommandGatewayService;
  readonly works: WorkRepositoryService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
}

export interface ProduceDeliverableDependencies {
  readonly gateway: CommandGatewayService;
  readonly clock: ClockService;
}

export interface DeliverActionDependencies {
  readonly deliverables: DeliverableRepositoryService;
  readonly works: WorkRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly messages: MessageStoreService;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
  readonly journal: DomainEventJournalService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly ids: IdGeneratorService;
}

export interface VerificationActionDependencies {
  readonly gateway: CommandGatewayService;
  readonly blobs: BlobStorePortService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findByExecutionId"
  >;
  readonly sessions: Pick<SessionRepositoryService, "listEntries">;
  readonly toolInvocations: Pick<ToolInvocationStoreService, "findById">;
}

const actionError = (
  safeMessage: string,
  code: Extract<
    AgentActionError,
    { readonly _tag: "AgentActionRejected" }
  >["code"] = "action/precondition",
  correction: Extract<
    AgentActionError,
    { readonly _tag: "AgentActionRejected" }
  >["correction"] = "ChooseAlternative",
): AgentActionError => ({
  _tag: "AgentActionRejected",
  code,
  safeMessage,
  correction,
});

const actionOperationalFailure =
  (operation: string) =>
  (cause: unknown): AgentActionError =>
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "AgentActionRejected" ||
      cause._tag === "AgentActionOperationalFailure")
      ? (cause as AgentActionError)
      : {
          _tag: "AgentActionOperationalFailure",
          operation,
          cause,
        };

/** DID v1.26 VDC-5: model authors bounded Work semantics and the readable
 * provenance reason. Runtime binds target, identities, revisions,
 * predecessor and authority. */
export const assignWorkHandler = (
  dependencies: AssignWorkDependencies,
): AgentActionHandler => ({
  action: "AssignWork",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "AssignWork") {
        return yield* Effect.fail(
          actionOperationalFailure("AssignWork.dispatch")(
            "AssignWork handler received a different AgentAction",
          ),
        );
      }
      const episode = executionEpisode(execution);
      if (
        episode?._tag === "ConversationResponseEpisode" &&
        action.targetWorkspaceId !== undefined &&
        action.targetWorkspaceId !== execution.workspaceId
      ) {
        return yield* Effect.fail(
          actionError(
            "Root conversation can assign Work only to its current Workspace",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      let targetWorkspaceId = action.targetWorkspaceId ?? execution.workspaceId;
      if (action.targetWorkspaceRef !== undefined) {
        if (action.targetWorkspaceRef === "current") {
          targetWorkspaceId = execution.workspaceId;
        } else {
          if (dependencies.placement === undefined) {
            return yield* Effect.fail(
              actionError(
                "Workspace placement resolver is unavailable",
                "action/tool-unavailable",
                "WaitForStateChange",
              ),
            );
          }
          const resolved = yield* dependencies.placement.resolveChildRef(
            execution.workspaceId,
            action.targetWorkspaceRef,
          );
          if (Option.isNone(resolved)) {
            return yield* Effect.fail(
              actionError(
                "targetWorkspaceRef is stale, foreign, retired, or not a direct child",
                "action/target-unavailable",
                "RetryWithChangedInput",
              ),
            );
          }
          targetWorkspaceId = resolved.value;
        }
      }
      const target = yield* dependencies.tx.transact(
        dependencies.workspaces.findById(targetWorkspaceId),
      );
      if (Option.isNone(target)) {
        return yield* Effect.fail(
          actionError("AssignWork target Workspace is missing"),
        );
      }
      const structurallyAuthorized =
        targetWorkspaceId === execution.workspaceId ||
        target.value.parentWorkspaceId === execution.workspaceId;
      if (
        !structurallyAuthorized ||
        target.value.projectId !== execution.projectId ||
        target.value.lifecycle !== "Active"
      ) {
        return yield* Effect.fail(
          actionError(
            "AssignWork target must be the current Workspace or its active direct child",
            "action/target-unavailable",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload: AssignWorkPayload = {
        workId: parse(WorkId)(`wrk_${newUuid7("assign-work", occurrence)}`),
        workspaceId: targetWorkspaceId,
        expectedWorkspaceRevision: target.value.revision,
        objective: action.objective,
        why: action.why,
        constraints: action.constraints,
        completionExpectation: action.completionExpectation,
        verificationMission: action.verificationMission,
        provenance: {
          predecessorWorkId: workEpisode(execution)?.workId ?? null,
          reason: action.reason,
        },
        revision: parse(WorkRevision)(0),
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("assign-work-command", occurrence)}`,
      );
      const receipt = yield* dependencies.gateway.execute<
        AssignWorkPayload,
        AssignWorkResult
      >(
        {
          commandType: "AssignWork",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "AssignWorkAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AssignWork",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          targetWorkspaceId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "AssignWork failed operationally",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `WorkAssigned(${receipt.resolution.result.workId}, ${targetWorkspaceId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("AssignWork"))),
});

const listWorkspacesHandler = (
  dependencies: WorkspacePlacementDependencies,
): AgentActionHandler => ({
  action: "ListWorkspaces",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ListWorkspaces") {
        return yield* Effect.fail(
          actionOperationalFailure("ListWorkspaces.dispatch")(
            "ListWorkspaces handler received a different AgentAction",
          ),
        );
      }
      const snapshot = yield* dependencies.placement.list({
        rootWorkspaceId: execution.workspaceId,
        ...(action.cursor === undefined ? {} : { cursor: action.cursor }),
        ...(action.query === undefined ? {} : { query: action.query }),
      });
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify(snapshot),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ListWorkspaces"))),
});

const readWorkspaceHandler = (
  dependencies: WorkspacePlacementDependencies,
): AgentActionHandler => ({
  action: "ReadWorkspace",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ReadWorkspace") {
        return yield* Effect.fail(
          actionOperationalFailure("ReadWorkspace.dispatch")(
            "ReadWorkspace handler received a different AgentAction",
          ),
        );
      }
      const candidate = yield* dependencies.placement.read(
        execution.workspaceId,
        action.workspaceRef,
      );
      if (Option.isNone(candidate)) {
        return yield* Effect.fail(
          actionError(
            "workspaceRef is stale, foreign, retired, or outside direct-child scope",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify(candidate.value),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ReadWorkspace"))),
});

export const acceptResultHandler = (
  dependencies: AcceptResultDependencies,
): AgentActionHandler => ({
  action: "AcceptResult",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "AcceptResult") {
        return yield* Effect.fail(
          actionOperationalFailure("AcceptResult.dispatch")(
            "AcceptResult handler received a different AgentAction",
          ),
        );
      }
      const resolved = yield* dependencies.placement.resolveResultRef(
        execution.workspaceId,
        action.resultRef,
      );
      if (Option.isNone(resolved)) {
        return yield* Effect.fail(
          actionError(
            "resultRef is stale, already accepted, non-PASS, foreign, or not from an active direct child",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload: AcceptWorkOutcomePayload = {
        acceptanceId: parse(AcceptanceId)(
          `acc_${newUuid7("accept-child-result", occurrence)}`,
        ),
        workId: resolved.value.workId,
        targetWorkRevision: resolved.value.workRevision,
        verificationId: resolved.value.verificationId,
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("accept-child-result-command", occurrence)}`,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        AcceptWorkOutcomePayload,
        AcceptWorkOutcomeResult
      >(
        {
          commandType: "AcceptWorkOutcome",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "AcceptanceAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AcceptWorkOutcome",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          targetWorkspaceId: execution.workspaceId,
          workId: resolved.value.workId,
          verificationId: resolved.value.verificationId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "AcceptWorkOutcome failed operationally",
            "action/canonical-rejected",
            "WaitForStateChange",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `WorkOutcomeAccepted(${resolved.value.workId}, ${resolved.value.verificationId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("AcceptResult"))),
});

const isPendingQuery = (record: MessageRecord) =>
  record.message.kind === "Query" && record.message.correlationId !== undefined;

const bindReplyTarget = (
  dependencies: SendMessageDependencies,
  input: {
    readonly execution: import("@arbor/domain").Execution;
    readonly queryMessageId?: MessageId;
  },
) =>
  Effect.gen(function* () {
    const incoming = yield* dependencies.tx.transact(
      dependencies.messages.listByRecipient(input.execution.workspaceId),
    );
    const open: Array<MessageRecord> = [];
    for (const record of incoming) {
      if (!isPendingQuery(record)) continue;
      const closed = yield* dependencies.tx.transact(
        dependencies.messages.isCorrelationClosed(
          record.message.correlationId as string,
        ),
      );
      if (!closed) open.push(record);
    }
    const selected =
      input.queryMessageId === undefined
        ? open.length === 1
          ? open[0]
          : undefined
        : open.find((record) => record.messageId === input.queryMessageId);
    if (selected === undefined) {
      return yield* Effect.fail(
        actionError(
          open.length === 0
            ? "Reply has no eligible pending Query"
            : input.queryMessageId === undefined
              ? "Reply target is ambiguous across pending Queries"
              : "Reply target is missing, stale, closed, or not an eligible Query",
        ),
      );
    }
    return {
      recipientWorkspaceId: selected.senderWorkspaceId,
      correlationId: selected.message.correlationId as string,
    };
  });

const resolveTarget = (
  dependencies: SendMessageDependencies,
  action: Extract<AgentAction, { readonly _tag: "SendMessage" }>,
  execution: import("@arbor/domain").Execution,
) =>
  Effect.gen(function* () {
    switch (action.kind) {
      case "Query":
        if (action.recipientWorkspaceId === undefined) {
          return yield* Effect.fail(
            actionError("Query requires a model-selected recipient"),
          );
        }
        return { recipientWorkspaceId: action.recipientWorkspaceId };
      case "Reply":
        return yield* bindReplyTarget(dependencies, {
          execution,
          ...(action.queryMessageId !== undefined
            ? { queryMessageId: action.queryMessageId }
            : {}),
        });
      case "Report":
      case "DecisionRequest": {
        const sender = yield* dependencies.tx.transact(
          dependencies.workspaces.findById(execution.workspaceId),
        );
        if (Option.isNone(sender)) {
          return yield* Effect.fail(
            actionError("SendMessage sender Workspace is missing"),
          );
        }
        if (sender.value.parentWorkspaceId === null) {
          return yield* Effect.fail(
            actionError(
              `${action.kind} from a root Workspace has no parent target`,
              "action/not-applicable",
              "ChooseAlternative",
            ),
          );
        }
        return { recipientWorkspaceId: sender.value.parentWorkspaceId };
      }
    }
  });

const deterministicIds = (
  providerTurnId: string,
  outputPosition: number,
): { readonly messageId: MessageId; readonly commandId: CommandIdType } => {
  const occurrence = `${providerTurnId}:${outputPosition}`;
  return {
    messageId: parse(MessageIdSchema)(
      `msg_${newUuid7("send-message-message", occurrence)}`,
    ),
    commandId: parse(CommandId)(
      `cmd_${newUuid7("send-message-command", occurrence)}`,
    ),
  };
};

const sendMessageHandler = (
  dependencies: SendMessageDependencies,
): AgentActionHandler => ({
  action: "SendMessage",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "SendMessage") {
        return yield* Effect.fail(
          actionOperationalFailure("SendMessage.dispatch")(
            "SendMessage handler received a different AgentAction",
          ),
        );
      }
      const target = yield* resolveTarget(dependencies, action, execution);
      const bytes = new TextEncoder().encode(action.body);
      const bodyRef = yield* dependencies.blobs.put(bytes);
      const resolvedBytes = yield* dependencies.blobs.get(bodyRef);
      if (
        resolvedBytes.length !== bytes.length ||
        resolvedBytes.some((byte, index) => byte !== bytes[index])
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("SendMessage.blobRoundTrip")(
            "persisted message body did not resolve to submitted bytes",
          ),
        );
      }

      const occurrenceIds = deterministicIds(
        invocation.providerTurnId,
        invocation.outputPosition,
      );
      const correlationId =
        action.kind === "Query"
          ? `cor_${newUuid7(
              "send-message-correlation",
              `${invocation.providerTurnId}:${invocation.outputPosition}`,
            )}`
          : "correlationId" in target
            ? target.correlationId
            : undefined;
      const message: OutboundMessage = {
        kind: action.kind,
        recipientWorkspaceId: target.recipientWorkspaceId,
        bodyRef,
        urgency: "Normal",
        ...(correlationId !== undefined ? { correlationId } : {}),
      };

      const plan = sendMessagePlan({
        ...occurrenceIds,
        projectId: execution.projectId,
        senderWorkspaceId: execution.workspaceId,
        principal: context.principal,
        actor: context.principal as never,
        message,
      });
      const receipt = yield* dependencies.gateway.execute<
        import("@arbor/application").SendMessagePayload,
        import("@arbor/application").SendMessageResult
      >(
        {
          commandType: "SendMessage",
          commandId: occurrenceIds.commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload: plan.payload,
        },
        context,
        plan.authority,
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational SendMessage failure";
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `SendMessage rejected: ${reason}`,
            truncated: false,
          },
        };
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `MessageDelivered(${receipt.resolution.result.messageId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("SendMessage"))),
});

export const updatePlanHandler = (
  dependencies: UpdatePlanDependencies,
): AgentActionHandler => ({
  action: "UpdatePlan",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "UpdatePlan") {
        return yield* Effect.fail(
          actionError("UpdatePlan received a different AgentAction"),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "update_plan is available only inside an exact Work episode",
            "action/not-applicable",
          ),
        );
      }
      const updatedAt = yield* dependencies.clock.now();
      const plan = yield* dependencies.tx.transact(
        Effect.gen(function* () {
          const work = yield* dependencies.works.findById(boundWork.workId);
          if (Option.isNone(work) || work.value.lifecycle !== "Open") {
            return yield* Effect.fail(
              actionError("planned Work is missing or no longer Open"),
            );
          }
          if (work.value.revision !== boundWork.targetWorkRevision) {
            return yield* Effect.fail(
              actionError(
                "Work revision changed; refresh context before updating its plan",
                "action/precondition",
                "WaitForStateChange",
              ),
            );
          }
          const current = yield* dependencies.plans.findByWork(
            boundWork.workId,
          );
          const expectedPlanRevision = Option.isSome(current)
            ? current.value.revision
            : 0;
          const revised = reviseLocalPlan({
            current: Option.getOrNull(current),
            workId: boundWork.workId,
            targetWorkRevision: boundWork.targetWorkRevision,
            expectedRevision: expectedPlanRevision,
            items: action.items,
            updatedAt,
          });
          if (!revised.ok) {
            return yield* Effect.fail(
              actionError(
                revised.error._tag === "LocalPlanInvalid"
                  ? revised.error.reason
                  : "plan revision changed",
                "action/precondition",
                "RetryWithChangedInput",
              ),
            );
          }
          yield* dependencies.plans.save(revised.value, expectedPlanRevision);
          return revised.value;
        }),
      );
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify({
            planRevision: plan.revision,
            items: plan.items,
            authority: "progress-only",
          }),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("UpdatePlan"))),
});

export const selectCurrentWorkHandler = (
  dependencies: SelectCurrentWorkDependencies,
): AgentActionHandler => ({
  action: "SelectCurrentWork",
  handle: ({ action, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "SelectCurrentWork") {
        return yield* Effect.fail(
          actionError("SelectCurrentWork received a different AgentAction"),
        );
      }
      const episode = executionEpisode(execution);
      if (episode?._tag !== "DecisionEpisode") {
        return yield* Effect.fail(
          actionError(
            "select_current_work requires an exact DecisionEpisode",
            "action/not-applicable",
          ),
        );
      }
      const request = yield* dependencies.tx.transact(
        dependencies.decisions.findById(episode.decisionId),
      );
      if (
        Option.isNone(request) ||
        request.value.state._tag !== "Pending" ||
        request.value.revision !== episode.requestRevision ||
        !request.value.candidateWorkIds.includes(action.workId)
      ) {
        return yield* Effect.fail(
          actionError(
            "selected Work is not an eligible candidate for this DecisionRequest",
            "action/precondition",
            "RetryWithChangedInput",
          ),
        );
      }
      const commandId = parse(CommandId)(
        `cmd_${String(episode.decisionId).slice("dec_".length)}`,
      );
      const payload = {
        workspaceId: execution.workspaceId,
        workId: action.workId,
        expectedWorkspaceRevision: request.value.workspaceRevision,
      };
      const authority: VerifiedCommandAuthority = {
        _tag: "SelectCurrentWorkAuthority",
        principal: context.principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SelectCurrentWork",
          projectId: execution.projectId,
          actor: context.principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: execution.projectId,
        targetWorkspaceId: execution.workspaceId,
      };
      const receipt = yield* dependencies.gateway.execute(
        {
          commandType: "SelectCurrentWork",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        authority,
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            "canonical Work selection was rejected",
            "action/canonical-rejected",
            "WaitForStateChange",
          ),
        );
      }
      yield* dependencies.tx.transact(
        dependencies.decisions.submit({
          decisionId: episode.decisionId,
          expectedRevision: episode.requestRevision,
          selectedWorkId: action.workId,
          updatedAt: yield* dependencies.clock.now(),
        }),
      );
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "DecisionSubmitted" as const,
            decisionId: episode.decisionId,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("SelectCurrentWork"))),
});

/** ACR-8 (DID v1.19): the producer claims its Work complete. The
 * workRevision is a trusted Runtime fact read from the store (never
 * model-supplied); the claimRef is deterministic per provider-turn
 * occurrence so replays converge; the downstream StartVerification is
 * driven by the existing verification consumer — this handler never
 * completes the Work itself. */
const claimCompletionHandler = (
  dependencies: ClaimCompletionDependencies,
): AgentActionHandler => ({
  action: "ClaimCompletion",
  handle: ({ action, invocation, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ClaimCompletion") {
        return yield* Effect.fail(
          actionOperationalFailure("ClaimCompletion.dispatch")(
            "ClaimCompletion handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "ClaimCompletion requires an active Work binding to claim against",
          ),
        );
      }
      const workId = boundWork.workId;
      const work = yield* dependencies.tx.transact(
        dependencies.works.findById(workId),
      );
      if (Option.isNone(work)) {
        return yield* Effect.fail(actionError("claimed Work is missing"));
      }
      if (work.value.lifecycle !== "Open") {
        return yield* Effect.fail(
          actionError(
            `ClaimCompletion requires an Open Work, found ${work.value.lifecycle}`,
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      if (dependencies.waits !== undefined) {
        const now = yield* dependencies.clock.now();
        yield* dependencies.tx.transact(
          dependencies.waits.upsert({
            workId,
            waitSpec: {
              mode: "Any",
              conditions: [
                {
                  _tag: "VerificationChanged",
                  workId,
                  targetWorkRevision: parse(Revision)(
                    Number(work.value.revision),
                  ),
                },
              ],
            },
            registeredAt: now,
            updatedAt: now,
          }),
        );
      }
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "CompletionClaimed" as const,
            workRevision: work.value.revision,
            claimRef: `clm_${newUuid7("completion-claim", occurrence)}`,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ClaimCompletion"))),
});

/** ACR-8 (DID v1.19): P6 formation semantics are closed. The handler
 * persists a Pending proposal only — the human RecordDecision gate (and the
 * formation consumer that creates the child on Approve) stays untouched.
 * `basisResponsibilityRevision` is bound from the workspace's current
 * responsibility revision (trusted Runtime fact, never model-supplied). */
const proposeChildWorkspaceHandler = (
  dependencies: ProposeChildDependencies,
): AgentActionHandler => ({
  action: "ProposeChildWorkspace",
  handle: ({ action, execution }) =>
    Effect.gen(function* () {
      if (action._tag !== "ProposeChildWorkspace") {
        return yield* Effect.fail(
          actionOperationalFailure("ProposeChildWorkspace.dispatch")(
            "ProposeChildWorkspace handler received a different AgentAction",
          ),
        );
      }
      const sender = yield* dependencies.tx.transact(
        dependencies.workspaces.findById(execution.workspaceId),
      );
      if (Option.isNone(sender)) {
        return yield* Effect.fail(
          actionError("proposing Workspace is missing"),
        );
      }
      const proposal: ChildWorkspaceProposal = {
        name: action.proposal.name,
        rationale: action.proposal.rationale,
        responsibilityDraft: action.proposal.responsibilityDraft,
        resourceBoundaryDraft: {
          basisResponsibilityRevision: sender.value.responsibilityRevision,
          addresses: action.proposal.resourceBoundaryDraft.addresses,
        },
        ...(action.proposal.initialWork === undefined
          ? {}
          : { initialWork: action.proposal.initialWork }),
      };
      if (!isChildWorkspaceProposal(proposal)) {
        return yield* Effect.fail(
          actionOperationalFailure("ProposeChildWorkspace.domainGuard")(
            "decoded proposal failed the domain proposal guard",
          ),
        );
      }
      const record = admitFormationProposal({
        proposalId: newFormationProposalId(),
        parentWorkspaceId: execution.workspaceId,
        proposal,
      });
      const admittedAt = yield* dependencies.clock.now();
      const formationIds = deriveFormationIds(
        record.proposalId,
        record.revision,
      );
      yield* dependencies.tx.transact(
        Effect.gen(function* () {
          yield* dependencies.proposals.insert(record);
          if (dependencies.fulfillments !== undefined) {
            yield* dependencies.fulfillments.put({
              proposalId: record.proposalId,
              proposalRevision: record.revision,
              expectedChildWorkspaceId: formationIds.workspaceId,
              expectedInitialWorkId:
                record.proposal.initialWork === undefined
                  ? null
                  : formationIds.workId,
              state: "AwaitingDecision",
              typedBlock: null,
              lastAttemptAt: null,
              revision: 0,
            });
          }
          yield* dependencies.inbox.admitUpsert({
            recipientWorkspaceId: record.parentWorkspaceId,
            entryKey: `gov:${record.proposalId}:${record.revision}`,
            kind: "Governance",
            summary: `formation proposal "${record.proposal.name}" revision ${record.revision} awaiting human decision`,
            admittedAt,
          });
        }),
      );
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `ProposalRecorded(${record.proposalId}); awaiting a human RecordDecision (Approve/Reject/Modify)`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ProposeChildWorkspace"))),
});

/** ACR-8 (DID v1.19): P7 dependency lifecycle is frozen. The handler
 * submits DeclareDependency through the gateway with a synthesized
 * DeclareDependencyAuthority (P7 §2 fact projection binds targetWorkspaceId
 * to the workspace owning consumerWorkId). dependencyId and
 * expectedConsumerWorkRevision are trusted Runtime facts — the current
 * Work revision is read from the store, never model-supplied; declaring
 * never asserts satisfaction (the matcher alone decides). */
const declareDependencyHandler = (
  dependencies: DeclareDependencyDependencies,
): AgentActionHandler => ({
  action: "DeclareDependency",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "DeclareDependency") {
        return yield* Effect.fail(
          actionOperationalFailure("DeclareDependency.dispatch")(
            "DeclareDependency handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "DeclareDependency requires an active Work binding as the consumer",
          ),
        );
      }
      const workId = boundWork.workId;
      const work = yield* dependencies.tx.transact(
        dependencies.works.findById(workId),
      );
      if (Option.isNone(work)) {
        return yield* Effect.fail(actionError("consuming Work is missing"));
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload = {
        dependencyId: parse(DependencyId)(
          `dep_${newUuid7("declare-dependency", occurrence)}`,
        ),
        consumerWorkId: workId,
        producerBinding: action.producerBinding,
        expectedDeliverable: {
          kind: action.expectedDeliverable.kind as DeliverableKind,
          requiredArtifactRoles: action.expectedDeliverable
            .requiredArtifactRoles as ArtifactRole[],
        },
        expectedConsumerWorkRevision: work.value.revision,
        revision: parse(DependencyRevision)(0),
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("declare-dependency-command", occurrence)}`,
      );
      const receipt = yield* dependencies.gateway.execute<
        DeclareDependencyPayload,
        DeclareDependencyResult
      >(
        {
          commandType: "DeclareDependency",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "DeclareDependencyAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "DeclareDependency",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload: payload as unknown,
          }),
          projectId: execution.projectId,
          targetWorkspaceId: execution.workspaceId,
          consumerWorkId: workId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational DeclareDependency failure";
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `DeclareDependency rejected: ${reason}`,
            truncated: false,
          },
        };
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DependencyDeclared(${receipt.resolution.result.dependencyId}, Unsatisfied)`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("DeclareDependency"))),
});

export const produceDeliverableHandler = (
  dependencies: ProduceDeliverableDependencies,
): AgentActionHandler => ({
  action: "ProduceDeliverable",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "ProduceDeliverable") {
        return yield* Effect.fail(
          actionOperationalFailure("ProduceDeliverable.dispatch")(
            "ProduceDeliverable handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "produce_deliverable requires an exact WorkEpisode",
            "action/not-applicable",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload: ProduceDeliverablePayload = {
        deliverableId: parse(DeliverableId)(
          `del_${newUuid7("produce-deliverable", occurrence)}`,
        ),
        sourceWorkId: boundWork.workId,
        observedSourceWorkRevision: boundWork.targetWorkRevision,
        kind: action.kind as DeliverableKind,
        artifacts: action.artifacts.map((artifact) => ({
          role: artifact.role as ArtifactRole,
          artifactId: artifact.artifactId,
        })),
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("produce-deliverable-command", occurrence)}`,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        ProduceDeliverablePayload,
        ProduceDeliverableResult
      >(
        {
          commandType: "ProduceDeliverable",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "ProduceDeliverableAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "ProduceDeliverable",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          sourceWorkspaceId: execution.workspaceId,
          sourceWorkId: boundWork.workId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "ProduceDeliverable failed operationally",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DeliverableProduced(${payload.deliverableId}, ${action.kind})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ProduceDeliverable"))),
});

export const deliverHandler = (
  dependencies: DeliverActionDependencies,
): AgentActionHandler => ({
  action: "Deliver",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "Deliver") {
        return yield* Effect.fail(
          actionOperationalFailure("Deliver.dispatch")(
            "Deliver handler received a different AgentAction",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("deliver-command", occurrence)}`,
      );
      const messageId = parse(MessageIdSchema)(
        `msg_${newUuid7("deliver-message", occurrence)}`,
      );
      const sendMessage = makeSendMessageHandler({
        workspaces: dependencies.workspaces,
        messages: dependencies.messages,
        inbox: dependencies.inbox,
      });
      const submission = yield* dependencies.tx.transact(
        submitDeliver(
          {
            senderWorkspaceId: execution.workspaceId,
            deliverableId: action.deliverableId,
            bodyRef: action.summary,
            commandId,
            messageId,
            projectId: execution.projectId,
            actor: context.principal as never,
            principal: context.principal,
          },
          {
            deliverables: dependencies.deliverables,
            works: dependencies.works,
            workspaces: dependencies.workspaces,
            sendMessage,
            inbox: dependencies.inbox,
            journal: dependencies.journal,
            clock: dependencies.clock,
          },
        ).pipe(Effect.provideService(IdGenerator, dependencies.ids)),
      );
      if (submission._tag === "Rejected") {
        return yield* Effect.fail(
          actionError(
            JSON.stringify(submission.rejection),
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DeliverableDelivered(${action.deliverableId}, ${submission.outcome.recipientWorkspaceId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("Deliver"))),
});

const verifierBinding = (
  dependencies: VerificationActionDependencies,
  executionId: import("@arbor/domain").ExecutionId,
) =>
  dependencies.tx.transact(
    dependencies.verifications.findByExecutionId(executionId),
  );

const toolResultMatchesSettlement = (
  status: string,
  settlement: import("@arbor/ports").ToolInvocationSettlement | null,
): boolean => {
  if (settlement === null) return false;
  switch (status) {
    case "Succeeded":
      return settlement._tag === "Success";
    case "Failed":
      return (
        settlement._tag === "ExpectedFailure" ||
        settlement._tag === "RuntimeFailure"
      );
    case "Interrupted":
      return settlement._tag === "Interrupted";
    case "OutcomeUnknown":
      return settlement._tag === "OutcomeUnknown";
    default:
      return false;
  }
};

const recordVerificationEvidenceHandler = (
  dependencies: VerificationActionDependencies,
): AgentActionHandler => ({
  action: "RecordVerificationEvidence",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "RecordVerificationEvidence") {
        return yield* Effect.fail(
          actionOperationalFailure("RecordVerificationEvidence.dispatch")(
            "verification evidence handler received another action",
          ),
        );
      }
      const verification = yield* verifierBinding(
        dependencies,
        execution.executionId,
      );
      if (Option.isNone(verification)) {
        return yield* Effect.fail(
          actionError("execution is not bound to a Verification"),
        );
      }
      const entries = yield* dependencies.tx.transact(
        dependencies.sessions.listEntries(execution.sessionId, -1, 10_000),
      );
      const visibleResults = [...entries].reverse().filter((entry) => {
        const payload = entry.payload as {
          readonly _tag?: unknown;
          readonly status?: unknown;
        };
        return (
          payload._tag === "ToolResult" &&
          (payload.status === "Succeeded" ||
            payload.status === "Failed" ||
            payload.status === "Interrupted" ||
            payload.status === "OutcomeUnknown")
        );
      });
      const exact = visibleResults.find(
        (entry) =>
          (entry.payload as { readonly callRef?: unknown }).callRef ===
          action.sourceCallRef,
      );
      const ordinal = /^\d+$/u.test(action.sourceCallRef)
        ? Number(action.sourceCallRef)
        : 0;
      const resultEntry =
        exact ?? (ordinal > 0 ? visibleResults[ordinal - 1] : undefined);
      if (resultEntry === undefined) {
        return yield* Effect.fail(
          actionError(
            "sourceCallRef has no visible terminal ToolResult (exact callRef or newest-first ordinal)",
          ),
        );
      }
      const result = resultEntry.payload as {
        readonly _tag: "ToolResult";
        readonly callRef: string;
        readonly invocationId?: string;
        readonly observationRef: string;
        readonly status: string;
      };
      if (
        typeof result.invocationId !== "string" ||
        typeof result.observationRef !== "string"
      ) {
        return yield* Effect.fail(
          actionError(
            "ToolObservation source must carry canonical invocation identity",
          ),
        );
      }
      let toolInvocationId: import("@arbor/domain").ToolInvocationId;
      try {
        toolInvocationId = parse(ToolInvocationId)(result.invocationId);
      } catch {
        return yield* Effect.fail(
          actionError(
            "ToolObservation invocation identity is invalid",
            "action/precondition",
            "RetryWithChangedInput",
          ),
        );
      }
      const storedInvocation = yield* dependencies.tx.transact(
        dependencies.toolInvocations.findById(toolInvocationId),
      );
      if (
        Option.isNone(storedInvocation) ||
        storedInvocation.value.executionId !== execution.executionId ||
        storedInvocation.value.settledAt === null ||
        !toolResultMatchesSettlement(
          result.status,
          storedInvocation.value.settlement,
        )
      ) {
        return yield* Effect.fail(
          actionError(
            "ToolObservation source is missing, unsettled, inconsistent, or belongs to another execution",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const evidenceId = parse(EvidenceId)(
        `evd_${newUuid7("verification-evidence", occurrence)}`,
      );
      const payload: RecordVerificationEvidencePayload = {
        verificationId: verification.value.verificationId,
        evidence: {
          evidenceId,
          criterionId: action.criterionId,
          kind: "ToolObservation",
          toolInvocationId,
          observationRef: result.observationRef,
          callRef: result.callRef,
          recordedAt: yield* dependencies.clock.now(),
        },
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("record-verification-evidence", occurrence)}`,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        RecordVerificationEvidencePayload,
        RecordVerificationEvidenceResult
      >(
        {
          commandType: "RecordVerificationEvidence",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "VerifierExecutionAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "RecordVerificationEvidence",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          verificationId: verification.value.verificationId,
          executionId: execution.executionId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "evidence command failed operationally",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `VerificationEvidenceRecorded(${evidenceId}, ${action.criterionId})`,
          truncated: false,
        },
      };
    }).pipe(
      Effect.mapError(actionOperationalFailure("RecordVerificationEvidence")),
    ),
});

const concludeVerificationHandler = (
  dependencies: VerificationActionDependencies,
): AgentActionHandler => ({
  action: "ConcludeVerification",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "ConcludeVerification") {
        return yield* Effect.fail(
          actionOperationalFailure("ConcludeVerification.dispatch")(
            "verification conclusion handler received another action",
          ),
        );
      }
      const verification = yield* verifierBinding(
        dependencies,
        execution.executionId,
      );
      if (Option.isNone(verification)) {
        return yield* Effect.fail(
          actionError("execution is not bound to a Verification"),
        );
      }
      const summaryBytes = new TextEncoder().encode(action.summary);
      const summaryRef = yield* dependencies.blobs.put(summaryBytes);
      const resolved = yield* dependencies.blobs.get(summaryRef);
      if (
        resolved.length !== summaryBytes.length ||
        resolved.some((byte, index) => byte !== summaryBytes[index])
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("ConcludeVerification.blobRoundTrip")(
            "persisted verification summary failed byte validation",
          ),
        );
      }
      const payload: ConcludeVerificationPayload = {
        verificationId: verification.value.verificationId,
        verdict: action.verdict,
        criteriaResults: action.criteriaResults,
        summaryRef,
      };
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("conclude-verification", occurrence)}`,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        ConcludeVerificationPayload,
        ConcludeVerificationResult
      >(
        {
          commandType: "ConcludeVerification",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "VerifierExecutionAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "ConcludeVerification",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          verificationId: verification.value.verificationId,
          executionId: execution.executionId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "verification conclusion failed operationally",
          ),
        );
      }
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "VerificationConcluded" as const,
            verificationId: verification.value.verificationId,
            verdict: action.verdict,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ConcludeVerification"))),
});

export const makeSingleWorkspaceControlActionHandlers = (
  dependencies: SendMessageDependencies &
    AssignWorkDependencies &
    ClaimCompletionDependencies &
    ProposeChildDependencies &
    DeclareDependencyDependencies &
    ProduceDeliverableDependencies &
    Partial<Pick<UpdatePlanDependencies, "plans">> &
    Partial<Pick<SelectCurrentWorkDependencies, "decisions">> &
    Partial<WorkspacePlacementDependencies> &
    Partial<
      Pick<DeliverActionDependencies, "deliverables" | "journal" | "ids">
    > &
    Partial<
      Pick<
        VerificationActionDependencies,
        "verifications" | "sessions" | "toolInvocations"
      >
    >,
): ReadonlyArray<AgentActionHandler> => {
  const handlers: AgentActionHandler[] = [
    sendMessageHandler(dependencies),
    assignWorkHandler(dependencies),
    claimCompletionHandler(dependencies),
    proposeChildWorkspaceHandler(dependencies),
    declareDependencyHandler(dependencies),
    produceDeliverableHandler(dependencies),
  ];
  const {
    plans,
    decisions,
    placement,
    deliverables,
    journal,
    ids,
    verifications,
    sessions,
    toolInvocations,
  } = dependencies;
  if (placement !== undefined) {
    handlers.push(
      listWorkspacesHandler({ placement }),
      readWorkspaceHandler({ placement }),
      acceptResultHandler({
        placement,
        gateway: dependencies.gateway,
        clock: dependencies.clock,
      }),
    );
  }
  if (
    deliverables !== undefined &&
    journal !== undefined &&
    ids !== undefined
  ) {
    handlers.push(
      deliverHandler({
        deliverables,
        journal,
        ids,
        works: dependencies.works,
        workspaces: dependencies.workspaces,
        messages: dependencies.messages,
        inbox: dependencies.inbox,
        clock: dependencies.clock,
        tx: dependencies.tx,
      }),
    );
  }
  if (plans !== undefined) {
    handlers.push(updatePlanHandler({ ...dependencies, plans }));
  }
  if (decisions !== undefined) {
    handlers.push(selectCurrentWorkHandler({ ...dependencies, decisions }));
  }
  if (
    verifications !== undefined &&
    sessions !== undefined &&
    toolInvocations !== undefined
  ) {
    const verificationDependencies: VerificationActionDependencies = {
      ...dependencies,
      verifications,
      sessions,
      toolInvocations,
    };
    handlers.push(
      recordVerificationEvidenceHandler(verificationDependencies),
      concludeVerificationHandler(verificationDependencies),
    );
  }
  return handlers;
};

export const SingleWorkspaceControlActionHandlersLive: Layer.Layer<
  SingleWorkspaceControlActionHandlers,
  never,
  | CommandGateway
  | BlobStorePort
  | Clock
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
  | TransactionPort
  | WorkRepository
  | LocalPlanStore
  | DecisionRequestStore
  | DeliverableRepository
  | DomainEventJournal
  | IdGenerator
  | WorkWaitStore
  | WorkspaceRepository
  | SessionRepository
  | ToolInvocationStore
  | VerificationRepository
> = Layer.effect(
  SingleWorkspaceControlActionHandlers,
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const blobs = yield* BlobStorePort;
    const clock = yield* Clock;
    const messages = yield* MessageStore;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const plans = yield* LocalPlanStore;
    const decisions = yield* DecisionRequestStore;
    const deliverables = yield* DeliverableRepository;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const waits = yield* WorkWaitStore;
    const workspaces = yield* WorkspaceRepository;
    const proposals = yield* FormationProposalStore;
    const fulfillments = yield* Effect.serviceOption(FormationFulfillmentStore);
    const placement = yield* Effect.serviceOption(WorkspacePlacementPort);
    const inbox = yield* InboxProjectionStore;
    const verifications = yield* VerificationRepository;
    const toolInvocations = yield* ToolInvocationStore;
    return SingleWorkspaceControlActionHandlers.of(
      makeSingleWorkspaceControlActionHandlers({
        gateway,
        blobs,
        clock,
        messages,
        tx,
        works,
        plans,
        decisions,
        deliverables,
        journal,
        ids,
        waits,
        workspaces,
        proposals,
        ...(Option.isSome(fulfillments)
          ? { fulfillments: fulfillments.value }
          : {}),
        ...(Option.isSome(placement) ? { placement: placement.value } : {}),
        inbox,
        verifications,
        sessions: yield* SessionRepository,
        toolInvocations,
      }),
    );
  }),
);
