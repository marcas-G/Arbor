import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-acc-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const run = (args: string, env: Record<string, string>) =>
  execSync(`node ${join("dist", "entrypoints", "main.js")} ${args}`, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("acceptance: arbor project init/show", () => {
  it("init then show across two processes", () => {
    const home = tmp();
    const repo = tmp();
    writeFileSync(join(repo, "f.txt"), "x");
    execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
      cwd: repo,
    });
    const out = run(`project init --repo ${repo} --home ${home}`, { ARBOR_HOME: home });
    expect(out).toMatch(/^project [0-9a-f-]+$/m);
    expect(out).toMatch(/workspace [0-9a-f-]+/);
    expect(out).toMatch(/effective ref -> [0-9a-f]{40,64}/);
    const pid = /project ([0-9a-f-]+)/m.exec(out)?.[1] ?? "";
    const shown = run(`project show --project ${pid} --home ${home}`, { ARBOR_HOME: home });
    expect(shown).toContain(`source repo ${repo}`);
    expect(shown).toMatch(/workspace [0-9a-f-]+/);
    expect(shown).toMatch(/effective ref -> [0-9a-f]{40,64}/);
  });

  it("init without --repo exits non-zero with usage", () => {
    const home = tmp();
    let stderr = "";
    let failed = false;
    try {
      execSync(`node ${join("dist", "entrypoints", "main.js")} project init --home ${home}`, {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      failed = true;
      stderr = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(failed).toBe(true);
    expect(stderr).toContain("--repo");
  });
});
