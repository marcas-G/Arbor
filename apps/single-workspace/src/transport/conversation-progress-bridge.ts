import type { ConversationStreamEvent } from "@arbor/api-contracts";
import type { ProviderRuntimeProgress } from "@arbor/ports";
import {
  type ConversationProgressHub,
  defaultConversationProgressHub,
} from "./conversation-progress.js";

/**
 * Conversation streaming bridge (completes the WIP skeleton): maps the
 * driving executionId → the human message that claimed it, translates
 * ProviderRuntimeProgress into the frozen ConversationStreamEvent shape and
 * publishes to the same process-local hub the SSE endpoint serves.
 *
 * Presentation-only: the registry is process-local, populated by the
 * conversationTick around runExecution; an unknown executionId is a no-op.
 * Canonical output still lands exclusively through the settle sweep — the
 * stream is a transient preview, never a state source.
 */

const links = new Map<string, string>();

export const registerExecutionMessageLink = (
  executionId: string,
  messageId: string,
): void => {
  links.set(executionId, messageId);
};

export const unregisterExecutionMessageLink = (executionId: string): void => {
  links.delete(executionId);
};

const publish = (
  hub: ConversationProgressHub,
  messageId: string,
  event: ConversationStreamEvent,
): void => {
  try {
    hub.publish(messageId, event);
  } catch {
    // A transient preview must never affect execution semantics.
  }
};

const translate = (
  executionId: string,
  event: ProviderRuntimeProgress,
): ReadonlyArray<ConversationStreamEvent> => {
  switch (event._tag) {
    case "AttemptStarted": {
      const started: ConversationStreamEvent = {
        type: "started",
        executionId,
        providerTurnId: String(event.providerTurnId),
        attemptNo: event.attemptNo,
      };
      // A retry attempt restarts the text: reset the preview first.
      return event.attemptNo === 0
        ? [started]
        : [{ type: "reset", reason: "provider-retry" }, started];
    }
    case "ProviderEvent":
      if (event.event._tag === "TextDelta") {
        return [
          {
            type: "delta",
            executionId,
            providerTurnId: String(event.providerTurnId),
            attemptNo: event.attemptNo,
            text: event.event.text,
          },
        ];
      }
      return [];
    case "AttemptFailed":
      return event.retrying
        ? [{ type: "retrying", executionId, attemptNo: event.attemptNo + 1 }]
        : [];
    default:
      return [];
  }
};

/** The driver-facing tap: no-op unless the execution is linked to a message. */
export const publishConversationProgress = (
  executionId: string,
  event: ProviderRuntimeProgress,
  hub: ConversationProgressHub = defaultConversationProgressHub,
): void => {
  const messageId = links.get(executionId);
  if (messageId === undefined) {
    return;
  }
  for (const translated of translate(executionId, event)) {
    publish(hub, messageId, translated);
  }
};

/** Terminal events at settlement (tick-side). */
export const publishConversationSettled = (
  executionId: string,
  settlement: { readonly _tag: string },
  hub: ConversationProgressHub = defaultConversationProgressHub,
): void => {
  const messageId = links.get(executionId);
  if (messageId === undefined) {
    return;
  }
  publish(hub, messageId, {
    type: settlement._tag === "Interrupted" ? "interrupted" : "settled",
    executionId,
  });
};

/** Test seam: reset the registry between cases. */
export const __resetExecutionMessageLinks = (): void => {
  links.clear();
};
