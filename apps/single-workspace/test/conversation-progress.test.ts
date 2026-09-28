import { describe, expect, it } from "vitest";
import { createConversationProgressHub } from "../src/transport/conversation-progress.js";

describe("conversation progress hub", () => {
  it("replays missed deltas and then publishes live frames in sequence", () => {
    const hub = createConversationProgressHub();
    hub.publish("msg_1", {
      type: "started",
      executionId: "exe_1",
      providerTurnId: "ptn_1",
      attemptNo: 0,
    });
    hub.publish("msg_1", {
      type: "delta",
      executionId: "exe_1",
      providerTurnId: "ptn_1",
      attemptNo: 0,
      text: "Hello",
    });

    const seen: number[] = [];
    const subscription = hub.subscribe("msg_1", 0, (frame) => {
      seen.push(frame.sequence);
    });
    expect(seen).toEqual([1, 2]);

    const live = hub.publish("msg_1", {
      type: "delta",
      executionId: "exe_1",
      providerTurnId: "ptn_1",
      attemptNo: 0,
      text: "!",
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(live.sequence).toBe(3);
    expect(subscription.terminal).toBe(false);
    subscription.unsubscribe();
    hub.close();
  });

  it("signals when bounded replay no longer contains the caller's cursor", () => {
    const hub = createConversationProgressHub({ maxFramesPerMessage: 8 });
    for (let index = 0; index < 10; index += 1) {
      hub.publish("msg_1", {
        type: "delta",
        executionId: "exe_1",
        providerTurnId: "ptn_1",
        attemptNo: 0,
        text: String(index),
      });
    }
    const seen: string[] = [];
    hub.subscribe("msg_1", 0, (frame) => {
      seen.push(frame.event.type);
    });
    expect(seen[0]).toBe("reset");
    expect(seen.slice(1)).toEqual(Array(8).fill("delta"));
    hub.close();
  });

  it("replays terminal settlement and does not keep terminal subscriptions open", () => {
    const hub = createConversationProgressHub();
    hub.publish("msg_1", { type: "settled", executionId: "exe_1" });
    const seen: string[] = [];
    const subscription = hub.subscribe("msg_1", 0, (frame) => {
      seen.push(frame.event.type);
    });
    expect(seen).toEqual(["settled"]);
    expect(subscription.terminal).toBe(true);
    hub.close();
  });
});
