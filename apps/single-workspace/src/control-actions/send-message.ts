import type { AgentAction, AgentActionHandler } from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  newUuid7,
  sendMessagePlan,
} from "@arbor/application";
import {
  type MessageId,
  MessageId as MessageIdSchema,
  type OutboundMessage,
  parse,
} from "@arbor/domain";
import type {
  BlobStorePortService,
  ClockService,
  CommandStoreService,
  MessageRecord,
  MessageStoreService,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  actionError,
  actionOperationalFailure,
  generationScopedCommandId,
  findPriorCommandReceipt,
} from "./command-receipts.js";

export interface SendMessageDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<
    CommandStoreService,
    "findResolution" | "hasRetryableAttempt"
  >;
  readonly blobs: BlobStorePortService;
  readonly clock: ClockService;
  readonly messages: MessageStoreService;
  readonly tx: TransactionPortService;
  readonly workspaces: WorkspaceRepositoryService;
}

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

const deterministicMessageId = (
  providerTurnId: string,
  outputPosition: number,
): MessageId => {
  const occurrence = `${providerTurnId}:${outputPosition}`;
  return parse(MessageIdSchema)(
    `msg_${newUuid7("send-message-message", occurrence)}`,
  );
};

export const sendMessageHandler = (
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
      const bytes = new TextEncoder().encode(action.body);
      const persistBody = () =>
        Effect.gen(function* () {
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
          return bodyRef;
        });
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const messageId = deterministicMessageId(
        invocation.providerTurnId,
        invocation.outputPosition,
      );
      const queryCorrelationId =
        action.kind === "Query"
          ? `cor_${newUuid7("send-message-correlation", occurrence)}`
          : undefined;
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "send-message-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "SendMessage",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "SendMessage.priorReceipt",
          errorOperation: "SendMessage",
          lookupOperation: "SendMessage.receiptLookup",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("messageId" in result) ||
            result.messageId !== messageId ||
            !("admitted" in result) ||
            result.admitted !== true
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SendMessage.priorReceipt")(
                "prior Committed result does not match the pinned message",
              ),
            );
          }
          const bodyRef = yield* persistBody();
          const record = yield* dependencies.tx.transact(
            dependencies.messages.findById(messageId),
          );
          if (
            Option.isNone(record) ||
            record.value.messageId !== messageId ||
            record.value.senderWorkspaceId !== execution.workspaceId ||
            record.value.message.kind !== action.kind ||
            record.value.message.bodyRef !== bodyRef ||
            record.value.message.urgency !== "Normal" ||
            record.value.message.causationId !== undefined
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SendMessage.priorReceipt")(
                "Committed receipt has no exact matching canonical Message row",
              ),
            );
          }
          const sender = yield* dependencies.tx.transact(
            dependencies.workspaces.findById(execution.workspaceId),
          );
          const recipient = yield* dependencies.tx.transact(
            dependencies.workspaces.findById(
              record.value.message.recipientWorkspaceId,
            ),
          );
          if (
            Option.isNone(sender) ||
            sender.value.projectId !== execution.projectId ||
            Option.isNone(recipient) ||
            recipient.value.projectId !== execution.projectId
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SendMessage.priorReceipt")(
                "canonical Message sender or recipient is missing or belongs to another Project",
              ),
            );
          }
          if (action.kind === "Query") {
            if (
              record.value.message.recipientWorkspaceId !==
                action.recipientWorkspaceId ||
              record.value.message.correlationId !== queryCorrelationId
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("SendMessage.priorReceipt")(
                  "Committed Query does not match its pinned recipient or correlationId",
                ),
              );
            }
          } else if (
            action.kind === "Report" ||
            action.kind === "DecisionRequest"
          ) {
            if (
              sender.value.parentWorkspaceId === null ||
              record.value.message.recipientWorkspaceId !==
                sender.value.parentWorkspaceId ||
              record.value.message.correlationId !== undefined
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("SendMessage.priorReceipt")(
                  "Committed upward Message does not match its pinned Workspace route",
                ),
              );
            }
          } else {
            const correlationId = record.value.message.correlationId;
            if (correlationId === undefined) {
              return yield* Effect.fail(
                actionOperationalFailure("SendMessage.priorReceipt")(
                  "Committed Reply has no correlationId",
                ),
              );
            }
            const incoming = yield* dependencies.tx.transact(
              dependencies.messages.listByRecipient(execution.workspaceId),
            );
            const matchingQueries = incoming.filter(
              (candidate) =>
                candidate.message.kind === "Query" &&
                candidate.message.correlationId === correlationId &&
                candidate.message.recipientWorkspaceId ===
                  execution.workspaceId &&
                candidate.senderWorkspaceId ===
                  record.value.message.recipientWorkspaceId,
            );
            if (
              matchingQueries.length !== 1 ||
              (action.queryMessageId !== undefined &&
                matchingQueries[0]?.messageId !== action.queryMessageId) ||
              !(yield* dependencies.tx.transact(
                dependencies.messages.isCorrelationClosed(correlationId),
              ))
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("SendMessage.priorReceipt")(
                  "Committed Reply has no exact matching closed Query correlation",
                ),
              );
            }
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `MessageDelivered(${messageId})`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `SendMessage rejected: ${JSON.stringify(prior.receipt.resolution.error)}`,
              truncated: false,
            },
          };
        }
      }
      const target = yield* resolveTarget(dependencies, action, execution);
      const bodyRef = yield* persistBody();
      const correlationId =
        queryCorrelationId ??
        ("correlationId" in target ? target.correlationId : undefined);
      const message: OutboundMessage = {
        kind: action.kind,
        recipientWorkspaceId: target.recipientWorkspaceId,
        bodyRef,
        urgency: "Normal",
        ...(correlationId !== undefined ? { correlationId } : {}),
      };

      const commandId = generationScopedCommandId(
        "send-message-command",
        occurrence,
        context,
      );
      const plan = sendMessagePlan({
        messageId,
        commandId,
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
          commandId,
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
