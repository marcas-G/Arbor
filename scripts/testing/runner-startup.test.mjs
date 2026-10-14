import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = join(root, "scripts/testing/run-suite.mjs");
const resultsRoot = join(root, ".test-results");

test("runner atomically persists both running artifacts before invoking pnpm", () => {
  const temporaryWorkspace = mkdtempSync(
    join(tmpdir(), "arbor startup probe with spaces-"),
  );
  let resultDirectory = null;
  try {
    const fakePnpmCli = join(temporaryWorkspace, "fake pnpm cli.mjs");
    const probePath = join(temporaryWorkspace, "initial state.json");
    writeFileSync(
      fakePnpmCli,
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const directory = process.env.ARBOR_TEST_RESULT_DIRECTORY;",
        'const jsonPath = join(directory, "result-manifest.json");',
        'const markdownPath = join(directory, "summary.md");',
        'const manifest = JSON.parse(readFileSync(jsonPath, "utf8"));',
        "writeFileSync(process.env.ARBOR_RUNNER_PROBE_PATH, JSON.stringify({ directory, status: manifest.status, hasJson: existsSync(jsonPath), hasMarkdown: existsSync(markdownPath) }));",
        "process.exit(27);",
      ].join("\n"),
      "utf8",
    );

    const execution = spawnSync(process.execPath, [runner, "quick"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_execpath: fakePnpmCli,
        ARBOR_RUNNER_PROBE_PATH: probePath,
      },
      windowsHide: true,
      shell: false,
    });
    assert.ok(
      execution.status !== 0,
      "the injected pnpm CLI should fail before any suite runs",
    );

    const observedInitialState = JSON.parse(readFileSync(probePath, "utf8"));
    resultDirectory = observedInitialState.directory;
    assert.equal(dirname(resultDirectory), resultsRoot);
    assert.equal(observedInitialState.status, "running");
    assert.equal(observedInitialState.hasJson, true);
    assert.equal(observedInitialState.hasMarkdown, true);

    const finalManifest = JSON.parse(
      readFileSync(join(resultDirectory, "result-manifest.json"), "utf8"),
    );
    assert.equal(finalManifest.status, "interrupted");
    assert.equal(finalManifest.completeCoverage, false);
    assert.equal(finalManifest.current.group, "metadata");
    assert.equal(finalManifest.current.exitCode, 27);
    assert.ok(finalManifest.current.command.includes(fakePnpmCli));
    assert.match(
      readFileSync(join(resultDirectory, "summary.md"), "utf8"),
      /Status: interrupted/,
    );
  } finally {
    if (
      resultDirectory &&
      dirname(resultDirectory) === resultsRoot &&
      existsSync(resultDirectory)
    ) {
      rmSync(resultDirectory, { recursive: true, force: true });
    }
    rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});
