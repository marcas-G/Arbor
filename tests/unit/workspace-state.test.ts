import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../../src/domain/project.js";
import { WorkspaceStateSchema } from "../../src/domain/workspace-state.js";

const uuid = () => crypto.randomUUID();

const validState = () => ({
  workspaceId: uuid(),
  projectId: uuid(),
  contract: {
    intent: "i",
    responsibility: "r",
    deliverables: "d",
    inheritedConstraints: [],
  },
  localDefinitionRef: "workspaces/<id>/design/OVERVIEW.md",
  resources: { writable: ["."] },
  currentEffectiveResult: {
    resultId: uuid(),
    producedByChangeId: uuid(),
    projectCandidateCommit: "b".repeat(40),
    verifiedByVerificationId: uuid(),
  },
});

describe("WorkspaceState", () => {
  it("decodes full valid state and round-trips", () => {
    const s = validState();
    const d = Schema.decodeUnknownSync(WorkspaceStateSchema)(s);
    const json = Schema.encodeSync(WorkspaceStateSchema)(d);
    expect(Schema.decodeUnknownSync(WorkspaceStateSchema)(json)).toEqual(d);
  });

  it("currentEffectiveResult is optional (fresh workspace)", () => {
    const { currentEffectiveResult: _drop, ...fresh } = validState();
    expect(() => Schema.decodeUnknownSync(WorkspaceStateSchema)(fresh)).not.toThrow();
  });

  it("decoded keys are exactly the defined fields (no runtime/agent fields)", () => {
    const d = Schema.decodeUnknownSync(WorkspaceStateSchema)(validState()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(d).sort()).toEqual(
      [
        "contract",
        "currentEffectiveResult",
        "localDefinitionRef",
        "projectId",
        "resources",
        "workspaceId",
      ].sort(),
    );
  });

  it("nested contract keeps its shape (D-031)", () => {
    const d = Schema.decodeUnknownSync(WorkspaceStateSchema)(validState()) as {
      contract: Record<string, unknown>;
    };
    expect(Object.keys(d.contract).sort()).toEqual(
      ["deliverables", "inheritedConstraints", "intent", "responsibility"].sort(),
    );
  });
});

describe("Project (minimal identity)", () => {
  it("round-trips id + source repo path", () => {
    const p = { projectId: uuid(), sourceRepoPath: "/repos/myapp" };
    expect(Schema.decodeUnknownSync(ProjectSchema)(p)).toEqual(p);
  });
});
