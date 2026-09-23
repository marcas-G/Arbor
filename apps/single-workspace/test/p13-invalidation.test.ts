import { VIEW_IDS } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { makeInvalidationFanout } from "../src/transport/invalidation.js";

describe("P13 TR-W1 invalidation fanout", () => {
  it("frames carry view + watermark only — no DTO payload", () => {
    const fanout = makeInvalidationFanout();
    const frames: unknown[] = [];
    fanout.subscribe((frame) => {
      frames.push(frame);
    });
    fanout.publishWatermark(42);
    expect(frames.length).toBe(VIEW_IDS.length);
    for (const frame of frames) {
      expect(frame).toEqual({
        kind: "invalidate",
        view: expect.any(String),
        watermark: 42,
      });
    }
    const views = frames.map((frame) => (frame as { view: string }).view);
    expect(new Set(views).size).toBe(VIEW_IDS.length);
    for (const view of VIEW_IDS) {
      expect(views).toContain(view);
    }
  });

  it("unsubscribe stops delivery", () => {
    const fanout = makeInvalidationFanout();
    let count = 0;
    const unsubscribe = fanout.subscribe(() => {
      count += 1;
    });
    fanout.publishWatermark(1);
    const afterFirst = count;
    unsubscribe();
    fanout.publishWatermark(2);
    expect(count).toBe(afterFirst);
  });

  it("subscriberCount tracks sinks", () => {
    const fanout = makeInvalidationFanout();
    expect(fanout.subscriberCount()).toBe(0);
    const unsubscribe = fanout.subscribe(() => undefined);
    expect(fanout.subscriberCount()).toBe(1);
    unsubscribe();
    expect(fanout.subscriberCount()).toBe(0);
  });
});
