import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("functional-test trust boundary", () => {
  it("keeps architecture and public-process suites out of core Vitest", () => {
    const coreConfig = source("vitest.config.ts");
    const architectureConfig = source("vitest.architecture.config.ts");
    const functionalConfig = source("vitest.functional.config.ts");
    const packageJson = source("package.json");
    const manifest = JSON.parse(source("planning/testing/manifest.json")) as {
      groups: { functionalVitest: string[] };
    };
    const s1S4Path = "tests/capability/black-box/s1-s4-public-api.test.ts";

    expect(coreConfig).toContain('"tests/architecture/**"');
    expect(coreConfig).toContain(`"${s1S4Path}"`);
    expect(coreConfig).toContain('"tests/functional/**"');
    expect(packageJson).toContain(
      '"architecture": "vitest run --config vitest.architecture.config.ts"',
    );
    expect(architectureConfig).toContain('"tests/architecture/**/*.test.ts"');
    expect(functionalConfig).toContain(`"${s1S4Path}"`);
    expect(manifest.groups.functionalVitest).toContain(s1S4Path);

    const coreExcludesFunctionalPath = manifest.groups.functionalVitest.filter(
      (path) => path.startsWith("tests/functional/") || path === s1S4Path,
    );
    expect(coreExcludesFunctionalPath).toEqual(
      manifest.groups.functionalVitest,
    );
  });

  it("the release journey drives a built process through public HTTP only", () => {
    const journey = source(
      "tests/capability/black-box/s1-s4-public-api.test.ts",
    );
    const lifecycle = source(
      "tests/functional/support/daemon-process-lifecycle.ts",
    );
    const productionFixture = source(
      "tests/functional/support/production-fixture.ts",
    );
    const lifecycleQualification = source(
      "tests/functional/process/production-fixture-port-handshake.functional.test.ts",
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
    expect(journey).toContain(
      'from "../../functional/support/daemon-process-lifecycle.js"',
    );
    expect(journey).toContain("waitForDaemonListening(child, requestedPort");
    expect(journey).toContain("stopChildBounded(child)");
    expect(journey).not.toContain("freePort(");
    expect(journey).not.toContain('spawn("node", [DAEMON_ENTRY]');
    expect(journey).not.toContain("JSON.parse(line)");
    expect(lifecycle).toContain("export const waitForDaemonListening");
    expect(lifecycle).toContain('event.tag === "FUNCTIONAL_DAEMON_STARTED"');
    expect(lifecycle).toContain('event.tag !== "FUNCTIONAL_DAEMON_LISTENING"');
    expect(lifecycle).toContain("event.pid !== child.pid");
    expect(lifecycle).toContain("event.nonce !== startedNonce");
    expect(lifecycle).toContain("export const stopChildBounded");
    expect(lifecycle).toContain(
      'spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"]',
    );
    expect(lifecycle).toContain("for (const attemptNumber of [1, 2])");
    expect(lifecycle).toContain('process.kill(-child.pid, "SIGKILL")');
    expect(lifecycleQualification).toContain(
      '"stops a real process tree and remains safe on repeated stop"',
    );
    expect(lifecycleQualification).not.toContain(
      'it.skipIf(process.platform !== "win32")',
    );
    expect(productionFixture).toContain(
      'detached: process.platform !== "win32"',
    );
    expect(productionFixture).toContain("spawn(process.execPath, [childEntry]");
    expect(productionFixture).toContain("waitForNonceBoundPort(child, 0)");
    expect(productionFixture).toContain("await stopChild(daemon)");
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
