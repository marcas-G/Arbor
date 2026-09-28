import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConversationProgressHub,
  createConversationProgressHub,
} from "../apps/single-workspace/src/transport/conversation-progress.js";
import {
  __resetExecutionMessageLinks,
  publishConversationProgress,
  publishConversationSettled,
  registerExecutionMessageLink,
} from "../apps/single-workspace/src/transport/conversation-progress-bridge.js";
import { runConversationTrigger } from "../packages/application/src/conversation-trigger.js";
import type { CommandGatewayService } from "../packages/application/src/index.js";
import type { ExecutionSettlement } from "../packages/domain/src/index.js";
import {
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";

/**
 * Conversation streaming bridge (the completed WIP seam): ProviderRuntimeProgress
 * → ConversationStreamEvent translation, per-message fanout, terminal events,
 * and unknown-execution no-op isolation.
 */

const MSG = "msg_018f2b3c-4d5e-7abc-8def-0000000000f1";
const EXE = "exe_018f2b3c-4d5e-7abc-8def-0000000000f2";
const PTN = "ptn_018f2b3c-4d5e-7abc-8def-0000000000f3";

const collect = (hub: ConversationProgressHub) => {
  const frames: Array<{ sequence: number; event: unknown }> = [];
  hub.subscribe(MSG, 0, (frame) => {
    frames.push({ sequence: frame.sequence, event: frame.event });
  });
  return frames;
};

let hub: ConversationProgressHub;
let frames: ReturnType<typeof collect>;

beforeEach(() => {
  __resetExecutionMessageLinks();
  hub = createConversationProgressHub();
  frames = collect(hub);
  registerExecutionMessageLink(EXE, MSG);
});

describe("conversation progress bridge", () => {
  it("translates a first attempt: started → delta…", () => {
    publishConversationProgress(
      EXE,
      { _tag: "AttemptStarted", providerTurnId: PTN as never, attemptNo: 0 },
      hub,
    );
    publishConversationProgress(
      EXE,
      {
        _tag: "ProviderEvent",
        providerTurnId: PTN as never,
        attemptNo: 0,
        event: { _tag: "TextDelta", text: "你" },
      },
      hub,
    );
    publishConversationProgress(
      EXE,
      {
        _tag: "ProviderEvent",
        providerTurnId: PTN as never,
        attemptNo: 0,
        event: { _tag: "TextDelta", text: "好" },
      },
      hub,
    );
    expect(
      frames.map((frame) => (frame.event as { type: string }).type),
    ).toEqual(["started", "delta", "delta"]);
    const deltas = frames
      .map((frame) => frame.event as { type: string; text?: string })
      .filter((event) => event.type === "delta");
    expect(deltas.map((event) => event.text).join("")).toBe("你好");
  });

  it("a retry attempt resets the preview first (reset → started)", () => {
    publishConversationProgress(
      EXE,
      { _tag: "AttemptStarted", providerTurnId: PTN as never, attemptNo: 0 },
      hub,
    );
    publishConversationProgress(
      EXE,
      {
        _tag: "ProviderEvent",
        providerTurnId: PTN as never,
        attemptNo: 0,
        event: { _tag: "TextDelta", text: "partial" },
      },
      hub,
    );
    publishConversationProgress(
      EXE,
      {
        _tag: "AttemptFailed",
        providerTurnId: PTN as never,
        attemptNo: 0,
        failureKind: "RateLimited",
        retrying: true,
      },
      hub,
    );
    publishConversationProgress(
      EXE,
      { _tag: "AttemptStarted", providerTurnId: PTN as never, attemptNo: 1 },
      hub,
    );
    const types = frames.map((frame) => (frame.event as { type: string }).type);
    expect(types).toEqual(["started", "delta", "retrying", "reset", "started"]);
  });

  it("terminal failures that stop retrying publish nothing (settlement owns the terminal)", () => {
    publishConversationProgress(
      EXE,
      {
        _tag: "AttemptFailed",
        providerTurnId: PTN as never,
        attemptNo: 0,
        failureKind: "RequestRejected",
        retrying: false,
      },
      hub,
    );
    expect(frames).toHaveLength(0);
  });

  it("non-text provider events are filtered out", () => {
    publishConversationProgress(
      EXE,
      {
        _tag: "ProviderEvent",
        providerTurnId: PTN as never,
        attemptNo: 0,
        event: { _tag: "UsageReported", inputTokens: 1, outputTokens: 2 },
      },
      hub,
    );
    expect(frames).toHaveLength(0);
  });

  it("settlement publishes settled / interrupted and marks the stream terminal", () => {
    publishConversationSettled(EXE, { _tag: "Completed" }, hub);
    const first = frames[0]?.event as { type: string };
    expect(first.type).toBe("settled");
    // terminal stream: a late subscriber with replay still ends bounded
    const replay: Array<unknown> = [];
    const subscription = hub.subscribe(MSG, 0, (frame) => {
      replay.push(frame.event);
    });
    expect(replay).toHaveLength(1);
    publishConversationSettled(EXE, { _tag: "Completed" }, hub);
    expect(replay).toHaveLength(1);
    subscription.unsubscribe();
  });

  it("Interrupted settlement publishes interrupted", () => {
    publishConversationSettled(EXE, { _tag: "Interrupted" }, hub);
    const first = frames[0];
    expect(first).toBeDefined();
    expect(
      first !== undefined ? (first.event as { type: string }).type : "missing",
    ).toBe("interrupted");
  });

  it("an unlinked execution is a no-op (never leaks into other messages)", () => {
    publishConversationProgress(
      "exe_unknown",
      { _tag: "AttemptStarted", providerTurnId: PTN as never, attemptNo: 0 },
      hub,
    );
    publishConversationSettled("exe_unknown", { _tag: "Completed" }, hub);
    expect(frames).toHaveLength(0);
  });

  it("hub publish failures are swallowed (observer isolation)", () => {
    const boom = {
      publish: () => {
        throw new Error("hub closed");
      },
      subscribe: () => ({ unsubscribe: () => undefined, terminal: true }),
      close: () => undefined,
    } as unknown as ConversationProgressHub;
    expect(() =>
      publishConversationProgress(
        EXE,
        { _tag: "AttemptStarted", providerTurnId: PTN as never, attemptNo: 0 },
        boom,
      ),
    ).not.toThrow();
  });
});
