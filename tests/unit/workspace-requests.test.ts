import { describe, expect, it } from "vitest";
import { makeWorkspaceRequestTools } from "../../src/agent-runtime/tools/workspace-requests.js";
import type { ContextPackage } from "../../src/domain/context-package.js";

const pkg: ContextPackage = {
  projectId: "p1",
  workspaceId: "w1",
  contract: {
    intent: "own bootstrap",
    responsibility: "runtime",
    deliverables: "cli",
    inheritedConstraints: [],
  },
  resources: { writable: ["."] },
  worktreeRoot: "/wt",
  effective: { storeCommitSha: "a".repeat(40) },
};

describe("workspace request tools (D-037)", () => {
  it("inspect renders the formal state", async () => {
    const tools = makeWorkspaceRequestTools({
      pkg,
      record: async () => {},
      onCompletion: async () => "",
    });
    const inspect = tools.find((t) => t.name === "inspect_workspace");
    const r = await inspect?.run({});
    expect(r).toMatchObject({ ok: true });
    if (r?.ok) {
      expect(r.output).toContain("own bootstrap");
      expect(r.output).toContain("a".repeat(40));
    }
  });

  it("status and blocker are recorded with their payload", async () => {
    const recorded: Array<[string, string]> = [];
    const tools = makeWorkspaceRequestTools({
      pkg,
      record: async (type, json) => {
        recorded.push([type, json]);
      },
      onCompletion: async () => "",
    });
    await tools.find((t) => t.name === "report_status")?.run({ status: "halfway" });
    await tools.find((t) => t.name === "report_blocker")?.run({ blocker: "missing spec" });
    expect(recorded).toEqual([
      ["report_status", '{"status":"halfway"}'],
      ["report_blocker", '{"blocker":"missing spec"}'],
    ]);
  });

  it("report_completion delegates to the runtime-owned finalization", async () => {
    let got: string | undefined;
    const tools = makeWorkspaceRequestTools({
      pkg,
      record: async () => {},
      onCompletion: async (summary) => {
        got = summary;
        return "activated as <result-id>";
      },
    });
    const r = await tools
      .find((t) => t.name === "report_completion")
      ?.run({ summary: "did the thing" });
    expect(got).toBe("did the thing");
    expect(r).toMatchObject({ ok: true, output: "activated as <result-id>" });
  });
});
