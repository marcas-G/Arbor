import { hostname, userInfo } from "node:os";

const normalizeHost = (value) => value.trim().toLocaleLowerCase("en-US");

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

  const hasRunnerIdentity =
    result.runner !== null &&
    typeof result.runner === "object" &&
    Number.isSafeInteger(result.runner.pid) &&
    typeof result.runner.hostName === "string";
  if (hasRunnerIdentity && processState.state !== "absent") {
    throw new Error(
      `runner process is ${processState.state}; only an absent same-host PID can be repaired automatically`,
    );
  }
  if (!hasRunnerIdentity && processState.state !== "unknown") {
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
    verification: hasRunnerIdentity
      ? "same-host-pid-absent"
      : "manual-legacy-evidence",
    hostName: currentHostName,
    operator,
    at: finishedAt.toISOString(),
    evidence: evidence.trim(),
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
