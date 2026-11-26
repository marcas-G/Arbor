import { describe, it } from "vitest";
import {
  storyEDetectionZeroMutation,
  storyEEligibleSetLifecycle,
  storyEGhostEdge,
  storyESecondWorkCompletesMutualCycle,
  storyEWithdrawBreaksCycle,
  storyEWorkspaceBoundDegeneration,
} from "./phases-deadlock.js";
import { storyADeclareYieldQuiescence } from "./phases-story-a.js";
import { storyBProduceAutoSatisfyWake } from "./phases-story-b.js";
import { storyCDeliverInboxReport } from "./phases-story-c.js";
import { storyDReviseWithdrawMarkAgentSatisfy } from "./phases-story-d.js";
import { storyFClassifyOnlyRunnableAuthority } from "./phases-story-f.js";

describe("-acceptance", () => {
  it("Story A (07 §1): declare → Yield blocks; no runnable → quiescence with zero provider turns; an un-yielded dependency never blocks", async () => {
    await storyADeclareYieldQuiescence();
  });

  it("Story B (07 §2): produce → coordinator auto-satisfy → wake clears the wait and returns the consumer to runnable; replay idempotent; matcher negative; concurrent first-win", async () => {
    await storyBProduceAutoSatisfyWake();
  });

  it("Story C (07 §3): Deliver lands one parent Inbox Message entry + MessageSent + ChildDelivered wake, satisfies nothing; wrong sender denied; Report has zero Dependency side-effects", async () => {
    await storyCDeliverInboxReport();
  });

  it("Story D (07 §4): Revise bumps and never reinterprets satisfaction; Withdraw / MarkUnfulfillable carry their events; producer-loss batch wiring; agent Satisfy shares the coordinator command face", async () => {
    await storyDReviseWithdrawMarkAgentSatisfy();
  });

  it("Story E (07 §5.1–§5.3): the second WorkWait completes the mutual cycle, DeadlockAttentionRequested carries cycle members and dependencies with zero canonical mutation, Withdraw ends determination", async () => {
    await storyESecondWorkCompletesMutualCycle();
  });

  it("Story E (07 §5.2): detection performs zero mutation on frozen inputs", () => {
    storyEDetectionZeroMutation();
  });

  it("Story E (07 §5.3): Withdraw breaks the cycle even while the consumer wait is uncleared", () => {
    storyEWithdrawBreaksCycle();
  });

  it("Story E (07 §5.4–§5.5): WorkspaceBound degeneration — exactly 1 eligible producer participates, ≥2 declines (SCC false-positive counterexample), 0 declines", () => {
    storyEWorkspaceBoundDegeneration();
  });

  it("Story E (07 §5.6): eligible-set lifecycle — 0→1 enters determination, 1→2 exits; producer-side terminal states are re-check points", () => {
    storyEEligibleSetLifecycle();
  });

  it("Story E (07 §5.7): ghost edge — a Satisfied dependency with an uncleared consumer wait emits no fact", () => {
    storyEGhostEdge();
  });

  it("Story F (07 §6): classify is the only runnable authority — the wait × dependency matrix decides equivalently; P5 runnable-source guards stay in place", async () => {
    await storyFClassifyOnlyRunnableAuthority();
  });
});
