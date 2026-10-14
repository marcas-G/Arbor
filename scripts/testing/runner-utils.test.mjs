import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildProcessSpec, resolvePnpmInvocation } from "./runner-utils.mjs";

test("Windows runner passes paths with spaces as individual native process arguments", () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "arbor runner workspace with spaces-"),
  );
  try {
    const cli = join(workspace, "Program Files", "pnpm", "pnpm.exe");
    const resultPath = join(workspace, ".test-results", "release report.json");
    const spec = buildProcessSpec({
      platform: "win32",
      executable: cli,
      args: [
        "exec",
        "vitest",
        "run",
        "--outputFile",
        resultPath,
        "tests/p1 test.test.ts",
      ],
      cwd: workspace,
      env: { ARBOR_TEST_CACHE: "off" },
    });

    assert.equal(spec.executable, cli);
    assert.deepEqual(spec.args, [
      "exec",
      "vitest",
      "run",
      "--outputFile",
      resultPath,
      "tests/p1 test.test.ts",
    ]);
    assert.equal(spec.options.cwd, workspace);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.windowsHide, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("current Windows pnpm.cmd shim resolves natively and accepts output paths with spaces", {
  skip: process.platform !== "win32",
}, () => {
  const env = { ...process.env, npm_execpath: "" };
  const invocation = resolvePnpmInvocation({
    platform: "win32",
    env,
    cwd: process.cwd(),
  });
  assert.match(invocation.source.toLowerCase(), /pnpm\.cmd$/);
  assert.equal(invocation.executable.toLowerCase().endsWith(".exe"), true);

  const run = (args) =>
    spawnSync(invocation.executable, [...invocation.prefixArgs, ...args], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

  const temporaryWorkspace = mkdtempSync(
    join(tmpdir(), "arbor pnpm output args with spaces-"),
  );
  try {
    const outputPath = join(temporaryWorkspace, "vitest output report.json");
    const help = run([
      "exec",
      "vitest",
      "run",
      "--help",
      "--outputFile",
      outputPath,
    ]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /vitest/i);
  } finally {
    rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});
