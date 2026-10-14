import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./check-manifest.mjs";
import { buildProcessSpec, resolvePnpmInvocation } from "./runner-utils.mjs";

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
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`;
const resultDirectory = join(root, ".test-results", runId);
const resultsRoot = dirname(resultDirectory);
mkdirSync(resultsRoot, { recursive: true });
const startedAt = new Date();
const selectedFiles = profile.groups.flatMap((group) => manifest.groups[group]);
const groups = [];
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const result = {
  schemaVersion: 1,
  runId,
  status: "running",
  gitSha: null,
  gitDirty: null,
  profile: profileName,
  completeCoverage: false,
  manifestSha256,
  selectedFiles,
  groups,
  current: null,
  signal: null,
  error: null,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm: null,
  },
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  durationMs: null,
  exitCode: null,
};

let activeChild = null;
let pendingSignal = null;
let stopRequested = false;
let logIndex = 0;

function atomicWrite(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, "utf8");
  const descriptor = openSync(temporaryPath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

function summaryMarkdown() {
  return [
    `# Test run ${runId}`,
    "",
    `- Status: ${result.status}`,
    `- Profile: ${profileName}`,
    `- Git SHA: ${result.gitSha ?? "pending"}${result.gitDirty ? " (dirty at start)" : ""}`,
    `- Complete coverage: ${result.completeCoverage}`,
    `- Selected test files: ${selectedFiles.length}`,
    `- Exit code: ${result.exitCode ?? "pending"}`,
    `- Signal: ${result.signal ?? "none"}`,
    `- Current group/command: ${result.current ? `${result.current.group} / ${result.current.command.join(" ")}` : "none"}`,
    "",
    "| Group | Files | Duration (ms) | Exit | Signal | Passed | Failed | Skipped | Total |",
    "|---|---:|---:|---:|---|---:|---:|---:|---:|",
    ...groups.map(
      (group) =>
        `| ${group.name} | ${group.files.length} | ${group.durationMs ?? "running"} | ${group.exitCode ?? "running"} | ${group.signal ?? "—"} | ${group.counts?.passed ?? "—"} | ${group.counts?.failed ?? "—"} | ${group.counts?.skipped ?? "—"} | ${group.counts?.total ?? "—"} |`,
    ),
    "",
    `Machine result: ${join(resultDirectory, "result-manifest.json")}`,
    "",
  ].join("\n");
}

function persistManifest() {
  atomicWrite(
    join(resultDirectory, "result-manifest.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  atomicWrite(join(resultDirectory, "summary.md"), summaryMarkdown());
}

function persistInitialManifest() {
  const stagingDirectory = `${resultDirectory}.initial-${process.pid}`;
  mkdirSync(stagingDirectory, { recursive: false });
  for (const [name, contents] of [
    ["result-manifest.json", `${JSON.stringify(result, null, 2)}\n`],
    ["summary.md", summaryMarkdown()],
  ]) {
    const path = join(stagingDirectory, name);
    writeFileSync(path, contents, "utf8");
    const descriptor = openSync(path, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  renameSync(stagingDirectory, resultDirectory);
}

function safe(value) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

function setCurrent(group, command, args) {
  result.current = {
    group,
    command: [command, ...args],
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
  };
  persistManifest();
}

function handleSignal(signal) {
  if (pendingSignal) return;
  pendingSignal = signal;
  stopRequested = true;
  result.status = "interrupted";
  result.completeCoverage = false;
  result.signal = signal;
  result.exitCode = signal === "SIGINT" ? 130 : 143;
  if (result.current) {
    result.current.interrupted = true;
  }
  persistManifest();
  activeChild?.kill(signal);
}

function handleFatal(error) {
  stopRequested = true;
  result.status = "interrupted";
  result.completeCoverage = false;
  result.exitCode = 1;
  result.error =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (result.current) result.current.interrupted = true;
  try {
    persistManifest();
  } catch (writeError) {
    console.error("Unable to persist interrupted test manifest", writeError);
  }
  activeChild?.kill("SIGTERM");
}

function installInterruptionHandlers() {
  const sigint = () => handleSignal("SIGINT");
  const sigterm = () => handleSignal("SIGTERM");
  const uncaught = (error) => handleFatal(error);
  const rejection = (error) => handleFatal(error);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", rejection);
  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    process.off("uncaughtException", uncaught);
    process.off("unhandledRejection", rejection);
  };
}

let pnpmInvocation = null;

function processSpec(args, env = {}) {
  return buildProcessSpec({
    platform: process.platform,
    executable: pnpmInvocation.executable,
    prefixArgs: pnpmInvocation.prefixArgs,
    args,
    cwd: root,
    env: {
      ...process.env,
      ARBOR_TEST_CACHE: "off",
      ARBOR_TEST_RESULT_DIRECTORY: resultDirectory,
      ...env,
    },
  });
}

function runCommand(groupName, label, args, env = {}) {
  const spec = processSpec(args, env);
  const command = [spec.executable, ...spec.args];
  setCurrent(groupName, spec.executable, spec.args);
  const started = Date.now();
  logIndex += 1;
  const logPath = join(
    resultDirectory,
    `${String(logIndex).padStart(2, "0")}-${safe(groupName)}-${safe(label)}.log`,
  );
  const logDescriptor = openSync(logPath, "w");
  const child = spawn(spec.executable, spec.args, spec.options);
  activeChild = child;
  let stdout = "";
  let stderr = "";
  const output = (target) => (chunk) => {
    const text = chunk.toString("utf8");
    if (target === "stdout") stdout += text;
    else stderr += text;
    writeFileSync(logDescriptor, chunk, { flag: "a" });
    (target === "stdout" ? process.stdout : process.stderr).write(chunk);
  };
  child.stdout.on("data", output("stdout"));
  child.stderr.on("data", output("stderr"));

  return new Promise((resolvePromise) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      activeChild = null;
      closeSync(logDescriptor);
      const exitCode = code ?? (signal ? 128 : 1);
      const commandResult = {
        label,
        command,
        durationMs: Date.now() - started,
        exitCode,
        signal: signal ?? null,
        error: spawnError ? `${spawnError.name}: ${spawnError.message}` : null,
        log: logPath,
      };
      if (result.current) {
        result.current.exitCode = exitCode;
        result.current.signal = signal ?? null;
        result.current.finishedAt = new Date().toISOString();
      }
      persistManifest();
      resolvePromise({ ...commandResult, stdout, stderr });
    });
    if (pendingSignal) child.kill(pendingSignal);
  });
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

async function captureMetadata(group, label, executable, args) {
  result.current = {
    group,
    command: [executable, ...args],
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
  };
  persistManifest();
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, ARBOR_TEST_RESULT_DIRECTORY: resultDirectory },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  let output = "";
  let spawnError = null;
  child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
  child.stderr.on("data", () => {});
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      activeChild = null;
      if (result.current) {
        result.current.exitCode = code ?? (signal ? 128 : 1);
        result.current.signal = signal ?? null;
        result.current.error = spawnError
          ? `${spawnError.name}: ${spawnError.message}`
          : null;
        result.current.finishedAt = new Date().toISOString();
        if (!stopRequested && !spawnError && code === 0) result.current = null;
      }
      persistManifest();
      if (!stopRequested && (spawnError || code !== 0)) {
        rejectPromise(new Error(`${label} exited with code ${code}`));
      } else {
        resolvePromise(output.trim());
      }
    });
  });
}

async function runTestGroup(groupName) {
  const files = manifest.groups[groupName];
  const runner = files.every((path) => path.endsWith(".spec.ts"))
    ? "playwright"
    : groupName === "quick"
      ? "vitest-unit"
      : "vitest-functional";
  const group = {
    name: groupName,
    runner,
    files,
    durationMs: null,
    exitCode: null,
    signal: null,
    counts: null,
    commands: [],
  };
  groups.push(group);
  const reportPath = join(resultDirectory, `${safe(groupName)}.json`);
  const started = Date.now();
  let commandResult;
  if (runner === "vitest-functional" || runner === "vitest-unit") {
    const config =
      runner === "vitest-functional"
        ? "vitest.functional.config.ts"
        : "vitest.config.ts";
    commandResult = await runCommand(groupName, "vitest", [
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
    group.counts = testCounts(parseJson(reportPath), "vitest");
  } else {
    const playwrightReport = join(
      resultDirectory,
      `${safe(groupName)}-playwright.json`,
    );
    commandResult = await runCommand(
      groupName,
      "playwright",
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
    group.counts = testCounts(parseJson(playwrightReport), "playwright");
  }
  group.commands.push(commandResult);
  group.durationMs = Date.now() - started;
  group.exitCode = commandResult.exitCode;
  group.signal = commandResult.signal;
  if (!stopRequested) result.current = null;
  persistManifest();
  if (stopRequested) return;
  if (group.exitCode !== 0) {
    result.status = "failed";
    result.exitCode = group.exitCode;
  }
}

async function runBuild() {
  const group = {
    name: "build",
    runner: "build",
    files: [],
    durationMs: null,
    exitCode: null,
    signal: null,
    counts: null,
    commands: [],
  };
  groups.push(group);
  const started = Date.now();
  for (const [label, args] of [
    ["root", ["build"]],
    ["web", ["--filter", "@arbor/web", "build"]],
  ]) {
    const commandResult = await runCommand("build", label, args);
    group.commands.push(commandResult);
    if (commandResult.exitCode !== 0 || stopRequested) {
      group.exitCode = commandResult.exitCode;
      group.signal = commandResult.signal;
      break;
    }
  }
  group.durationMs = Date.now() - started;
  if (group.exitCode === null) group.exitCode = 0;
  if (!stopRequested) result.current = null;
  persistManifest();
  if (!stopRequested && group.exitCode !== 0) {
    result.status = "failed";
    result.exitCode = group.exitCode;
  }
}

function groupRunSummary() {
  return groups.map(
    ({
      name,
      runner,
      files,
      durationMs,
      exitCode,
      signal,
      counts,
      commands,
    }) => ({
      name,
      runner,
      files,
      durationMs,
      exitCode,
      signal,
      counts,
      commands: commands.map(({ stdout, stderr, ...command }) => command),
    }),
  );
}

function finalize() {
  const finishedAt = new Date();
  result.groups = groupRunSummary();
  if (pendingSignal) {
    result.status = "interrupted";
    result.signal = pendingSignal;
    result.exitCode ??= pendingSignal === "SIGINT" ? 130 : 143;
    result.completeCoverage = false;
  } else if (result.status === "running") {
    result.status = result.exitCode === 0 ? "passed" : "failed";
  }
  result.completeCoverage =
    result.status === "passed" &&
    profile.completeCoverage === true &&
    groups.some(
      (group) => group.name === "functionalVitest" && group.exitCode === 0,
    ) &&
    groups.some(
      (group) => group.name === "functionalUi" && group.exitCode === 0,
    );
  result.finishedAt = finishedAt.toISOString();
  result.durationMs = finishedAt.getTime() - startedAt.getTime();
  result.current = result.current
    ? { ...result.current, interrupted: result.status === "interrupted" }
    : null;
  persistManifest();
}

const removeInterruptionHandlers = installInterruptionHandlers();
try {
  // Persist both initial artifacts before running git, pnpm, or any suite command.
  persistInitialManifest();
  console.log(
    `Running ${profileName}; initial result: ${join(resultDirectory, "summary.md")}`,
  );
  pnpmInvocation = resolvePnpmInvocation({ cwd: root });
  result.gitSha = await captureMetadata("metadata", "git-rev", "git", [
    "rev-parse",
    "HEAD",
  ]);
  if (!stopRequested) {
    result.gitDirty = Boolean(
      await captureMetadata("metadata", "git-status", "git", [
        "status",
        "--porcelain",
      ]),
    );
  }
  if (!stopRequested) {
    const pnpmVersion = await captureMetadata(
      "metadata",
      "pnpm-version",
      pnpmInvocation.executable,
      [...pnpmInvocation.prefixArgs, "--version"],
    );
    result.environment.pnpm = pnpmVersion;
  }
  if (!stopRequested) result.current = null;
  persistManifest();

  if (profile.build && !stopRequested && result.status === "running")
    await runBuild();
  if (profile.webTypecheck && !stopRequested && result.status === "running") {
    const group = {
      name: "web-typecheck",
      runner: "typecheck",
      files: [],
      durationMs: null,
      exitCode: null,
      signal: null,
      counts: null,
      commands: [],
    };
    groups.push(group);
    const started = Date.now();
    const commandResult = await runCommand("web-typecheck", "typecheck", [
      "--filter",
      "@arbor/web",
      "typecheck",
    ]);
    group.commands.push(commandResult);
    group.durationMs = Date.now() - started;
    group.exitCode = commandResult.exitCode;
    group.signal = commandResult.signal;
    if (!stopRequested) result.current = null;
    if (!stopRequested && group.exitCode !== 0) {
      result.status = "failed";
      result.exitCode = group.exitCode;
    }
    persistManifest();
  }
  if (!stopRequested && result.status === "running") {
    for (const groupName of profile.groups) {
      await runTestGroup(groupName);
      if (stopRequested || result.status !== "running") break;
    }
  }
  if (!stopRequested && result.status === "running") result.exitCode = 0;
} catch (error) {
  handleFatal(error);
} finally {
  finalize();
  removeInterruptionHandlers();
}

process.exitCode = result.exitCode ?? 1;
