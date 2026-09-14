import { describe, expect, it } from "vitest";
import { renderSystemPrompt } from "../../src/agent-runtime/system-prompt.js";
import type { ContextPackage } from "../../src/domain/context-package.js";

const pkg: ContextPackage = {
  projectId: "p-1",
  workspaceId: "w-1",
  contract: {
    intent: "build the bootstrap",
    responsibility: "own the runtime",
    deliverables: "working cli",
    inheritedConstraints: [],
  },
  resources: { writable: ["."] },
  worktreeRoot: "/wt/root",
  effective: { storeCommitSha: "a".repeat(40) },
};

describe("renderSystemPrompt (D-034 C3)", () => {
  const prompt = renderSystemPrompt(pkg);

  it("declares the role", () => {
    expect(prompt).toContain("Arbor Root Workspace Primary Agent");
  });

  it("renders all four context sections", () => {
    expect(prompt).toContain("### Identity");
    expect(prompt).toContain("### Contract");
    expect(prompt).toContain("### Resources");
    expect(prompt).toContain("### Effective State");
    expect(prompt).toContain("build the bootstrap");
    expect(prompt).toContain(`${"a".repeat(40)}`);
  });

  it("renders empty constraints as (none)", () => {
    expect(prompt).toContain("inherited constraints: (none)");
  });

  it("lists non-empty constraints joined", () => {
    const p2 = renderSystemPrompt({
      ...pkg,
      contract: { ...pkg.contract, inheritedConstraints: ["no-redis", "no-os-sandbox"] },
    });
    expect(p2).toContain("no-redis; no-os-sandbox");
  });

  it("includes tool discipline and no future-phase tool sections", () => {
    expect(prompt).toContain("## Tool Discipline");
    expect(prompt).toContain("exactly once");
    expect(prompt).not.toContain("report_completion");
    expect(prompt).not.toContain("propose_change");
  });
});
