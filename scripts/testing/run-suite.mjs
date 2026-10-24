import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./check-manifest.mjs";
import { buildResumePlan, qualifiesCompleteCoverage } from "./resume-utils.mjs";
import { buildProcessSpec, resolvePnpmInvocation } from "./runner-utils.mjs";
import {
  collectEnvironmentRedactionValues,
  normalizeVitestJsonReport,
  redactTextForOutput,
} from "./vitest-progress-reporter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(root, "planning/testing/manifest.json");
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const profileName = process.argv[2];
const validateOnly = process.argv.includes("--validate-only");
const resumeOptionIndex = process.argv.indexOf("--resume-from");

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
let resumeSource = null;
if (resumeOptionIndex >= 0) {
  const supplied = process.argv[resumeOptionIndex + 1];
  if (!supplied || supplied.startsWith("--"))
    fail("--resume-from requires a .test-results run directory");
  const candidate = resolve(root, supplied);
  const stats = statSync(candidate, { throwIfNoEntry: false });
  if (!stats?.isDirectory())
    fail(`resume directory does not exist: ${supplied}`);
  const realResultsRoot = realpathSync(resultsRoot);
  const realCandidate = realpathSync(candidate);
  const resultRelative = relative(realResultsRoot, realCandidate);
  if (
    isAbsolute(resultRelative) ||
    resultRelative === ".." ||
    resultRelative.startsWith("..\\") ||
    resultRelative.startsWith("../")
  ) {
    fail("--resume-from must name a directory inside .test-results");
  }
  const previousResult = parseJson(join(realCandidate, "result-manifest.json"));
  if (!previousResult)
    fail("resume directory has no readable result-manifest.json");
  resumeSource = { directory: realCandidate, result: previousResult };
}
const startedAt = new Date();
const selectedFiles = profile.groups.flatMap((group) => manifest.groups[group]);
let executionFiles = [...selectedFiles];
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
  // Record the originating PID, host, and estimated start time for run identification and audit.
  runner: {
    pid: process.pid,
    hostName: hostname(),
    processStartedAtEstimate: new Date(
      Date.now() - process.uptime() * 1000,
    ).toISOString(),
  },
  selectedFiles,
  executionFiles,
  passedFiles: [],
  resume: resumeSource
    ? {
        sourceDirectory: resumeSource.directory,
        sourceRunId: resumeSource.result.runId ?? null,
        sourceGitSha: resumeSource.result.gitSha ?? null,
        compatible: null,
        reason: "pending",
        inheritedBuild: false,
        inheritedFiles: [],
        invalidatedFiles: [],
        ignoredOrchestrationChanges: [],
      }
    : null,
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
  lastHeartbeatAt: null,
  exitCode: null,
};

let activeChild = null;
let activeHeartbeatTimer = null;
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
    `- Executed test files: ${result.executionFiles.length}`,
    `- Inherited passed files: ${result.resume?.inheritedFiles.length ?? 0}`,
    `- Resume source: ${result.resume?.sourceDirectory ?? "none"}`,
    `- Resume compatibility: ${result.resume ? `${result.resume.compatible} (${result.resume.reason})` : "not requested"}`,
    `- Exit code: ${result.exitCode ?? "pending"}`,
    `- Signal: ${result.signal ?? "none"}`,
    `- Current group/command: ${result.current ? `${result.current.group} / ${result.current.command.join(" ")} (elapsed ${result.current.elapsedMs ?? 0} ms; heartbeat ${result.current.lastHeartbeatAt ?? "pending"})` : "none"}`,
    `- Last heartbeat: ${result.lastHeartbeatAt ?? "none"}`,
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
  if (activeHeartbeatTimer) clearInterval(activeHeartbeatTimer);
  const startedAt = new Date().toISOString();
  result.current = {
    group,
    command: [command, ...args],
    startedAt,
    elapsedMs: 0,
    lastHeartbeatAt: startedAt,
    exitCode: null,
    signal: null,
  };
  result.lastHeartbeatAt = startedAt;
  persistManifest();
  activeHeartbeatTimer = setInterval(() => {
    if (!result.current) return;
    const heartbeatAt = new Date().toISOString();
    result.lastHeartbeatAt = heartbeatAt;
    result.current.lastHeartbeatAt = heartbeatAt;
    result.current.elapsedMs = Math.max(
      0,
      Date.now() - Date.parse(result.current.startedAt),
    );
    persistManifest();
    console.log(
      `test runner heartbeat: ${group} / ${command}; elapsed ${result.current.elapsedMs} ms; ${heartbeatAt}`,
    );
  }, 30_000);
  activeHeartbeatTimer.unref?.();
}

function stopCurrentHeartbeat() {
  if (activeHeartbeatTimer) clearInterval(activeHeartbeatTimer);
  activeHeartbeatTimer = null;
}

function handleSignal(signal) {
  if (pendingSignal) return;
  pendingSignal = signal;
  stopRequested = true;
  result.status = "interrupted";
  result.completeCoverage = false;
  result.signal = signal;
  result.exitCode = signal === "SIGINT" ? 130 : 143;
  stopCurrentHeartbeat();
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
  stopCurrentHeartbeat();
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
      ARBOR_TEST_PROFILE: profileName,
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
  const pendingOutput = { stdout: "", stderr: "" };
  const redactionValues = collectEnvironmentRedactionValues(process.env);
  const redactOutput = (value) => redactTextForOutput(value, redactionValues);
  const flushOutput = (target, final = false) => {
    const buffer = pendingOutput[target];
    const lines = buffer.split(/(?<=\n)/u);
    const trailing = lines.pop() ?? "";
    const ready = final ? `${lines.join("")}${trailing}` : lines.join("");
    pendingOutput[target] = final ? "" : trailing;
    if (!ready) return;
    const safeText = redactOutput(ready);
    const safeBuffer = Buffer.from(safeText, "utf8");
    if (target === "stdout") stdout += safeText;
    else stderr += safeText;
    writeFileSync(logDescriptor, safeBuffer, { flag: "a" });
    (target === "stdout" ? process.stdout : process.stderr).write(safeBuffer);
  };
  const output = (target) => (chunk) => {
    pendingOutput[target] += chunk.toString("utf8");
    flushOutput(target);
  };
  child.stdout.on("data", output("stdout"));
  child.stderr.on("data", output("stderr"));

  return new Promise((resolvePromise) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      stopCurrentHeartbeat();
      activeChild = null;
      flushOutput("stdout", true);
      flushOutput("stderr", true);
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
      stopCurrentHeartbeat();
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
  const groupInventory = new Set(manifest.groups[groupName]);
  const files = executionFiles.filter((path) => groupInventory.has(path));
  if (files.length === 0) return;
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
    commandResult = await runCommand(
      groupName,
      "vitest",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        config,
        "--no-cache",
        "--no-file-parallelism",
        "--bail=1",
        "--reporter=json",
        "--reporter=./scripts/testing/vitest-progress-reporter.mjs",
        "--outputFile",
        reportPath,
        ...files,
      ],
      {
        ARBOR_VITEST_PROGRESS_BASENAME: safe(groupName),
      },
    );
    const report = parseJson(reportPath);
    const progress = parseJson(
      join(resultDirectory, `${safe(groupName)}-progress.json`),
    );
    if (report) {
      normalizeVitestJsonReport(report, progress);
      atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    group.counts = testCounts(report, "vitest");
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
        "--max-failures=1",
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
  stopCurrentHeartbeat();
  const finishedAt = new Date();
  result.groups = groupRunSummary();
  const passedFiles = new Set(result.resume?.inheritedFiles ?? []);
  for (const group of groups) {
    if (group.exitCode === 0) {
      for (const file of group.files) passedFiles.add(file);
      continue;
    }
    if (group.runner !== "vitest-functional" && group.runner !== "vitest-unit")
      continue;
    const progress = parseJson(
      join(resultDirectory, `${safe(group.name)}-progress.json`),
    );
    for (const file of progress?.files ?? []) {
      if (file.status !== "passed") continue;
      const path = String(file.relativeFile ?? file.file).replaceAll("\\", "/");
      if (selectedFiles.includes(path)) passedFiles.add(path);
    }
  }
  result.passedFiles = [...passedFiles].sort();
  if (pendingSignal) {
    result.status = "interrupted";
    result.signal = pendingSignal;
    result.exitCode ??= pendingSignal === "SIGINT" ? 130 : 143;
    result.completeCoverage = false;
  } else if (result.status === "running") {
    result.status = result.exitCode === 0 ? "passed" : "failed";
  }
  result.completeCoverage = qualifiesCompleteCoverage({
    status: result.status,
    profileCompleteCoverage: profile.completeCoverage,
    selectedFiles,
    passedFiles: result.passedFiles,
    buildRequired: profile.build === true,
    inheritedBuild: result.resume?.inheritedBuild === true,
    groups,
  });
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
  if (!stopRequested && resumeSource) {
    const previousProgress = parseJson(
      join(resumeSource.directory, "functionalVitest-progress.json"),
    );
    const changedOutput = await captureMetadata(
      "metadata",
      "git-diff-resume-base",
      "git",
      [
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        resumeSource.result.gitSha,
        result.gitSha,
      ],
    );
    const changedPaths = changedOutput
      .split(/\r?\n/u)
      .map((path) => path.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    const groupFiles = Object.fromEntries(
      profile.groups.map((groupName) => [
        groupName,
        manifest.groups[groupName],
      ]),
    );
    const plan = buildResumePlan({
      profileName,
      manifestSha256,
      selectedFiles,
      groupFiles,
      previousResult: resumeSource.result,
      previousVitestProgress: previousProgress,
      changedPaths,
      currentGitDirty: result.gitDirty,
    });
    executionFiles = plan.executionFiles;
    result.executionFiles = [...executionFiles];
    result.resume = {
      ...result.resume,
      compatible: plan.compatible,
      reason: plan.reason,
      inheritedBuild: plan.inheritBuild,
      inheritedFiles: plan.inheritedFiles,
      invalidatedFiles: plan.invalidatedFiles,
      ignoredOrchestrationChanges: plan.ignoredOrchestrationChanges,
      changedPaths,
    };
    console.log(
      plan.compatible
        ? `Resume accepted: inherited ${plan.inheritedFiles.length}; executing ${executionFiles.length}.`
        : `Resume rejected (${plan.reason}); executing the full ${executionFiles.length} files.`,
    );
  }
  if (!stopRequested) result.current = null;
  persistManifest();

  if (
    profile.build &&
    result.resume?.inheritedBuild !== true &&
    !stopRequested &&
    result.status === "running"
  )
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
