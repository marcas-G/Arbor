import type {
  ConversationStreamEvent,
  ConversationStreamFrame,
} from "@arbor/api-contracts";

export interface ConversationProgressSubscription {
  readonly unsubscribe: () => void;
  readonly terminal: boolean;
}

export interface ConversationProgressHub {
  readonly publish: (
    messageId: string,
    event: ConversationStreamEvent,
  ) => ConversationStreamFrame;
  readonly subscribe: (
    messageId: string,
    afterSequence: number,
    listener: (frame: ConversationStreamFrame) => void,
  ) => ConversationProgressSubscription;
  readonly close: () => void;
}

interface StreamState {
  nextSequence: number;
  updatedAt: number;
  frames: ConversationStreamFrame[];
  listeners: Set<(frame: ConversationStreamFrame) => void>;
  terminal: boolean;
}

export interface ConversationProgressHubOptions {
  readonly maxFramesPerMessage?: number | undefined;
  readonly maxMessages?: number | undefined;
  readonly retentionMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const isTerminal = (event: ConversationStreamEvent): boolean =>
  event.type === "settled" || event.type === "interrupted";

/**
 * Bounded, process-local replay and fanout for transient conversation deltas.
 * It deliberately has no persistence interface: canonical output is written
 * by the existing execution/session path.
 */
export const createConversationProgressHub = (
  options: ConversationProgressHubOptions = {},
): ConversationProgressHub => {
  const maxFramesPerMessage = Math.max(8, options.maxFramesPerMessage ?? 512);
  const maxMessages = Math.max(8, options.maxMessages ?? 512);
  const retentionMs = Math.max(1_000, options.retentionMs ?? 10 * 60_000);
  const now = options.now ?? Date.now;
  const streams = new Map<string, StreamState>();
  let closed = false;

  const prune = (): void => {
    const at = now();
    for (const [messageId, state] of streams) {
      if (state.listeners.size === 0 && at - state.updatedAt > retentionMs) {
        streams.delete(messageId);
      }
    }
    if (streams.size <= maxMessages) {
      return;
    }
    for (const [messageId, state] of streams) {
      if (streams.size <= maxMessages) {
        break;
      }
      if (state.listeners.size === 0) {
        streams.delete(messageId);
      }
    }
  };

  const stateFor = (messageId: string): StreamState => {
    const existing = streams.get(messageId);
    if (existing !== undefined) {
      existing.updatedAt = now();
      return existing;
    }
    const created: StreamState = {
      nextSequence: 1,
      updatedAt: now(),
      frames: [],
      listeners: new Set(),
      terminal: false,
    };
    streams.set(messageId, created);
    return created;
  };

  return {
    publish(messageId, event) {
      if (closed) {
        throw new Error("conversation progress hub is closed");
      }
      prune();
      const state = stateFor(messageId);
      const frame: ConversationStreamFrame = {
        sequence: state.nextSequence,
        event,
      };
      state.nextSequence += 1;
      state.updatedAt = now();
      state.frames.push(frame);
      if (state.frames.length > maxFramesPerMessage) {
        state.frames.splice(0, state.frames.length - maxFramesPerMessage);
      }
      state.terminal = isTerminal(event);
      for (const listener of [...state.listeners]) {
        listener(frame);
      }
      return frame;
    },

    subscribe(messageId, afterSequence, listener) {
      if (closed) {
        return { unsubscribe: () => undefined, terminal: true };
      }
      prune();
      const state = stateFor(messageId);
      const first = state.frames[0];
      if (first !== undefined && afterSequence < first.sequence - 1) {
        listener({
          sequence: first.sequence - 1,
          event: { type: "reset", reason: "history-gap" },
        });
      }
      for (const frame of state.frames) {
        if (frame.sequence > afterSequence) {
          listener(frame);
        }
      }
      if (!state.terminal) {
        state.listeners.add(listener);
      }
      return {
        terminal: state.terminal,
        unsubscribe: () => {
          state.listeners.delete(listener);
          state.updatedAt = now();
          prune();
        },
      };
    },

    close() {
      closed = true;
      streams.clear();
    },
  };
};

export const defaultConversationProgressHub = createConversationProgressHub();
