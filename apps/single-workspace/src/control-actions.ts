import type {
  AgentAction,
  AgentActionError,
  AgentActionHandler,
} from "@arbor/agent-runtime";
import {
  CommandGateway,
  type CommandGatewayService,
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  isChildWorkspaceProposal,
  newFormationProposalId,
  newUuid7,
  semanticRequestFingerprint,
  sendMessagePlan,
} from "@arbor/application";
import {
  type ArtifactRole,
  admitFormationProposal,
  type ChildWorkspaceProposal,
  CommandId,
  type CommandId as CommandIdType,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  ExecutionId,
  type MessageId,
  MessageId as MessageIdSchema,
  type OutboundMessage,
  parse,
  SessionId,
} from "@arbor/domain";
import {
  BlobStorePort,
  type BlobStorePortService,
  Clock,
  type ClockService,
  FormationProposalStore,
  type FormationProposalStoreService,
  type MessageRecord,
  MessageStore,
  type MessageStoreService,
  TransactionPort,
  type TransactionPortService,
  WorkRepository,
  type WorkRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
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
}

export interface ProposeChildDependencies {
  readonly proposals: FormationProposalStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly tx: TransactionPortService;
}

export interface SpawnSpecialistDependencies {
  readonly gateway: CommandGatewayService;
  readonly clock: ClockService;
}

export interface DeclareDependencyDependencies {
  readonly gateway: CommandGatewayService;
  readonly works: WorkRepositoryService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
}

const actionError = (cause: unknown): AgentActionError => ({
  _tag: "AgentActionError",
  cause,
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
          actionError("SendMessage handler received a different AgentAction"),
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
          actionError(
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
    }).pipe(Effect.mapError(actionError)),
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
          actionError(
            "ClaimCompletion handler received a different AgentAction",
          ),
        );
      }
      if (
        execution.binding._tag !== "WorkspaceExecution" ||
        execution.binding.focus._tag !== "Work"
      ) {
        return yield* Effect.fail(
          actionError(
            "ClaimCompletion requires an active Work binding to claim against",
          ),
        );
      }
      const workId = execution.binding.focus.workId;
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
    }).pipe(Effect.mapError(actionError)),
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
          actionError(
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
          actionError("decoded proposal failed the domain proposal guard"),
        );
      }
      const record = admitFormationProposal({
        proposalId: newFormationProposalId(),
        parentWorkspaceId: execution.workspaceId,
        proposal,
      });
      yield* dependencies.tx.transact(dependencies.proposals.insert(record));
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `ProposalRecorded(${record.proposalId}); awaiting a human RecordDecision (Approve/Reject/Modify)`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionError)),
});

/** ACR-8 (DID v1.19): P2 ExecutionBound admission is frozen. The handler
 * submits AdmitExecution(ExecutionBound) through the gateway with the
 * ExecutionOrigin submission context of the spawning execution; the
 * executionId/sessionId/commandId are deterministic per provider-turn
 * occurrence so replays converge on the same specialist execution. No
 * durable Workspace, responsibility, or permission is created. */
const spawnSpecialistHandler = (
  dependencies: SpawnSpecialistDependencies,
): AgentActionHandler => ({
  action: "SpawnSpecialist",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "SpawnSpecialist") {
        return yield* Effect.fail(
          actionError(
            "SpawnSpecialist handler received a different AgentAction",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload = {
        _tag: "ExecutionBound" as const,
        executionId: parse(ExecutionId)(
          `exe_${newUuid7("specialist-execution", occurrence)}`,
        ),
        workspaceId: execution.workspaceId,
        parentExecutionId: execution.executionId,
        mission:
          action.constraints.length > 0
            ? `${action.mission} (constraints: ${action.constraints.join("; ")})`
            : action.mission,
        sessionId: parse(SessionId)(
          `ses_${newUuid7("specialist-session", occurrence)}`,
        ),
      };
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("specialist-command", occurrence)}`,
      );
      const receipt = yield* dependencies.gateway.execute(
        {
          commandType: "AdmitExecution",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "AdmitExecutionAuthority",
          submissionOrigin:
            context._tag === "RecoveryController" ? "System" : context._tag,
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AdmitExecution",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload: payload as unknown,
          }),
          projectId: execution.projectId,
          commandKind: "AdmitExecution",
          workspaceId: execution.workspaceId,
          bindingKind: "ExecutionBound",
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational AdmitExecution failure";
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `SpawnSpecialist rejected: ${reason}`,
            truncated: false,
          },
        };
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `SpecialistAdmitted(${payload.executionId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionError)),
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
          actionError(
            "DeclareDependency handler received a different AgentAction",
          ),
        );
      }
      if (
        execution.binding._tag !== "WorkspaceExecution" ||
        execution.binding.focus._tag !== "Work"
      ) {
        return yield* Effect.fail(
          actionError(
            "DeclareDependency requires an active Work binding as the consumer",
          ),
        );
      }
      const workId = execution.binding.focus.workId;
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
    }).pipe(Effect.mapError(actionError)),
});

export const makeSingleWorkspaceControlActionHandlers = (
  dependencies: SendMessageDependencies &
    ClaimCompletionDependencies &
    ProposeChildDependencies &
    SpawnSpecialistDependencies &
    DeclareDependencyDependencies,
): ReadonlyArray<AgentActionHandler> => [
  sendMessageHandler(dependencies),
  claimCompletionHandler(dependencies),
  proposeChildWorkspaceHandler(dependencies),
  spawnSpecialistHandler(dependencies),
  declareDependencyHandler(dependencies),
];

export const SingleWorkspaceControlActionHandlersLive: Layer.Layer<
  SingleWorkspaceControlActionHandlers,
  never,
  | CommandGateway
  | BlobStorePort
  | Clock
  | FormationProposalStore
  | MessageStore
  | TransactionPort
  | WorkRepository
  | WorkspaceRepository
> = Layer.effect(
  SingleWorkspaceControlActionHandlers,
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const blobs = yield* BlobStorePort;
    const clock = yield* Clock;
    const messages = yield* MessageStore;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    const proposals = yield* FormationProposalStore;
    return SingleWorkspaceControlActionHandlers.of(
      makeSingleWorkspaceControlActionHandlers({
        gateway,
        blobs,
        clock,
        messages,
        tx,
        works,
        workspaces,
        proposals,
      }),
    );
  }),
);
