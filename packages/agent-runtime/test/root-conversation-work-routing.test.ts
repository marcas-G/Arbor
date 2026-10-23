import { describe, expect, it } from "vitest";
import { controlToolDefinitions } from "../src/control-catalog.js";
import { GENERIC_INSTRUCTION_ASSETS } from "../src/prompt-assets.js";

describe("RootConversation bounded Work routing guidance", () => {
  it("routes goals needing hidden executable tools through current Workspace Work", () => {
    const guidance = GENERIC_INSTRUCTION_ASSETS.rootConversationAction;
    expect(guidance.revision).toBe(7);
    expect(guidance.text).toContain(
      "RootConversation intentionally has no executable Work tools",
    );
    expect(guidance.text).toContain(
      "Assign a bounded Work to the current Workspace with assign_work",
    );
    expect(guidance.text).toContain(
      "is not a reason to refuse, suggest switching environments, or ask the user to resend",
    );
    expect(guidance.text).toContain(
      "claim_completion belongs to Work execution, not RootConversation",
    );
    expect(guidance.text).toContain(
      "Reply normally to ordinary conversation, explanation, or discussion",
    );
    expect(guidance.text).toContain(
      "do not create Work just because the user asked a question",
    );
    expect(guidance.text).toContain(
      "do not promise a tool, resource, or permission that canonical profile/context does not expose",
    );
    expect(guidance.text).toContain(
      "An approval only authorizes its exact bounded action; it is not evidence that the Work ran or completed",
    );
  });

  it("explains that assign_work routes RootConversation goals to WorkEpisode", () => {
    const assignWork = controlToolDefinitions().find(
      (definition) => definition.name === "assign_work",
    );
    expect(assignWork?.description).toContain(
      "Use this in RootConversation when the goal needs executable tools that RootConversation does not expose",
    );
    expect(assignWork?.description).toContain(
      "the WorkEpisode is the Workspace execution route",
    );
  });
});
