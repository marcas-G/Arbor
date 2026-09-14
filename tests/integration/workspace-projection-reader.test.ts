import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { effectiveRefName, projectDirs } from "../../src/application/ports.js";
import type { WorkspaceId } from "../../src/domain/ids.js";
import {
  parseWorkspaceMd,
  readContextPackage,
} from "../../src/infrastructure/workspace-projection-reader.js";
import { FakeRun } from "./helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-proj-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const TPL = [
  "# Root Workspace",
  "",
  "## Intent",
  "",
  "own the bootstrap",
  "",
  "## Responsibility",
  "",
  "runtime only",
  "",
  "## Expected Deliverables",
  "",
  "cli passes",
  "",
  "## Inherited Constraints",
  "",
  "(none — Root workspace)",
  "",
].join("\n");

describe("parseWorkspaceMd", () => {
  it("extracts the four contract sections from the P1-01B template", () => {
    const c = parseWorkspaceMd(TPL);
    expect(c.intent).toBe("own the bootstrap");
    expect(c.responsibility).toBe("runtime only");
    expect(c.deliverables).toBe("cli passes");
    expect(c.inheritedConstraints).toEqual([]);
  });

  it("collects bullet constraints", () => {
    const md = TPL.replace("(none — Root workspace)", "- no-redis\n- no-sandbox");
    expect(parseWorkspaceMd(md).inheritedConstraints).toEqual(["no-redis", "no-sandbox"]);
  });
});

describe("readContextPackage (against a real P1-01B store)", () => {
  it("derives the package from workspace files", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && echo x > f && git add -A && git -c user.name=t -c user.email=t@t commit -qm b",
      {
        cwd: repo,
      },
    );
    const init = await FakeRun.initProject(home, repo);
    const wsDirs = projectDirs(home, init.projectId);
    const sha = execSync(
      `git -C ${wsDirs.storeDir} rev-parse ${effectiveRefName(init.workspaceId as never)}`,
      { encoding: "utf8" },
    ).trim();

    const pkg = await Effect.runPromise(
      readContextPackage({
        storeDir: wsDirs.storeDir,
        workspaceId: init.workspaceId,
        worktreeRoot: wsDirs.worktreeDir,
        effectiveStoreCommitSha: sha,
      }),
    );
    expect(pkg.projectId).toBe(init.projectId);
    expect(pkg.resources.writable).toEqual(["."]);
    expect(pkg.contract.intent).toBe("TBD (user to fill)");
    expect(pkg.effective.storeCommitSha).toBe(sha);
  });

  it("fails on a missing workspace dir", async () => {
    const exit = await Effect.runPromiseExit(
      readContextPackage({
        storeDir: tmp(),
        workspaceId: "nope" as WorkspaceId,
        worktreeRoot: "/wt",
        effectiveStoreCommitSha: "0".repeat(40),
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
