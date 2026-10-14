import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildProcessSpec } from "./runner-utils.mjs";

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
