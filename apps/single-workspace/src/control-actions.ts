import type {
  AgentAction,
  AgentActionError,
  AgentActionHandler,
} from "@arbor/agent-runtime";
import {
  CommandGateway,
  type CommandGatewayService,
  newUuid7,
  sendMessagePlan,
} from "@arbor/application";
import {
  CommandId,
  type CommandId as CommandIdType,
  type MessageId,
  MessageId as MessageIdSchema,
  type OutboundMessage,
  parse,
} from "@arbor/domain";
import {
  BlobStorePort,
  type BlobStorePortService,
  Clock,
  type ClockService,
  type MessageRecord,
  MessageStore,
  type MessageStoreService,
  TransactionPort,
  type TransactionPortService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export class SliceControlActionHandlers extends Context.Service<
  SliceControlActionHandlers,
  ReadonlyArray<AgentActionHandler>
>()("arbor/SliceControlActionHandlers") {}

export interface SendMessageDependencies {
  readonly gateway: CommandGatewayService;
  readonly blobs: BlobStorePortService;
  readonly clock: ClockService;
  readonly messages: MessageStoreService;
  readonly tx: TransactionPortService;
  readonly workspaces: WorkspaceRepositoryService;
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

export const makeSliceControlActionHandlers = (
  dependencies: SendMessageDependencies,
): ReadonlyArray<AgentActionHandler> => [sendMessageHandler(dependencies)];

export const SliceControlActionHandlersLive: Layer.Layer<
  SliceControlActionHandlers,
  never,
  | CommandGateway
  | BlobStorePort
  | Clock
  | MessageStore
  | TransactionPort
  | WorkspaceRepository
> = Layer.effect(
  SliceControlActionHandlers,
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const blobs = yield* BlobStorePort;
    const clock = yield* Clock;
    const messages = yield* MessageStore;
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    return SliceControlActionHandlers.of(
      makeSliceControlActionHandlers({
        gateway,
        blobs,
        clock,
        messages,
        tx,
        workspaces,
      }),
    );
  }),
);
