import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("DID v1.28 Execution Episode / Goal / Plan architecture", () => {
  it("new admission paths use exact episodes rather than Coordination", () => {
    const conversation = source(
      "packages/application/src/conversation-response-runtime.ts",
    );
    const scheduler = source("packages/execution-runtime/src/scheduler.ts");
    const wake = source("packages/execution-runtime/src/wake-consumer.ts");
    expect(conversation).toContain("ConversationResponseEpisode");
    expect(conversation).not.toContain('"Coordination"');
    expect(scheduler).toContain("RequestWorkSelection");
    expect(scheduler).not.toContain('focus: { _tag: "Coordination" }');
    expect(wake).toContain('"DecisionEpisode"');
    expect(wake).toContain('"WorkEpisode"');
    expect(wake).not.toContain('focus: { _tag: "Coordination" }');
  });

  it("Plan is progress-only and exposed as a tool, never a completion result", () => {
    const plan = source("packages/domain/src/plan.ts");
    const controls = source("packages/agent-runtime/src/control-catalog.ts");
    expect(plan).toContain("progress state");
    expect(plan).not.toMatch(/WorkCompleted|Acceptance|VerificationConcluded/);
    expect(controls).toContain('name: "update_plan"');
    expect(controls).toContain("does not execute steps or complete the Work");
  });

  it("migration 0024 stores episode identity, plan, and decision request", () => {
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    for (const marker of [
      "episode_kind",
      "episode_ref",
      "episode_revision",
      "work_plans",
      "work_selection_decision_requests",
    ]) {
      expect(migrations).toContain(marker);
    }
    expect(migrations).toContain('name: "execution_episode_binding"');
  });

  it("migration 0025 physically retires legacy focus columns", () => {
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    expect(migrations).toContain('name: "execution_episode_only"');
    expect(migrations).toContain("DROP TABLE executions_legacy_focus");
    expect(migrations).toContain("LegacyAmbiguousEpisode");
  });

  it("migration 0026 retires agent-state focus and active runtime has no Coordination branch", () => {
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    const driver = source("packages/agent-runtime/src/agent-loop-driver.ts");
    const decision = source("packages/agent-runtime/src/model-decision.ts");
    const completion = source(
      "packages/agent-runtime/src/agent-loop-step-completion.ts",
    );
    const profile = source("packages/model-context/src/turn-profile.ts");
    expect(migrations).toContain('name: "agent_state_episode_only"');
    expect(migrations).toContain(
      "DROP TABLE agent_execution_state_legacy_focus",
    );
    for (const runtimeSource of [driver, decision, completion, profile]) {
      expect(runtimeSource).not.toMatch(
        /WorkspaceCoordination|QueryCompleted|CoordinationCompleted/,
      );
    }
    expect(driver).toContain(
      "legacy ambiguous Workspace execution cannot be driven",
    );
  });
});
