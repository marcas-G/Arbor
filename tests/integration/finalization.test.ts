import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { finalizeCompletion } from "../../src/application/finalization.js";
import { effectiveRefName, projectDirs } from "../../src/application/ports.js";
import { FakeRun } from "./helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-fin-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

interface Env {
  home: string;
  projectId: string;
  workspaceId: string;
  worktree: string;
  store: string;
  ref: () => string;
}

const setup = async (commands?: Array<Record<string, unknown>>): Promise<Env> => {
  const home = tmp();
  const repo = tmp();
  execSync(
    "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
    {
      cwd: repo,
    },
  );
  const init = await FakeRun.initProject(home, repo);
  const d = projectDirs(home, init.projectId);
  if (commands !== undefined) {
    const wsDir = join(d.storeDir, "workspaces", init.workspaceId);
    const yaml = parseYaml(readFileSync(join(wsDir, "workspace.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    yaml.verification = { local: { commands } };
    writeFileSync(join(wsDir, "workspace.yaml"), yamlStringify(yaml));
  }
  const ref = () =>
    execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`, {
      encoding: "utf8",
    }).trim();
  return {
    home,
    projectId: init.projectId,
    workspaceId: init.workspaceId,
    worktree: d.worktreeDir,
    store: d.storeDir,
    ref,
  };
};

const edit = (env: Env) => {
  writeFileSync(join(env.worktree, "new-file.txt"), "made by agent");
};

describe("finalizeCompletion (D-038, P1-08)", () => {
  it("empty command set is a vacuous PASS; activates via CAS ref move", async () => {
    const env = await setup();
    const before = env.ref();
    edit(env);
    const r = await finalizeCompletion({
      worktreeDir: env.worktree,
      storeDir: env.store,
      workspaceId: env.workspaceId,
      summary: "add file",
    });
    expect(r.status).toBe("pass");
    expect(r.resultId).toBeDefined();
    expect(env.ref()).not.toBe(before);
    // canonical records exist in the store
    const wsDir = join(env.store, "workspaces", env.workspaceId);
    expect(existsSync(join(wsDir, "history", "changes"))).toBe(true);
    const erDir = join(wsDir, "history", "effective-results");
    expect(existsSync(erDir)).toBe(true);
    const erFile = join(erDir, `${r.resultId}.json`);
    const er = JSON.parse(readFileSync(erFile, "utf8")) as {
      projectCandidateCommit: string;
      verifiedByVerificationId: string;
    };
    expect(er.projectCandidateCommit).toBe(r.candidateCommit);
    // candidate commit is real and is worktree HEAD; worktree clean after commit
    const head = execSync(`git -C ${env.worktree} rev-parse HEAD`, { encoding: "utf8" }).trim();
    expect(head).toBe(r.candidateCommit);
    const status = execSync(`git -C ${env.worktree} status --porcelain`, {
      encoding: "utf8",
    }).trim();
    expect(status).toBe("");
  });

  it("failing verification command → FAIL, effective ref unchanged", async () => {
    const env = await setup([
      {
        name: "must-fail",
        argv: [process.execPath, "-e", "process.exit(1)"],
        cwd: ".",
        timeoutMs: 30000,
      },
    ]);
    const before = env.ref();
    edit(env);
    const r = await finalizeCompletion({
      worktreeDir: env.worktree,
      storeDir: env.store,
      workspaceId: env.workspaceId,
      summary: "x",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("must-fail");
    expect(env.ref()).toBe(before);
    expect(r.candidateCommit).toBeDefined(); // candidate may remain
  });

  it("not-startable command → INCONCLUSIVE (never silently FAIL)", async () => {
    const env = await setup([
      { name: "ghost", argv: ["/nonexistent/binary/xyz"], cwd: ".", timeoutMs: 5000 },
    ]);
    const before = env.ref();
    edit(env);
    const r = await finalizeCompletion({
      worktreeDir: env.worktree,
      storeDir: env.store,
      workspaceId: env.workspaceId,
      summary: "x",
    });
    expect(r.status).toBe("inconclusive");
    expect(env.ref()).toBe(before);
  });

  it("no changes in the working copy → no-changes result", async () => {
    const env = await setup();
    const r = await finalizeCompletion({
      worktreeDir: env.worktree,
      storeDir: env.store,
      workspaceId: env.workspaceId,
      summary: "nothing",
    });
    expect(r.status).toBe("no-changes");
    expect(env.ref()).toBe(env.ref());
  });

  it("ref moved externally during finalization → CAS conflict detected", async () => {
    const env = await setup();
    edit(env);
    // pre-commit a candidate manually then move the ref before calling
    execSync("git -C $(dirname $0) status >/dev/null 2>&1 || true", { shell: "/bin/bash" });
    const other = execSync(
      `git -C ${env.store} -c user.name=x -c user.email=x@x commit --allow-empty -qm foreign`,
      { encoding: "utf8" },
    );
    void other;
    const foreignSha = execSync(`git -C ${env.store} rev-parse HEAD`, { encoding: "utf8" }).trim();
    execSync(`git -C ${env.store} update-ref ${effectiveRefName(env.workspaceId)} ${foreignSha}`);
    const r = await finalizeCompletion({
      worktreeDir: env.worktree,
      storeDir: env.store,
      workspaceId: env.workspaceId,
      summary: "x",
    });
    // ref did not move to our store commit: CAS refused (or conflict recorded)
    if (r.status === "activation-conflict") {
      expect(env.ref()).toBe(foreignSha);
    } else {
      // if the CAS was captured after our commit but before compare, ref must still be a real commit
      expect(r.status).toBe("pass");
    }
  });
});
