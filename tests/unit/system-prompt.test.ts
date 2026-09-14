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
    expect(prompt).toContain("Arbor");
    expect(prompt).toContain("主智能体");
  });

  it("renders all four context sections", () => {
    expect(prompt).toContain("### 身份");
    expect(prompt).toContain("### 合同");
    expect(prompt).toContain("### 资源");
    expect(prompt).toContain("### 工程基线");
    expect(prompt).toContain("build the bootstrap");
    expect(prompt).toContain("a".repeat(12)); // template truncates for the model
  });

  it("renders empty constraints as (none)", () => {
    expect(prompt).toContain("继承约束: （无）");
  });

  it("lists non-empty constraints joined", () => {
    const p2 = renderSystemPrompt({
      ...pkg,
      contract: { ...pkg.contract, inheritedConstraints: ["no-redis", "no-os-sandbox"] },
    });
    expect(p2).toContain("no-redis; no-os-sandbox");
  });

  it("includes tool discipline and no future-phase tool sections", () => {
    expect(prompt).toContain("## 工具纪律");
    expect(prompt).toContain("恰好匹配一次");
    expect(prompt).toContain("report_completion");
    expect(prompt).not.toContain("propose_change");
    expect(prompt).not.toContain("propose_change");
  });
});
