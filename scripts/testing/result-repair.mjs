import { hostname, userInfo } from "node:os";
import {
  redactStructuredValueForOutput,
  redactTextForOutput,
} from "./vitest-progress-reporter.mjs";

const normalizeHost = (value) => value.trim().toLocaleLowerCase("en-US");

function runnerIdentityState(result) {
  if (!Object.hasOwn(result, "runner")) return "legacy";
  // Presence of any identity field opts into strict validation. Only a wholly
  // absent runner object is eligible for evidence-backed legacy repair.
  const runner = result.runner;
  const processStartedAtEstimate = runner?.processStartedAtEstimate;
  const validEstimatedStart =
    typeof processStartedAtEstimate === "string" &&
    Number.isFinite(Date.parse(processStartedAtEstimate)) &&
    new Date(Date.parse(processStartedAtEstimate)).toISOString() ===
      processStartedAtEstimate;
  const keys =
    runner !== null && typeof runner === "object" && !Array.isArray(runner)
      ? Object.keys(runner).sort()
      : [];
  if (
    keys.length !== 3 ||
    keys[0] !== "hostName" ||
    keys[1] !== "pid" ||
    keys[2] !== "processStartedAtEstimate" ||
    typeof runner.hostName !== "string" ||
    runner.hostName.trim().length === 0 ||
    !Number.isSafeInteger(runner.pid) ||
    runner.pid <= 0 ||
    !validEstimatedStart
  ) {
    throw new Error("runner identity is partial or malformed");
  }
  return "complete";
}

function redactEvidence(evidence, redactionValues) {
  try {
    const parsed = JSON.parse(evidence);
    return JSON.stringify(
      redactStructuredValueForOutput(parsed, redactionValues),
    );
  } catch {
    return redactTextForOutput(evidence, redactionValues);
  }
}

export function inspectRunnerProcess(runner, currentHostName, signalZero) {
  if (
    runner === null ||
    typeof runner !== "object" ||
    !Number.isSafeInteger(runner.pid) ||
    runner.pid <= 0 ||
    typeof runner.hostName !== "string" ||
    runner.hostName.length === 0
  ) {
    return { state: "unknown" };
  }
  if (normalizeHost(runner.hostName) !== normalizeHost(currentHostName)) {
    return { state: "remote", hostName: runner.hostName };
  }
  try {
    signalZero(runner.pid);
    return { state: "alive", pid: runner.pid };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { state: "absent", pid: runner.pid };
    }
    if (error?.code === "EPERM") {
      return { state: "alive", pid: runner.pid };
    }
    throw error;
  }
}

export function repairRunningResult(
  result,
  {
    runId,
    currentHostName,
    processState,
    evidence,
    redactionValues = process.env,
    at = new Date().toISOString(),
    operator = userInfo().username,
  },
) {
  if (result?.runId !== runId) {
    throw new Error("runId does not match the selected result manifest");
  }
  if (result.status !== "running") {
    throw new Error(`cannot repair a result with status ${result.status}`);
  }
  if (typeof evidence !== "string" || evidence.trim().length < 12) {
    throw new Error("manual evidence must contain at least 12 characters");
  }

  const identityState = runnerIdentityState(result);
  if (identityState === "complete" && processState.state !== "absent") {
    // The recorded start time is approximate and audit-only. Any live PID is
    // treated as active, even when its current process may have reused that PID.
    throw new Error(
      `runner process is ${processState.state}; only an absent same-host PID can be repaired automatically`,
    );
  }
  if (identityState === "legacy" && processState.state !== "unknown") {
    throw new Error("legacy results require manual process evidence");
  }

  const finishedAt = new Date(at);
  const startedAt = new Date(result.startedAt);
  const durationMs =
    Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())
      ? result.durationMs
      : Math.max(0, finishedAt.getTime() - startedAt.getTime());
  const recovery = {
    kind: "explicit-stale-result-repair",
    verification:
      identityState === "complete"
        ? "same-host-pid-absent"
        : "manual-legacy-evidence",
    hostName: currentHostName,
    operator,
    at: finishedAt.toISOString(),
    evidence: redactEvidence(evidence.trim(), redactionValues),
  };

  return {
    ...result,
    status: "interrupted",
    completeCoverage: false,
    finishedAt: finishedAt.toISOString(),
    durationMs,
    exitCode: null,
    signal: null,
    error: "Result marked interrupted by explicit stale-result repair.",
    recovery,
    current:
      result.current === null ? null : { ...result.current, interrupted: true },
  };
}

export const runnerHostName = hostname;
