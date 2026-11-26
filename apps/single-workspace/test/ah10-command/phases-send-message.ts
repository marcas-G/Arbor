import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import type { WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  actionHandlerFromRegistry,
  childWorkspaceId,
  queryMessageId,
  replyAction,
  replyCorrelationId,
  replyInvocation,
  runControlHandler,
  sendAction,
  sendInvocation,
  workspaceId,
} from "./support.js";

export const sendUsesNewCommandIdKeepingMessageIds =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const messageRows = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
      readonly messageId: string;
      readonly correlationId: string | undefined;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        const payload = envelope.payload as {
          readonly messageId: string;
          readonly senderWorkspaceId: WorkspaceId;
          readonly message: {
            readonly kind: string;
            readonly recipientWorkspaceId: WorkspaceId;
            readonly bodyRef: string;
            readonly urgency: string;
            readonly correlationId?: string;
          };
        };
        calls.push({
          commandId,
          generation,
          messageId: payload.messageId,
          correlationId: payload.message.correlationId,
        });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        if (generation === 0) {
          const rejected = {
            resolution: {
              _tag: "TerminalRejected" as const,
              error: { _tag: "FencingRejected" as const },
            },
          };
          receipts.set(commandId, rejected);
          return Effect.succeed(rejected);
        }
        messageRows.set(payload.messageId, {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: payload.message,
          sentAt: "2026-10-05T00:00:00.000Z",
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              messageId: payload.messageId,
              admitted: true,
              promotion: {
                closesCorrelation: null,
                triggersReevaluation: false,
              },
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "SendMessage",
      gateway,
      receipts,
      new Map(),
      undefined,
      new Map(),
      messageRows,
    );

    await runControlHandler(handler, sendAction, 0, sendInvocation);
    const currentOwner = await runControlHandler(
      handler,
      sendAction,
      1,
      sendInvocation,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.messageId).toBe(calls[1]?.messageId);
    expect(calls[0]?.correlationId).toBe(calls[1]?.correlationId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "send-message-command",
        `${sendInvocation.providerTurnId}:${sendInvocation.outputPosition}`,
      )}`,
    );
  };

export const sendConvergesCommittedMessage = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const messageRows = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const payload = envelope.payload as {
        readonly messageId: string;
        readonly senderWorkspaceId: WorkspaceId;
        readonly message: unknown;
      };
      messageRows.set(payload.messageId, {
        messageId: payload.messageId,
        senderWorkspaceId: payload.senderWorkspaceId,
        message: payload.message,
        sentAt: "2026-10-05T00:00:00.000Z",
      });
      const committed = {
        resolution: {
          _tag: "Committed" as const,
          result: {
            messageId: payload.messageId,
            admitted: true,
            promotion: {
              closesCorrelation: null,
              triggersReevaluation: false,
            },
          },
        },
      };
      receipts.set(commandId, committed);
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;
  const handler = actionHandlerFromRegistry(
    "SendMessage",
    gateway,
    receipts,
    new Map(),
    undefined,
    new Map(),
    messageRows,
  );

  await runControlHandler(handler, sendAction, 0, sendInvocation);
  const converged = await runControlHandler(
    handler,
    sendAction,
    1,
    sendInvocation,
  );

  expect(converged).toMatchObject({
    _tag: "Accepted",
    outcome: { _tag: "Observation" },
  });
  expect(calls).toHaveLength(1);
};

export const sendConvergesReplyAfterClosedCorrelation =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const messageRows = new Map<string, unknown>([
      [
        String(queryMessageId),
        {
          messageId: queryMessageId,
          senderWorkspaceId: childWorkspaceId,
          message: {
            kind: "Query",
            recipientWorkspaceId: workspaceId,
            bodyRef: "blob_query",
            correlationId: replyCorrelationId,
            urgency: "Normal",
          },
          sentAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    ]);
    const closedCorrelations = new Set<string>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly messageId: string;
          readonly senderWorkspaceId: WorkspaceId;
          readonly message: { readonly correlationId?: string };
        };
        messageRows.set(payload.messageId, {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: payload.message,
          sentAt: "2026-10-05T00:00:00.000Z",
        });
        if (payload.message.correlationId !== undefined) {
          closedCorrelations.add(payload.message.correlationId);
        }
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              messageId: payload.messageId,
              admitted: true,
              promotion: {
                closesCorrelation: null,
                triggersReevaluation: false,
              },
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "SendMessage",
      gateway,
      receipts,
      new Map(),
      undefined,
      new Map(),
      messageRows,
      closedCorrelations,
    );

    await runControlHandler(handler, replyAction, 0, replyInvocation);
    const converged = await runControlHandler(
      handler,
      replyAction,
      1,
      replyInvocation,
    );

    expect(converged._tag).toBe("Accepted");
    expect(calls).toHaveLength(1);
  };

export const sendFailsClosedWithoutCanonicalRow = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const payload = envelope.payload as { readonly messageId: string };
      const committed = {
        resolution: {
          _tag: "Committed" as const,
          result: {
            messageId: payload.messageId,
            admitted: true,
            promotion: {
              closesCorrelation: null,
              triggersReevaluation: false,
            },
          },
        },
      };
      receipts.set(commandId, committed);
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;
  const handler = actionHandlerFromRegistry("SendMessage", gateway, receipts);

  await runControlHandler(handler, sendAction, 0, sendInvocation);
  const takeover = await runControlHandler(
    handler,
    sendAction,
    1,
    sendInvocation,
  );

  expect(takeover._tag).toBe("Rejected");
  expect(calls).toHaveLength(1);
};

export const sendDoesNotResendOlderRejection = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const rejected = {
        resolution: {
          _tag: "TerminalRejected" as const,
          error: { _tag: "AuthorityDenied" as const, reason: "old denial" },
        },
      };
      receipts.set(commandId, rejected);
      return Effect.succeed(rejected);
    },
  } as unknown as CommandGatewayService;
  const handler = actionHandlerFromRegistry("SendMessage", gateway, receipts);

  await runControlHandler(handler, sendAction, 0, sendInvocation);
  await runControlHandler(handler, sendAction, 1, sendInvocation);

  expect(calls).toHaveLength(1);
};
