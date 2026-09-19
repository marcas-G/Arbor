import { describe, expect, it } from "vitest";
import type { Project } from "../src/index.js";
import {
  allowsNewAutonomousExecution,
  closeProject,
  createProject,
  isProjectClosed,
  isProjectOpen,
  makeProjectPolicy,
  ProjectId,
  parse,
  Revision,
  updateProjectPolicy,
  WorkspaceId,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const rootWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const revision = parse(Revision);

const makeProject = (value = 0, policyValue = 0): Project =>
  createProject({
    projectId,
    name: "Arbor",
    rootWorkspaceId,
    projectPolicy: makeProjectPolicy(),
    projectPolicyRevision: revision(policyValue),
    revision: revision(value),
  });

describe("project aggregate", () => {
  it("creates an Open project with exactly one root workspace", () => {
    const project = makeProject();
    expect(project.lifecycle).toBe("Open");
    expect(isProjectOpen(project)).toBe(true);
    expect(isProjectClosed(project)).toBe(false);
    expect(allowsNewAutonomousExecution(project)).toBe(true);
    expect(
      Object.keys(project).filter((key) => key.startsWith("root")),
    ).toEqual(["rootWorkspaceId"]);
  });

  it("UpdateProjectPolicy increments revision and projectPolicyRevision", () => {
    const result = updateProjectPolicy(makeProject(4, 2), {
      authorized: true,
      expectedRevision: revision(4),
      policy: makeProjectPolicy({ ceiling: "strict" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lifecycle).toBe("Open");
      expect(result.value.revision).toBe(5);
      expect(result.value.projectPolicyRevision).toBe(3);
    }
  });

  it("CloseProject increments only revision", () => {
    const result = closeProject(makeProject(4, 2), { authorized: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lifecycle).toBe("Closed");
      expect(result.value.revision).toBe(5);
      expect(result.value.projectPolicyRevision).toBe(2);
      expect(isProjectClosed(result.value)).toBe(true);
      expect(allowsNewAutonomousExecution(result.value)).toBe(false);
    }
  });

  it("rejects every lifecycle mutation on a Closed project", () => {
    const closed = closeProject(makeProject(), { authorized: true });
    expect(closed.ok).toBe(true);
    if (!closed.ok) {
      throw new Error("expected close to succeed");
    }
    const update = updateProjectPolicy(closed.value, {
      authorized: true,
      expectedRevision: closed.value.revision,
      policy: makeProjectPolicy(),
    });
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.error._tag).toBe("TerminalLifecycleMutation");
    }
    const reclose = closeProject(closed.value, { authorized: true });
    expect(reclose.ok).toBe(false);
    if (!reclose.ok) {
      expect(reclose.error._tag).toBe("TerminalLifecycleMutation");
    }
  });

  it("requires authority", () => {
    const result = updateProjectPolicy(makeProject(), {
      authorized: false,
      expectedRevision: revision(0),
      policy: makeProjectPolicy(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AuthorityDenied");
    }
  });

  it("rejects a stale expected revision with RevisionConflict", () => {
    const result = updateProjectPolicy(makeProject(4), {
      authorized: true,
      expectedRevision: revision(3),
      policy: makeProjectPolicy(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("RevisionConflict");
      if (result.error._tag === "RevisionConflict") {
        expect(result.error.expected).toBe(3);
        expect(result.error.actual).toBe(4);
      }
    }
  });

  it("type-level: rootWorkspaceId is required and singular", () => {
    // @ts-expect-error rootWorkspaceId is required
    createProject({
      projectId,
      name: "Arbor",
      projectPolicy: makeProjectPolicy(),
      projectPolicyRevision: revision(0),
      revision: revision(0),
    });
  });
});
