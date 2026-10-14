import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./check-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(root, "planning/testing/manifest.json");
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const profileName = process.argv[2];
const validateOnly = process.argv.includes("--validate-only");

function fail(message) {
  console.error(`test runner: ${message}`);
  process.exit(2);
}

const validation = validateManifest(manifest);
if (!validation.ok) fail(validation.errors.join("; "));
if (validateOnly) {
  console.log(JSON.stringify(validation, null, 2));
  process.exit(0);
}
if (!profileName || !manifest.profiles[profileName]) {
  fail(`choose a profile: ${Object.keys(manifest.profiles).join(", ")}`);
}

const profile = manifest.profiles[profileName];
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const resultDirectory = join(root, ".test-results", runId);
mkdirSync(resultDirectory, { recursive: true });
const startTime = new Date();
const gitSha = commandOutput("git", ["rev-parse", "HEAD"]);
const gitDirty = commandOutput("git", ["status", "--porcelain"]).length > 0;
const selectedFiles = profile.groups.flatMap((group) => manifest.groups[group]);
const groups = [];
let exitCode = 0;

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

function execute(command, args, env = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ARBOR_TEST_CACHE: "off", ...env },
    shell: process.platform === "win32",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(
    join(resultDirectory, `${groups.length + 1}-${safe(command)}.log`),
    output,
    "utf8",
  );
  process.stdout.write(output);
  return {
    command: [command, ...args],
    durationMs,
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
  };
}

function safe(value) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function testCounts(report, kind) {
  if (!report)
    return { passed: null, failed: null, skipped: null, total: null };
  if (kind === "playwright") {
    const stats = report.stats ?? {};
    const passed = stats.expected ?? stats.passed ?? null;
    const failed = (stats.unexpected ?? 0) + (stats.flaky ?? 0);
    const skipped = stats.skipped ?? 0;
    return {
      passed,
      failed,
      skipped,
      total: passed === null ? null : passed + failed + skipped,
    };
  }
  const passed = report.numPassedTests ?? null;
  const failed = report.numFailedTests ?? null;
  const skipped = report.numPendingTests ?? report.numTodoTests ?? 0;
  const total =
    report.numTotalTests ??
    (passed === null || failed === null ? null : passed + failed + skipped);
  return { passed, failed, skipped, total };
}

function runGroup(name, files, runner) {
  const reportPath = join(resultDirectory, `${safe(name)}.json`);
  let commands;
  let report;
  if (runner === "vitest-functional" || runner === "vitest-unit") {
    const config =
      runner === "vitest-functional"
        ? "vitest.functional.config.ts"
        : "vitest.config.ts";
    commands = execute("pnpm", [
      "exec",
      "vitest",
      "run",
      "--config",
      config,
      "--no-cache",
      "--no-file-parallelism",
      "--reporter=json",
      "--outputFile",
      reportPath,
      ...files,
    ]);
    report = parseJson(reportPath);
  } else if (runner === "playwright") {
    const playwrightReport = join(
      resultDirectory,
      `${safe(name)}-playwright.json`,
    );
    commands = execute(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.functional.config.ts",
        "--reporter=json",
        "--retries=0",
        ...files,
      ],
      { PLAYWRIGHT_JSON_OUTPUT_NAME: playwrightReport },
    );
    report = parseJson(playwrightReport);
  } else {
    throw new Error(`unknown test runner ${runner}`);
  }
  const counts = testCounts(
    report,
    runner === "playwright" ? "playwright" : "vitest",
  );
  groups.push({
    name,
    runner,
    files,
    durationMs: commands.durationMs,
    exitCode: commands.exitCode,
    counts,
    command: commands.command,
  });
  if (commands.exitCode !== 0) exitCode = commands.exitCode;
}

try {
  if (profile.build) {
    const buildCommands = [
      ["pnpm", ["build"]],
      ["pnpm", ["--filter", "@arbor/web", "build"]],
    ];
    const started = Date.now();
    let stageExit = 0;
    const commands = [];
    for (const [command, args] of buildCommands) {
      const result = execute(command, args);
      commands.push(result);
      if (result.exitCode !== 0) {
        stageExit = result.exitCode;
        break;
      }
    }
    groups.push({
      name: "build",
      runner: "build",
      files: [],
      durationMs: Date.now() - started,
      exitCode: stageExit,
      counts: null,
      commands,
    });
    if (stageExit !== 0) exitCode = stageExit;
  }

  if (exitCode === 0 && profile.webTypecheck) {
    const result = execute("pnpm", ["--filter", "@arbor/web", "typecheck"]);
    groups.push({
      name: "web-typecheck",
      runner: "typecheck",
      files: [],
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      counts: null,
      command: result.command,
    });
    if (result.exitCode !== 0) exitCode = result.exitCode;
  }

  if (exitCode === 0) {
    for (const groupName of profile.groups) {
      const files = manifest.groups[groupName];
      const runner = files.every((path) => path.endsWith(".spec.ts"))
        ? "playwright"
        : groupName === "quick"
          ? "vitest-unit"
          : "vitest-functional";
      runGroup(groupName, files, runner);
      if (exitCode !== 0) break;
    }
  }
} finally {
  const finishedAt = new Date();
  const fullCoverage =
    profile.completeCoverage === true &&
    groups.some(
      (group) => group.name === "functionalVitest" && group.exitCode === 0,
    ) &&
    groups.some(
      (group) => group.name === "functionalUi" && group.exitCode === 0,
    ) &&
    exitCode === 0;
  const result = {
    schemaVersion: 1,
    runId,
    gitSha,
    gitDirty,
    profile: profileName,
    completeCoverage: fullCoverage,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    selectedFiles,
    groups,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pnpm: commandOutput("pnpm", ["--version"]),
    },
    startedAt: startTime.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startTime.getTime(),
    exitCode,
  };
  writeFileSync(
    join(resultDirectory, "result-manifest.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  const summary = [
    `# Test run ${runId}`,
    "",
    `- Profile: ${profileName}`,
    `- Git SHA: ${gitSha || "unknown"}${gitDirty ? " (dirty at start)" : ""}`,
    `- Complete coverage: ${fullCoverage}`,
    `- Selected test files: ${selectedFiles.length}`,
    `- Exit code: ${exitCode}`,
    `- Result manifest: result-manifest.json`,
    "",
    "| Group | Files | Duration (ms) | Exit | Passed | Failed | Skipped | Total |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...groups.map(
      (group) =>
        `| ${group.name} | ${group.files.length} | ${group.durationMs} | ${group.exitCode} | ${group.counts?.passed ?? "—"} | ${group.counts?.failed ?? "—"} | ${group.counts?.skipped ?? "—"} | ${group.counts?.total ?? "—"} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(resultDirectory, "summary.md"), summary, "utf8");
  console.log(`Test result: ${join(resultDirectory, "summary.md")}`);
}

process.exitCode = exitCode;
