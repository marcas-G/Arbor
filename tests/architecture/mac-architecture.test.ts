import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("DID v1.31 MAC architecture", () => {
  it("keeps active LocalPlan cognition outside the core Domain contract", () => {
    const controls = source("apps/single-workspace/src/control-actions.ts");
    const driver = source("packages/agent-runtime/src/agent-loop-driver.ts");
    const decision = source("packages/agent-runtime/src/model-decision.ts");
    const adapter = source("adapters/persistence-sqlite/src/work-plan.ts");

    expect(controls).toContain("reviseLocalPlan");
    expect(controls).toContain("LocalPlanStore");
    expect(controls).not.toContain("reviseWorkPlan");
    expect(driver).toContain("LocalPlanStore");
    expect(decision).toContain("localPlans");
    expect(decision).toContain("local-plan:");
    expect(adapter).toContain("LocalPlanStoreLive");
    expect(adapter).toContain("work_plans");
  });

  it("records the accepted four-phase contract and prevents later-phase tool leakage", () => {
    const profile = source("packages/model-context/src/turn-profile.ts");
    const mac = source(
      "docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md",
    );
    expect(profile).toContain('"core.control.assign-work"');
    expect(profile).toContain('"core.control.list-workspaces"');
    expect(profile).toContain('"core.control.read-workspace"');
    expect(profile).toContain('"core.control.propose-workspace"');
    expect(profile).toContain("const specialistControls = new Set<string>()");
    expect(profile).toContain("const inputControls = new Set([");
    expect(mac).toContain("MAC-P1 single Workspace correctness");
    expect(mac).toContain("MAC-P4 optional subagent");
  });
});
