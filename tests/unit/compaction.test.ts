import { describe, expect, it } from "vitest";
import {
  compactMessages,
  DEFAULT_KEEP_TAIL,
  DEFAULT_THRESHOLD,
} from "../../src/agent-runtime/compaction.js";
import type { ChatMessage } from "../../src/agent-runtime/provider.js";

const mk = (i: number): ChatMessage[] => [
  { role: "user", content: `task ${i}` },
  { role: "assistant", content: `answer ${i}` },
];

describe("compactMessages (D-036)", () => {
  it("no-op at or below threshold", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => mk(i)).flat(); // exactly 100
    expect(compactMessages(msgs, 100)).toBeNull();
  });

  it("compacts above threshold, keeps tail and deterministic summary", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => mk(i)).flat();
    const plan = compactMessages(msgs);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.droppedCount).toBe(200 - DEFAULT_KEEP_TAIL);
    expect(plan.kept.length).toBe(DEFAULT_KEEP_TAIL + 1); // + compacted-context message
    expect(plan.kept[0]?.role).toBe("user");
    expect(String(plan.kept[0]?.content)).toContain("[earlier context compacted");
    expect(String(plan.kept[0]?.content)).toContain("task 0");
    // tail preserved verbatim
    expect(plan.kept.at(-1)).toEqual(msgs.at(-1));
    expect(plan.kept.at(-2)).toEqual(msgs.at(-2));
  });

  it("deterministic: same input → identical plan (rebuildability)", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => mk(i)).flat();
    expect(compactMessages(msgs)).toEqual(compactMessages(msgs));
  });

  it("summary is char-capped for huge histories", () => {
    const big: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: "x".repeat(200),
    }));
    const plan = compactMessages(big);
    expect(plan?.summaryText.length).toBeLessThanOrEqual(4200);
    expect(plan?.summaryText).toContain("[truncated]");
  });
});
