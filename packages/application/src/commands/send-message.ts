import {
  type Actor,
  type CommandId,
  type MessageId,
  messageEntryKey,
  type OutboundMessage,
  type Principal,
  type ProjectId,
  promoteInboxArrival,
  type Workspace,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  InboxProjectionStoreService,
  MessageStoreService,
  PendingDomainEvent,
  TransactionScope,
  WorkspaceRepositoryError,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { VerifiedCommandAuthority } from "../authority.js";
import { commandErr, commandOk } from "../command-result.js";
import { semanticRequestFingerprint } from "../fingerprint.js";
import type { CommandHandler } from "../gateway.js";

const SEND_MESSAGE_SCHEMA_VERSION = "1";

/** P6 `02` §2: bodyRef is a ContentRef (bounded view), capped by the P6
 * frozen sender upload quota. */
const MAX_BODY_REF_LENGTH = 4096;

/** Parent-chain walk bound: cycle protection only (lineage depth itself is
 * owned by formation invariants). */
const MAX_ANCESTRY_DEPTH = 64;

/** P6 `02` §3. Caller-preallocated messageId; sender identity is bound by
 * the authority fact, never free-typed by the model. */
export interface SendMessagePayload {
  readonly messageId: MessageId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly message: OutboundMessage;
}

export interface SendMessageResult {
  readonly messageId: MessageId;
  readonly admitted: true;
  readonly promotion: {
    readonly closesCorrelation: string | null;
    readonly triggersReevaluation: boolean;
  };
}

export interface SendMessageDependencies {
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly messages: Pick<
    MessageStoreService,
    "append" | "closeCorrelation" | "isCorrelationClosed"
  >;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
}

/** `02` §2: Query may only target sender-side ancestors (walk the parent
 * chain upward; the sender itself is not its own ancestor). */
const recipientIsAncestorOfSender = (
  dependencies: Pick<SendMessageDependencies, "workspaces">,
  senderWorkspaceId: WorkspaceId,
  recipientWorkspaceId: WorkspaceId,
): Effect.Effect<boolean, WorkspaceRepositoryError, TransactionScope> =>
  Effect.gen(function* () {
    let current: WorkspaceId | null = senderWorkspaceId;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
      if (current === null) {
        return false;
      }
      const found: Option.Option<Workspace> =
        yield* dependencies.workspaces.findById(current);
      if (Option.isNone(found)) {
        return false;
      }
      const parent: WorkspaceId | null = found.value.parentWorkspaceId;
      if (parent === recipientWorkspaceId) {
        return true;
      }
      current = parent;
    }
    return false;
  });

/** P6 `02` §3. SendMessage is durable communication, not a canonical
 * mutation envelope: MessageStore append, the `MessageSent` fact, recipient
 * Inbox admission and the deterministic promotion step (Reply closes its
 * correlation; DecisionRequest flags reevaluation; Report/Query have zero
 * canonical effects — D2) all land in the gateway's single transaction. */
export const makeSendMessageHandler = (
  dependencies: SendMessageDependencies,
): CommandHandler<SendMessagePayload, SendMessageResult> => ({
  commandType: "SendMessage",
  schemaVersion: SEND_MESSAGE_SCHEMA_VERSION,
  authority: {
    tag: "SendMessageAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SendMessageAuthority" &&
      authority.senderWorkspaceId === payload.senderWorkspaceId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const message = payload.message;

      const recipientOption = yield* dependencies.workspaces.findById(
        message.recipientWorkspaceId,
      );
      if (Option.isNone(recipientOption)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: message.recipientWorkspaceId,
        });
      }
      const recipient = recipientOption.value;
      if (recipient.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "recipient belongs to another project",
        });
      }
      if (recipient.lifecycle !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Workspace",
          lifecycle: recipient.lifecycle,
        });
      }

      const senderOption = yield* dependencies.workspaces.findById(
        payload.senderWorkspaceId,
      );
      if (Option.isNone(senderOption)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "sender workspace not found",
        });
      }
      const sender = senderOption.value;

      switch (message.kind) {
        case "Query": {
          const isAncestor = yield* recipientIsAncestorOfSender(
            dependencies,
            sender.workspaceId,
            message.recipientWorkspaceId,
          );
          if (!isAncestor) {
            return commandErr({
              _tag: "AuthorityDenied",
              reason: "Query recipient must be an ancestor of the sender",
            });
          }
          break;
        }
        case "Report":
        case "DecisionRequest": {
          if (sender.parentWorkspaceId !== message.recipientWorkspaceId) {
            return commandErr({
              _tag: "AuthorityDenied",
              reason: `${message.kind} recipient must be the sender's parent`,
            });
          }
          break;
        }
        case "Reply": {
          if (message.correlationId === undefined) {
            return commandErr({
              _tag: "AuthorityDenied",
              reason: "Reply requires a correlationId",
            });
          }
          const closed = yield* dependencies.messages.isCorrelationClosed(
            message.correlationId,
          );
          if (closed) {
            return commandErr({
              _tag: "AuthorityDenied",
              reason: "Reply correlation is already closed",
            });
          }
          break;
        }
      }

      if (
        message.bodyRef.length === 0 ||
        message.bodyRef.length > MAX_BODY_REF_LENGTH
      ) {
        return commandErr({
          _tag: "ResourceExhausted",
          reason: `bodyRef must be 1..${MAX_BODY_REF_LENGTH} chars (got ${message.bodyRef.length})`,
        });
      }

      yield* dependencies.messages.append({
        messageId: payload.messageId,
        senderWorkspaceId: payload.senderWorkspaceId,
        message,
        sentAt: envelope.issuedAt,
      });

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "MessageSent",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.messageId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          ...(message.correlationId === undefined
            ? {}
            : { correlationRef: message.correlationId }),
          payload: {
            messageId: payload.messageId,
            kind: message.kind,
            sender: payload.senderWorkspaceId,
            recipient: message.recipientWorkspaceId,
            correlationId: message.correlationId ?? null,
            causationId: message.causationId ?? null,
          },
        },
      ];

      yield* dependencies.inbox.admitUpsert({
        recipientWorkspaceId: message.recipientWorkspaceId,
        entryKey: messageEntryKey(payload.messageId),
        kind: "Message",
        summary: `${message.kind} from ${payload.senderWorkspaceId}`,
        correlationId: message.correlationId,
        admittedAt: envelope.issuedAt,
      });

      const promotion = promoteInboxArrival({
        recipientWorkspaceId: message.recipientWorkspaceId,
        kind: message.kind,
        correlationId: message.correlationId,
      });
      if (promotion.closesCorrelation !== null) {
        yield* dependencies.messages.closeCorrelation(
          promotion.closesCorrelation,
        );
      }

      return commandOk({
        result: {
          messageId: payload.messageId,
          admitted: true as const,
          promotion: {
            closesCorrelation: promotion.closesCorrelation,
            triggersReevaluation: promotion.triggersReevaluation,
          },
        },
        events,
      });
    }),
});

export interface SendMessagePlan {
  readonly payload: SendMessagePayload;
  readonly authority: VerifiedCommandAuthority;
}

/** P6 `02` §5. The Communicate directive factory: builds the SendMessage
 * command payload plus its `SendMessageAuthority` from an OutboundMessage
 * with caller-preallocated ids (DID G5). The fingerprint is computed over
 * the exact payload the envelope will carry, so the directive handler can
 * forward both to the gateway unchanged. */
export const sendMessagePlan = (args: {
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly principal: Principal;
  readonly actor: Actor;
  readonly message: OutboundMessage;
}): SendMessagePlan => {
  const payload: SendMessagePayload = {
    messageId: args.messageId,
    senderWorkspaceId: args.senderWorkspaceId,
    message: args.message,
  };
  return {
    payload,
    authority: {
      _tag: "SendMessageAuthority",
      principal: args.principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SendMessage",
        projectId: args.projectId,
        actor: args.actor,
        schemaVersion: SEND_MESSAGE_SCHEMA_VERSION,
        payload,
      }),
      projectId: args.projectId,
      senderWorkspaceId: args.senderWorkspaceId,
    },
  };
};
