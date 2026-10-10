import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("functional-test trust boundary", () => {
  it("the release journey drives a built process through public HTTP only", () => {
    const journey = source(
      "tests/capability/black-box/s1-s4-public-api.test.ts",
    );
    for (const forbidden of [
      "node:sqlite",
      "SqlClient",
      "buildSingleWorkspaceLayer",
      "SELECT ",
      "PRAGMA ",
      "action_approvals",
      "FROM works",
    ]) {
      expect(journey).not.toContain(forbidden);
    }
    expect(journey).toContain('spawn("node", [DAEMON_ENTRY]');
    expect(journey).toContain('post("/commands"');
    expect(journey).toContain("/views/");
    expect(journey).toContain('view<unknown>("current-work"');
    expect(journey).toContain('}>("inbox-view"');
    expect(journey).toContain("approvalEntry.unconsumed");
  });

  it("the browser journey also owns a real production-process fixture", () => {
    const fixture = source("tests/functional/support/production-fixture.ts");
    const browser = source("tests/functional/ui/project-conversation.spec.ts");
    expect(fixture).toContain("apps/single-workspace/dist/main.js");
    expect(fixture).toContain("apps/web/dist");
    expect(fixture).not.toContain("@arbor/");
    expect(browser).toContain("fixture.restart()");
    expect(browser).not.toContain("/commands");
    expect(browser).not.toContain("/views/");
  });

  it("F21 exercises browser project creation without an internal setup shortcut", () => {
    const browser = source("tests/functional/ui/f21-project-resource.spec.ts");
    expect(browser).toContain("page.goto(fixture.baseUrl)");
    expect(browser).toContain('page.getByRole("button", { name: "创建项目" })');
    expect(browser).toContain("makePublicClient(fixture.baseUrl)");
    expect(browser).toContain('fetch("/projects"');
    expect(browser).toContain('fetch("/commands"');
    for (const forbidden of [
      "node:sqlite",
      "DatabaseSync",
      "SqlClient",
      "CommandStore",
      "WorkspaceRepository",
      "buildSingleWorkspaceLayer",
      "readRows(",
      "SELECT ",
      "PRAGMA ",
      "fixture.databaseFile",
      "@arbor/ports",
      "@arbor/application",
    ]) {
      expect(browser).not.toContain(forbidden);
    }
  });
});
