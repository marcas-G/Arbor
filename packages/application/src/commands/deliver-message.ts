import type {
  Actor,
  CommandId,
  DeliverableId,
  MessageId,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  DeliverableRepositoryService,
  MessageStoreService,
  InboxProjectionStoreService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { VerifiedCommandAuthority } from "../authority.js";
import { semanticRequestFingerprint } from "../fingerprint.js";
import type { CommandHandler } from "../gateway.js";
import { makeSendMessageHandler } from "./send-message.js";
import type { SendMessagePayload, SendMessageResult } from "./send-message.js";

export interface DeliverMessagePayload {
  readonly messageId: MessageId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly deliverableId: DeliverableId;
  readonly bodyRef: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface DeliverMessageResult {
  readonly messageId: MessageId;
  readonly deliverableId: DeliverableId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly recipientWorkspaceId: WorkspaceId;
  readonly admitted: true;
}

export interface DeliverMessagePlan {
  readonly payload: DeliverMessagePayload;
  readonly authority: VerifiedCommandAuthority;
}

export const deliverMessagePlan = (args: {
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly deliverableId: DeliverableId;
  readonly bodyRef: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly principal: Principal;
  readonly actor: Actor;
}): DeliverMessagePlan => {
  const payload: DeliverMessagePayload = {
    messageId: args.messageId,
    senderWorkspaceId: args.senderWorkspaceId,
    deliverableId: args.deliverableId,
    bodyRef: args.bodyRef,
    ...(args.correlationId === undefined
      ? {}
      : { correlationId: args.correlationId }),
    ...(args.causationId === undefined
      ? {}
      : { causationId: args.causationId }),
  };
  return {
    payload,
    authority: {
      _tag: "SendMessageAuthority",
      principal: args.principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "DeliverMessage",
        projectId: args.projectId,
        actor: args.actor,
        schemaVersion: "1",
        payload,
      }),
      projectId: args.projectId,
      senderWorkspaceId: args.senderWorkspaceId,
    },
  };
};

export interface DeliverMessageDependencies {
  readonly deliverables: Pick<DeliverableRepositoryService, "findById">;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly messages: Pick<
    MessageStoreService,
    "append" | "closeCorrelation" | "isCorrelationClosed"
  >;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
}

/** P7 DeliverMessage/1 is a distinct Gateway command. It reuses the frozen
 * SendMessage validation and write path while specializing the P7 inbox
 * summary and event payload inside this command's transaction. */
export const makeDeliverMessageHandler = (
  dependencies: DeliverMessageDependencies,
): CommandHandler<DeliverMessagePayload, DeliverMessageResult> => ({
    commandType: "DeliverMessage",
    schemaVersion: "1",
    authority: {
      tag: "SendMessageAuthority",
      targetMatches: (authority, payload) =>
        authority._tag === "SendMessageAuthority" &&
        authority.senderWorkspaceId === payload.senderWorkspaceId,
    },
    stopAdmission: { _tag: "NormalExecutionMutation" },
    execute: (envelope, context) =>
      Effect.gen(function* () {
        const payload = envelope.payload;
        const deliverable = yield* dependencies.deliverables.findById(
          payload.deliverableId,
        );
        if (Option.isNone(deliverable)) {
          return {
            ok: false as const,
            error: {
              _tag: "DeliverableNotFound" as const,
              deliverableId: payload.deliverableId,
            },
          };
        }
        const sourceWork = yield* dependencies.works.findById(
          deliverable.value.sourceWorkId,
        );
        if (
          Option.isNone(sourceWork) ||
          sourceWork.value.projectId !== envelope.projectId ||
          sourceWork.value.workspaceId !== payload.senderWorkspaceId
        ) {
          return {
            ok: false as const,
            error: {
              _tag: "AuthorityDenied" as const,
              reason: "sender must own the deliverable source work",
            },
          };
        }
        const sender = yield* dependencies.workspaces.findById(
          payload.senderWorkspaceId,
        );
        if (Option.isNone(sender)) {
          return {
            ok: false as const,
            error: {
              _tag: "AuthorityDenied" as const,
              reason: "sender workspace not found",
            },
          };
        }
        const recipientWorkspaceId = sender.value.parentWorkspaceId;
        if (recipientWorkspaceId === null) {
          return {
            ok: false as const,
            error: {
              _tag: "AuthorityDenied" as const,
              reason: "root has no parent to deliver to",
            },
          };
        }

        const messagePayload: SendMessagePayload = {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: {
            kind: "Deliver",
            recipientWorkspaceId,
            deliverableId: payload.deliverableId,
            bodyRef: payload.bodyRef,
            ...(payload.correlationId === undefined
              ? {}
              : { correlationId: payload.correlationId }),
            ...(payload.causationId === undefined
              ? {}
              : { causationId: payload.causationId }),
            urgency: "Normal",
          },
        };
        const sendMessage = makeSendMessageHandler({
          workspaces: dependencies.workspaces,
          messages: dependencies.messages,
          inbox: {
            admitUpsert: (entry) =>
              dependencies.inbox.admitUpsert({
                ...entry,
                summary: `Deliver ${payload.deliverableId} from ${payload.senderWorkspaceId}`,
              }),
          },
        });
        const sendEnvelope = {
          ...envelope,
          commandType: "DeliverMessage",
          payload: messagePayload,
        };
        const sent = yield* sendMessage.execute(sendEnvelope, context);
        if (!sent.ok) return sent;

        return {
          ok: true as const,
          value: {
            result: {
              messageId: payload.messageId,
              deliverableId: payload.deliverableId,
              senderWorkspaceId: payload.senderWorkspaceId,
              recipientWorkspaceId,
              admitted: true,
            },
            events: sent.value.events.map((event) =>
              event.eventType === "MessageSent"
                ? {
                    ...event,
                    payload: {
                      ...(event.payload as Record<string, unknown>),
                      deliverableId: payload.deliverableId,
                    },
                  }
                : event,
            ),
          },
        };
      }),
  });

