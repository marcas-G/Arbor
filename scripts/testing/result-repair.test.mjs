import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicReplaceResultManifest,
  resolveSafeResultManifest,
} from "./repair-result-paths.mjs";
import { inspectRunnerProcess, repairRunningResult } from "./result-repair.mjs";

const runningResult = (overrides = {}) => ({
  runId: "2026-10-14T11-44-22-397Z-24864",
  status: "running",
  completeCoverage: false,
  startedAt: "2026-10-14T11:44:22.398Z",
  lastHeartbeatAt: "2026-10-14T11:46:54.953Z",
  durationMs: null,
  exitCode: null,
  signal: null,
  current: {
    group: "functionalUi",
    command: ["pnpm", "exec", "playwright", "test"],
    interrupted: false,
  },
  ...overrides,
});

test("runner PID probe fails closed for live, inaccessible, or remote PIDs", () => {
  const runner = { pid: 24864, hostName: "TEST-HOST" };
  assert.deepEqual(
    inspectRunnerProcess(runner, "test-host", () => undefined),
    { state: "alive", pid: 24864 },
  );
  assert.deepEqual(
    inspectRunnerProcess(runner, "other-host", () => undefined),
    { state: "remote", hostName: "TEST-HOST" },
  );
  assert.deepEqual(
    inspectRunnerProcess(null, "test-host", () => {}),
    {
      state: "unknown",
    },
  );
  assert.deepEqual(
    inspectRunnerProcess(runner, "test-host", () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    }),
    { state: "alive", pid: 24864 },
  );
});

test("explicit repair marks an absent same-host runner interrupted and preserves heartbeat evidence", () => {
  const result = runningResult({
    runner: {
      pid: 24864,
      hostName: "test-host",
      processStartedAtEstimate: "2001-01-01T00:00:00.000Z",
    },
  });
  const processState = inspectRunnerProcess(result.runner, "test-host", () => {
    throw Object.assign(new Error("not found"), { code: "ESRCH" });
  });
  const repaired = repairRunningResult(result, {
    runId: result.runId,
    currentHostName: "test-host",
    processState,
    evidence:
      "Confirmed PID 24864 is absent on test-host after checking the process list.",
    at: "2026-10-14T12:00:00.000Z",
    operator: "auditor",
  });

  assert.equal(repaired.status, "interrupted");
  assert.equal(repaired.completeCoverage, false);
  assert.equal(repaired.lastHeartbeatAt, result.lastHeartbeatAt);
  assert.equal(repaired.current.interrupted, true);
  assert.equal(repaired.exitCode, null);
  assert.equal(repaired.signal, null);
  assert.deepEqual(repaired.recovery, {
    kind: "explicit-stale-result-repair",
    verification: "same-host-pid-absent",
    hostName: "test-host",
    operator: "auditor",
    at: "2026-10-14T12:00:00.000Z",
    evidence:
      "Confirmed PID 24864 is absent on test-host after checking the process list.",
  });
});

test("legacy repair requires recorded evidence; live and mismatched runs are refused", () => {
  const legacy = runningResult();
  const repairLegacy = (evidence) =>
    repairRunningResult(legacy, {
      runId: legacy.runId,
      currentHostName: "test-host",
      processState: { state: "unknown" },
      evidence,
      at: "2026-10-14T12:00:00.000Z",
    });

  assert.throws(() => repairLegacy("too short"), /at least 12/u);
  const repaired = repairLegacy(
    "Observed no runner or Playwright process; the latest log and heartbeat are unchanged.",
  );
  assert.equal(repaired.recovery.verification, "manual-legacy-evidence");
  assert.equal(repaired.lastHeartbeatAt, legacy.lastHeartbeatAt);
  const identified = runningResult({
    runner: {
      pid: 24864,
      hostName: "test-host",
      processStartedAtEstimate: "2001-01-01T00:00:00.000Z",
    },
  });
  assert.throws(
    () =>
      repairRunningResult(identified, {
        runId: identified.runId,
        currentHostName: "test-host",
        processState: { state: "alive", pid: 24864 },
        evidence: "Observed that the process is no longer active on this host.",
      }),
    /only an absent same-host PID/u,
  );
  assert.throws(
    () =>
      repairRunningResult(legacy, {
        runId: "another-run",
        currentHostName: "test-host",
        processState: { state: "unknown" },
        evidence:
          "Observed no runner process and confirmed the manifest is stale.",
      }),
    /does not match/u,
  );
});

test("repair rejects any partial runner identity and redacts sensitive evidence", () => {
  for (const runner of [
    null,
    {},
    { pid: 24864 },
    { pid: 24864, hostName: "test-host" },
    {
      pid: 24864,
      hostName: "test-host",
      processStartedAtEstimate: "not-a-date",
    },
  ]) {
    const partial = runningResult({ runner });
    assert.throws(
      () =>
        repairRunningResult(partial, {
          runId: partial.runId,
          currentHostName: "test-host",
          processState: { state: "unknown" },
          evidence: "Operator confirmed the old run is no longer active.",
        }),
      /partial or malformed/u,
    );
  }

  const legacy = runningResult();
  const secret = "environment-secret-value";
  const bearer = "Bearer bearer-secret-value";
  const keySecret = "json-key-secret-value";
  const apiSecret = "sk-this-is-a-secret-provider-key";
  const evidence = JSON.stringify({
    apiKey: keySecret,
    note: `${bearer} ${apiSecret}`,
    detail: `the host reported ${secret}`,
  });
  const repaired = repairRunningResult(legacy, {
    runId: legacy.runId,
    currentHostName: "test-host",
    processState: { state: "unknown" },
    evidence,
    redactionValues: { API_TOKEN: secret },
    at: "2026-10-14T12:00:00.000Z",
  });
  const recorded = JSON.parse(repaired.recovery.evidence);

  assert.equal(recorded.apiKey, "[REDACTED]");
  assert.equal(recorded.note, "Bearer [REDACTED] sk-[REDACTED]");
  assert.equal(recorded.detail, "the host reported [REDACTED]");
  for (const value of [
    secret,
    bearer.split(" ")[1],
    keySecret,
    apiSecret.slice(3),
  ]) {
    assert.equal(repaired.recovery.evidence.includes(value), false);
  }

  const malformed = repairRunningResult(legacy, {
    runId: legacy.runId,
    currentHostName: "test-host",
    processState: { state: "unknown" },
    evidence: '{"apiKey":"quoted secret with spaces", trailing',
    redactionValues: [],
    at: "2026-10-14T12:00:00.000Z",
  });
  assert.equal(malformed.recovery.evidence.includes("quoted secret"), false);
});

const withTemporaryResults = (run) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "arbor-repair-results-"));
  const resultsRoot = join(temporaryRoot, ".test-results");
  const runId = "2026-10-14T11-44-22-397Z-24864";
  const runDirectory = join(resultsRoot, runId);
  mkdirSync(runDirectory, { recursive: true });
  const manifestPath = join(runDirectory, "result-manifest.json");
  writeFileSync(manifestPath, "old", "utf8");
  try {
    return run({
      temporaryRoot,
      resultsRoot,
      runId,
      runDirectory,
      manifestPath,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const linkType = process.platform === "win32" ? "junction" : "dir";

test("result repair rejects external symlink or reparse-point paths", () => {
  withTemporaryResults(
    ({ temporaryRoot, resultsRoot, runId, runDirectory }) => {
      const outside = join(temporaryRoot, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "result-manifest.json"), "outside", "utf8");
      const movedRunDirectory = `${runDirectory}-moved`;
      renameSync(runDirectory, movedRunDirectory);
      symlinkSync(outside, runDirectory, linkType);

      assert.throws(
        () => resolveSafeResultManifest(resultsRoot, runId),
        /symlink or reparse point/u,
      );
      assert.equal(
        readFileSync(join(outside, "result-manifest.json"), "utf8"),
        "outside",
      );
    },
  );
});

test("result repair rejects symlinked result files and result roots", () => {
  withTemporaryResults(
    ({ temporaryRoot, resultsRoot, runId, runDirectory, manifestPath }) => {
      const outside = join(temporaryRoot, "outside-manifest.json");
      writeFileSync(outside, "outside", "utf8");
      const movedManifest = `${manifestPath}-moved`;
      renameSync(manifestPath, movedManifest);
      symlinkSync(outside, manifestPath, "file");
      assert.throws(
        () => resolveSafeResultManifest(resultsRoot, runId),
        /symlink or reparse point/u,
      );
      rmSync(manifestPath);
      renameSync(movedManifest, manifestPath);

      const movedResultsRoot = `${resultsRoot}-moved`;
      renameSync(resultsRoot, movedResultsRoot);
      symlinkSync(movedResultsRoot, resultsRoot, linkType);
      assert.throws(
        () => resolveSafeResultManifest(resultsRoot, runId),
        /symlink or reparse point/u,
      );
      assert.equal(readFileSync(outside, "utf8"), "outside");
      assert.equal(
        readFileSync(join(runDirectory, "result-manifest.json"), "utf8"),
        "old",
      );
    },
  );
});

test("manifest repair atomically replaces a regular file in its run directory", () => {
  withTemporaryResults(({ resultsRoot, runId, manifestPath, runDirectory }) => {
    atomicReplaceResultManifest(resultsRoot, runId, "new contents");
    assert.equal(readFileSync(manifestPath, "utf8"), "new contents");
    assert.deepEqual(readdirSync(runDirectory), ["result-manifest.json"]);
    assert.ok(existsSync(resolveSafeResultManifest(resultsRoot, runId)));
  });
});

test("manifest repair revalidates paths immediately before atomic replace", () => {
  withTemporaryResults(
    ({ temporaryRoot, resultsRoot, runId, runDirectory }) => {
      const outside = join(temporaryRoot, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "result-manifest.json"), "outside", "utf8");
      const movedRunDirectory = `${runDirectory}-moved`;

      assert.throws(
        () =>
          atomicReplaceResultManifest(resultsRoot, runId, "should not escape", {
            beforeCommit: () => {
              renameSync(runDirectory, movedRunDirectory);
              symlinkSync(outside, runDirectory, linkType);
            },
          }),
        /symlink or reparse point/u,
      );
      assert.equal(
        readFileSync(join(outside, "result-manifest.json"), "utf8"),
        "outside",
      );
      assert.equal(
        readFileSync(join(movedRunDirectory, "result-manifest.json"), "utf8"),
        "old",
      );
    },
  );
});
