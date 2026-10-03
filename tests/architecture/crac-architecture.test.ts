import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("DID v1.31 MAC-P1 Root Conversation work-initiation boundary", () => {
  it("advertises only MAC-P2 placement/work-initiation controls", () => {
    const profile = source("packages/model-context/src/turn-profile.ts");
    for (const stableId of [
      "core.control.assign-work",
      "core.control.accept-result",
      "core.control.list-workspaces",
      "core.control.read-workspace",
      "core.control.propose-workspace",
    ]) {
      expect(profile).toContain(stableId);
    }
    expect(profile).not.toContain(
      'const conversationControls = new Set(["core.control.spawn-specialist"',
    );
    expect(profile).toContain('purpose === "RootConversation"');
    expect(profile).toContain('outputContractRef = "tool-invocation-v1"');
  });

  it("keeps conversation action results exact-execution scoped", () => {
    const decision = source("packages/agent-runtime/src/model-decision.ts");
    const actions = source("packages/agent-runtime/src/agent-loop-actions.ts");
    expect(decision).toContain("belongsToConversationExecution");
    expect(decision).toContain("providerTurnPrefix");
    expect(actions).toContain(
      ["observation_", "$", "{input.execution.executionId}_"].join(""),
    );
  });

  it("keeps historical formation governance exact while MAC-P1 hides its model surface", () => {
    const controls = source("apps/single-workspace/src/control-actions.ts");
    const decision = source(
      "packages/application/src/commands/record-decision.ts",
    );
    const drain = source("packages/agent-runtime/src/safe-input-drain.ts");
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    expect(controls).toContain(
      ["gov:", "$", "{record.proposalId}:", "$", "{record.revision}"].join(""),
    );
    expect(decision).toContain("markConsumed");
    expect(decision).toContain('fact.decision === "Modify"');
    expect(drain).toContain('entry.kind === "Message"');
    expect(drain).not.toContain('entry.kind !== "HumanInput"');
    expect(migrations).toContain('name: "formation_governance_inbox_backfill"');
    expect(migrations).toContain('name: "settled_governance_inbox_cleanup"');
  });

  it("versions the bounded-goal behavior and preserves user prohibitions", () => {
    const prompts = source("packages/agent-runtime/src/prompt-assets.ts");
    expect(prompts).toContain('"prompt:root-conversation:goal-placement:v5"');
    expect(prompts).toContain("never ask which external platform");
    expect(prompts).toContain("Call assign_work");
    expect(prompts).toContain("current Workspace");
    expect(prompts).toContain("Preserve every explicit prohibition");
    expect(prompts).toContain(
      "Never ask the user to choose between Workspace and Work",
    );
  });
});
