import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("DID v1.26 model-facing AssignWork action", () => {
  it("keeps model semantics separate from Runtime-bound command facts", () => {
    const types = source("packages/agent-runtime/src/control-types.ts");
    const decoder = source("packages/agent-runtime/src/control-decode-work.ts");
    expect(types).toContain('readonly _tag: "AssignWork"');
    for (const semantic of [
      "objective",
      "why",
      "constraints",
      "completionExpectation",
      "verificationMission",
      "reason",
    ]) {
      expect(decoder).toContain(semantic);
    }
    for (const runtimeFact of [
      "expectedWorkspaceRevision",
      "predecessorWorkId",
      "revision: parse(WorkRevision)",
    ]) {
      expect(decoder).not.toContain(runtimeFact);
    }
  });

  it("routes through the P1 command with structural target and provenance binding", () => {
    const actions = source("apps/single-workspace/src/control-actions.ts");
    expect(actions).toContain('action: "AssignWork"');
    expect(actions).toContain(
      "target.value.parentWorkspaceId === execution.workspaceId",
    );
    expect(actions).toContain(
      "predecessorWorkId: workEpisode(execution)?.workId ?? null",
    );
    expect(actions).toContain('commandType: "AssignWork"');
    expect(actions).toContain('_tag: "AssignWorkAuthority"');
  });

  it("exposes AssignWork only on the Work profile after CAPA authorization", () => {
    const profile = source("packages/model-context/src/turn-profile.ts");
    expect(profile).toContain('"core.control.assign-work"');
    expect(profile).toContain("workControls.has(tool.stableId)");
  });
});
