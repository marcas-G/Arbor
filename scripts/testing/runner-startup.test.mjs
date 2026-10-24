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
    assert.ok(Number.isSafeInteger(finalManifest.runner.pid));
    assert.equal(typeof finalManifest.runner.hostName, "string");
    assert.ok(
      Number.isFinite(
        Date.parse(finalManifest.runner.processStartedAtEstimate),
      ),
    );
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

test("Vitest bail stops after the first synthetic failure and records the unrun case", () => {
  const temporaryWorkspace = mkdtempSync(join(root, ".synthetic-failfast-"));
  try {
    const testPath = join(temporaryWorkspace, "fail-fast.test.ts");
    const configPath = join(temporaryWorkspace, "vitest.config.mjs");
    const sentinelPath = join(temporaryWorkspace, "second-case-ran.txt");
    const reportPath = join(temporaryWorkspace, "vitest-report.json");
    writeFileSync(
      testPath,
      [
        'import { writeFileSync } from "node:fs";',
        'test("first synthetic case fails", () => { throw new Error("SYNTHETIC_FIRST_FAILURE"); });',
        'test("second synthetic case must not run", () => { writeFileSync(process.env.ARBOR_FAILFAST_SENTINEL, "ran"); throw new Error("SYNTHETIC_SECOND_FAILURE"); });',
      ].join("\n"),
      "utf8",
    );
    const relativeTestPath = testPath
      .slice(root.length + 1)
      .replaceAll("\\", "/");
    writeFileSync(
      configPath,
      `export default { test: { root: ${JSON.stringify(root)}, include: [${JSON.stringify(relativeTestPath)}], globals: true } };\n`,
      "utf8",
    );

    const execution = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        configPath,
        "--no-file-parallelism",
        "--bail=1",
        "--reporter=json",
        "--outputFile",
        reportPath,
        testPath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ARBOR_FAILFAST_SENTINEL: sentinelPath,
        },
        windowsHide: true,
        shell: false,
        timeout: 30_000,
      },
    );

    assert.notEqual(execution.status, 0, execution.stdout + execution.stderr);
    assert.equal(
      existsSync(sentinelPath),
      false,
      "the second case must remain unrun",
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.numFailedTests, 1, JSON.stringify(report, null, 2));
    assert.equal(report.numPassedTests, 0);
    assert.equal(report.numTotalTests, 2);
    assert.ok(
      report.testResults.some((file) =>
        file.assertionResults.some(
          (assertion) =>
            assertion.fullName === "second synthetic case must not run" &&
            assertion.status !== "passed",
        ),
      ),
      "JSON report should retain a non-passed record for the case that bail skipped",
    );
  } finally {
    rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});

test("a failing release Vitest group finalizes failed without starting Playwright", () => {
  const temporaryWorkspace = mkdtempSync(
    join(tmpdir(), "arbor fail-fast runner probe-"),
  );
  let resultDirectory = null;
  try {
    const fakePnpmCli = join(temporaryWorkspace, "fake pnpm cli.mjs");
    const callsPath = join(temporaryWorkspace, "calls.json");
    writeFileSync(
      fakePnpmCli,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const args = process.argv.slice(2);",
        'appendFileSync(process.env.ARBOR_RUNNER_CALLS_PATH, JSON.stringify({ args, directory: process.env.ARBOR_TEST_RESULT_DIRECTORY }) + "\\n");',
        'if (args[0] === "--version") { console.log("12.4.2"); process.exit(0); }',
        'if (args.includes("vitest")) { const reportIndex = args.indexOf("--outputFile"); writeFileSync(args[reportIndex + 1], JSON.stringify({ numTotalTests: 2, numPassedTests: 0, numFailedTests: 1, numPendingTests: 1, testResults: [] })); process.exit(1); }',
        'if (args.includes("playwright")) process.exit(42);',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const execution = spawnSync(process.execPath, [runner, "release"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_execpath: fakePnpmCli,
        ARBOR_RUNNER_CALLS_PATH: callsPath,
      },
      windowsHide: true,
      shell: false,
      timeout: 30_000,
    });
    assert.notEqual(execution.status, 0, execution.stdout + execution.stderr);

    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    resultDirectory = calls[0].directory;
    assert.equal(
      calls.some((call) => call.args.includes("playwright")),
      false,
      "Playwright must not start after the failed Vitest group",
    );
    const vitestCall = calls.find((call) => call.args.includes("vitest"));
    assert.ok(
      vitestCall,
      "release profile should reach its first functional group",
    );
    assert.ok(vitestCall.args.includes("--bail=1"));

    const finalManifest = JSON.parse(
      readFileSync(join(resultDirectory, "result-manifest.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(join(root, "planning/testing/manifest.json"), "utf8"),
    );
    assert.equal(finalManifest.status, "failed");
    assert.equal(finalManifest.exitCode, 1);
    assert.equal(finalManifest.completeCoverage, false);
    assert.equal(finalManifest.selectedFiles.length, 70);
    assert.equal(
      finalManifest.selectedFiles.length,
      manifest.groups.functionalVitest.length +
        manifest.groups.functionalUi.length,
    );
    assert.deepEqual(
      finalManifest.groups.map((group) => group.name),
      ["build", "functionalVitest"],
    );
    assert.equal(finalManifest.groups[1].counts.failed, 1);
    assert.equal(finalManifest.groups[1].counts.skipped, 1);
    assert.match(
      readFileSync(join(resultDirectory, "summary.md"), "utf8"),
      /Status: failed/,
    );
    assert.match(
      readFileSync(join(resultDirectory, "summary.md"), "utf8"),
      /Complete coverage: false/,
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
