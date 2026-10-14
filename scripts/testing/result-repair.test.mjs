import assert from "node:assert/strict";
import test from "node:test";
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
      processStartedAtEstimate: "2026-10-14T11:44:22.300Z",
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
    runner: { pid: 24864, hostName: "test-host" },
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
