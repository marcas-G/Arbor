import { type ChildProcess, spawn } from "node:child_process";

export const childHasExited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

export const childExitDiagnostic = (child: ChildProcess) =>
  `pid=${String(child.pid)} exitCode=${String(child.exitCode)} signal=${String(child.signalCode)}`;

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  message: string,
): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectTimeout) => {
        timeout = setTimeout(
          () => rejectTimeout(new Error(message)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export interface StopChildLifecycleTestSeam {
  readonly platform?: NodeJS.Platform;
  readonly taskkillTimeoutMs?: number;
  readonly taskkillCleanupTimeoutMs?: number;
  readonly spawnTaskkill?: (pid: number, attempt: number) => ChildProcess;
  readonly queryDescendantPids?: (
    rootPid: number,
    timeoutMs: number,
  ) => Promise<ReadonlyArray<number>>;
  readonly cleanupDescendantPids?: (
    pids: ReadonlyArray<number>,
    timeoutMs: number,
  ) => Promise<void>;
  /** Test-only clock seam for deterministic process-tree stop race coverage. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;
const WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS = 1_000;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_MAX_DESCENDANT_PIDS = 128;
const unprovenWindowsTreeCleanup = new WeakMap<ChildProcess, string>();

const runWindowsCommandBounded = (
  executable: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | null; readonly stdout: string }> =>
  new Promise((resolveCommand, rejectCommand) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        ...(env === undefined ? {} : { env }),
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      rejectCommand(error);
      return;
    }
    let settled = false;
    let stdout = "";
    const finish = (
      result:
        | { readonly exitCode: number | null; readonly stdout: string }
        | { readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onStdout);
      if ("error" in result) rejectCommand(result.error);
      else resolveCommand(result);
    };
    const onStdout = (chunk: Buffer) => {
      if (stdout.length < 32_768) {
        stdout += chunk.toString("utf8").slice(0, 32_768 - stdout.length);
      }
    };
    const onError = (error: Error) => finish({ error });
    const onExit = (code: number | null) => finish({ exitCode: code, stdout });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      void waitForChildExit(child, WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS).then(
        () =>
          finish({
            error: new Error(`${executable} timed out after ${timeoutMs}ms`),
          }),
        (error: unknown) =>
          finish({
            error: new Error(
              `${executable} timed out after ${timeoutMs}ms and could not be reaped`,
              { cause: error },
            ),
          }),
      );
    }, timeoutMs);
    child.stdout?.on("data", onStdout);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.stdout === null) {
      finish({ error: new Error(`${executable} stdout was unavailable`) });
    }
  });

const windowsDescendantQueryScript = `
$ErrorActionPreference = 'Stop'
$rootPid = [int]$env:ARBOR_PROCESS_TREE_ROOT_PID
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
$known = @{}
$known[[string]$rootPid] = $true
do {
  $changed = $false
  foreach ($row in $rows) {
    $processId = [int]$row.ProcessId
    $parentId = [string][int]$row.ParentProcessId
    $processKey = [string]$processId
    if ($known.ContainsKey($parentId) -and -not $known.ContainsKey($processKey)) {
      $known[$processKey] = $true
      $changed = $true
    }
  }
} while ($changed)
$descendants = @($known.Keys | Where-Object { [int]$_ -ne $rootPid } | ForEach-Object { [int]$_ } | Sort-Object)
if ($descendants.Count -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject $descendants -Compress }
`;

const queryWindowsDescendantPids = async (
  rootPid: number,
  timeoutMs: number,
): Promise<ReadonlyArray<number>> => {
  const result = await runWindowsCommandBounded(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", windowsDescendantQueryScript],
    timeoutMs,
    {
      ...process.env,
      ARBOR_PROCESS_TREE_ROOT_PID: String(rootPid),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error("Windows process-table query exited unsuccessfully");
  }
  const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const pids = values.filter(
    (pid): pid is number =>
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
  );
  if (
    pids.length !== values.length ||
    pids.length > WINDOWS_MAX_DESCENDANT_PIDS
  ) {
    throw new Error("Windows process-table query returned unsafe PID data");
  }
  return pids;
};

const cleanupWindowsDescendantPids = async (
  pids: ReadonlyArray<number>,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (const pid of pids) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("descendant taskkill cleanup exceeded its time bound");
    }
    const result = await runWindowsCommandBounded(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      remainingMs,
    );
    if (result.exitCode === null) {
      throw new Error("descendant taskkill cleanup did not exit");
    }
  }
};

const waitForChildExit = (child: ChildProcess, timeoutMs: number) => {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise<void>((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      if (error === undefined) resolveExit();
      else rejectExit(error);
    };
    const onExit = () => finish();
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `daemon process did not exit within ${timeoutMs}ms; ${childExitDiagnostic(child)}`,
          ),
        ),
      timeoutMs,
    );
    child.once("exit", onExit);
    if (childHasExited(child)) finish();
  });
};

type TaskkillOutcome =
  | { readonly kind: "target-exit" }
  | {
      readonly kind: "taskkill-exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "taskkill-error"; readonly error: Error }
  | { readonly kind: "taskkill-timeout" };

const waitForTaskkillOrTarget = (
  killer: ChildProcess,
  target: ChildProcess,
  timeoutMs: number,
  timers: Pick<StopChildLifecycleTestSeam, "setTimeout" | "clearTimeout">,
): Promise<TaskkillOutcome> =>
  new Promise((resolveOutcome) => {
    let settled = false;
    const setTimer = timers.setTimeout ?? setTimeout;
    const clearTimer = timers.clearTimeout ?? clearTimeout;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (outcome: TaskkillOutcome) => {
      if (settled) return;
      settled = true;
      clearTimer(timeout);
      killer.removeListener("error", onError);
      killer.removeListener("exit", onKillerExit);
      target.removeListener("exit", onTargetExit);
      resolveOutcome(outcome);
    };
    const onError = (error: Error) => finish({ kind: "taskkill-error", error });
    const onKillerExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ kind: "taskkill-exit", code, signal });
    const onTargetExit = () => finish({ kind: "target-exit" });
    timeout = setTimer(() => finish({ kind: "taskkill-timeout" }), timeoutMs);
    killer.once("error", onError);
    killer.once("exit", onKillerExit);
    target.once("exit", onTargetExit);
    if (childHasExited(target)) onTargetExit();
    else if (childHasExited(killer)) {
      onKillerExit(killer.exitCode, killer.signalCode);
    }
  });

type KillerState = "spawn" | "exit" | "error" | "timeout";

const waitForKillerState = (
  killer: ChildProcess,
  timeoutMs: number,
): Promise<KillerState> =>
  new Promise((resolveState) => {
    let settled = false;
    const finish = (state: KillerState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killer.removeListener("spawn", onSpawn);
      killer.removeListener("exit", onExit);
      killer.removeListener("error", onError);
      resolveState(state);
    };
    const onSpawn = () => finish("spawn");
    const onExit = () => finish("exit");
    const onError = () => finish("error");
    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    killer.once("spawn", onSpawn);
    killer.once("exit", onExit);
    killer.once("error", onError);
    if (childHasExited(killer)) onExit();
    else if (killer.pid !== undefined) onSpawn();
  });

const waitForKillerTermination = (
  killer: ChildProcess,
  timeoutMs: number,
): Promise<"exit" | "error" | "timeout"> =>
  new Promise((resolveState) => {
    let settled = false;
    const finish = (state: "exit" | "error" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killer.removeListener("exit", onExit);
      killer.removeListener("error", onError);
      resolveState(state);
    };
    const onExit = () => finish("exit");
    const onError = () => finish("error");
    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    killer.once("exit", onExit);
    killer.once("error", onError);
    if (childHasExited(killer)) onExit();
  });

type TaskkillCompletion =
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "timeout" };

const waitForTaskkillCompletion = async (
  killer: ChildProcess,
  timeoutMs: number,
): Promise<TaskkillCompletion> => {
  if (childHasExited(killer)) {
    return {
      kind: "exit",
      code: killer.exitCode,
      signal: killer.signalCode,
    };
  }
  if (killer.pid === undefined) {
    const state = await waitForKillerState(killer, timeoutMs);
    if (state === "error") {
      return {
        kind: "error",
        error: new Error("taskkill failed before spawn"),
      };
    }
    if (state === "exit" || childHasExited(killer)) {
      return {
        kind: "exit",
        code: killer.exitCode,
        signal: killer.signalCode,
      };
    }
    if (state === "timeout") return { kind: "timeout" };
  }
  const state = await waitForKillerTermination(killer, timeoutMs);
  if (state === "error") {
    return {
      kind: "error",
      error: new Error("taskkill process failed while stopping the tree"),
    };
  }
  if (state === "timeout") return { kind: "timeout" };
  return {
    kind: "exit",
    code: killer.exitCode,
    signal: killer.signalCode,
  };
};

const reapTaskkillHelper = async (
  killer: ChildProcess,
  timeoutMs: number,
  phase: string,
): Promise<void> => {
  if (!childHasExited(killer) && killer.pid === undefined) {
    const state = await waitForKillerState(killer, timeoutMs);
    if (state === "error" || state === "exit") {
      if (killer.pid === undefined || childHasExited(killer)) return;
    } else if (state === "timeout") {
      killer.kill();
      if (killer.pid === undefined && !childHasExited(killer)) {
        throw new Error(
          `taskkill helper did not spawn or settle within ${timeoutMs}ms; phase=${phase}; ${childExitDiagnostic(killer)}`,
        );
      }
    }
  }
  if (childHasExited(killer)) return;
  killer.kill();
  if (childHasExited(killer)) return;
  const state = await waitForKillerTermination(killer, timeoutMs);
  if (state === "exit" || (state === "error" && childHasExited(killer))) return;
  throw new Error(
    `taskkill helper could not be reaped within ${timeoutMs}ms; phase=${phase}; ${childExitDiagnostic(killer)}`,
  );
};

interface TaskkillAttemptResult {
  readonly helper?: ChildProcess;
  readonly targetExitedFirst?: boolean;
  readonly succeeded: boolean;
  readonly phase: string;
  readonly detail?: string;
}

interface TargetFirstTreeCheck {
  readonly succeeded: boolean;
  readonly phase: string;
  readonly detail?: string;
}

const targetFirstTreeCheck = async (
  rootPid: number,
  seam: StopChildLifecycleTestSeam,
  cleanupTimeoutMs: number,
): Promise<TargetFirstTreeCheck> => {
  const queryDescendants =
    seam.queryDescendantPids ?? queryWindowsDescendantPids;
  let descendants: ReadonlyArray<number>;
  try {
    descendants = await queryDescendants(
      rootPid,
      seam.taskkillTimeoutMs ?? WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      succeeded: false,
      phase: "target-first-descendant-query-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    descendants.some(
      (pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid === rootPid,
    ) ||
    descendants.length > WINDOWS_MAX_DESCENDANT_PIDS
  ) {
    return {
      succeeded: false,
      phase: "target-first-descendant-query-unsafe-pids",
      detail: `descendantPids=${JSON.stringify(descendants.slice(0, 32))}`,
    };
  }
  if (descendants.length === 0) {
    return {
      succeeded: true,
      phase: "target-first-tree-absence-confirmed",
    };
  }

  let cleanupDetail = "descendant cleanup completed";
  try {
    await (seam.cleanupDescendantPids ?? cleanupWindowsDescendantPids)(
      descendants,
      cleanupTimeoutMs,
    );
  } catch (error) {
    cleanupDetail = error instanceof Error ? error.message : String(error);
  }

  let remaining: ReadonlyArray<number>;
  try {
    remaining = await queryDescendants(
      rootPid,
      seam.taskkillTimeoutMs ?? WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      succeeded: false,
      phase: "target-first-descendant-recheck-failed",
      detail: `${cleanupDetail}; ${error instanceof Error ? error.message : String(error)}; descendantPids=${JSON.stringify(descendants.slice(0, 32))}`,
    };
  }
  if (remaining.length === 0) {
    return {
      succeeded: true,
      phase: "target-first-descendant-cleanup-confirmed",
    };
  }
  return {
    succeeded: false,
    phase: "target-first-descendants-remain",
    detail: `${cleanupDetail}; descendantPids=${JSON.stringify(remaining.slice(0, 32))}`,
  };
};

const runTaskkillAttempt = async (
  child: ChildProcess,
  attempt: number,
  taskkillTimeoutMs: number,
  targetExitGraceMs: number,
  seam: StopChildLifecycleTestSeam,
): Promise<TaskkillAttemptResult> => {
  if (child.pid === undefined) {
    return {
      succeeded: false,
      phase: `taskkill-${attempt}-spawn`,
      detail: "target PID unavailable",
    };
  }
  let killer: ChildProcess;
  try {
    killer = (
      seam.spawnTaskkill ??
      ((pid) =>
        spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }))
    )(child.pid, attempt);
  } catch (error) {
    return {
      succeeded: false,
      phase: `taskkill-${attempt}-spawn`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const outcome = await waitForTaskkillOrTarget(
    killer,
    child,
    taskkillTimeoutMs,
    seam,
  );
  if (outcome.kind === "target-exit" || childHasExited(child)) {
    const completion = await waitForTaskkillCompletion(
      killer,
      taskkillTimeoutMs,
    );
    if (completion.kind === "exit" && completion.code === 0) {
      return {
        helper: killer,
        targetExitedFirst: true,
        succeeded: true,
        phase: `target-exit-before-taskkill-${attempt}-tree-kill-confirmed`,
      };
    }
    let helperCleanupProven =
      completion.kind === "exit" ||
      (completion.kind === "error" && killer.pid === undefined);
    let cleanupDetail = "helper already settled";
    if (
      completion.kind === "timeout" ||
      (completion.kind === "error" && killer.pid !== undefined)
    ) {
      cleanupDetail = "helper cleanup pending";
      try {
        await reapTaskkillHelper(
          killer,
          seam.taskkillCleanupTimeoutMs ?? WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS,
          `taskkill-${attempt}-target-first-helper-cleanup`,
        );
        helperCleanupProven = true;
        cleanupDetail = "helper reaped";
      } catch (error) {
        helperCleanupProven = false;
        cleanupDetail = error instanceof Error ? error.message : String(error);
      }
    }
    if (!helperCleanupProven) {
      return {
        helper: killer,
        targetExitedFirst: true,
        succeeded: false,
        phase: `taskkill-${attempt}-target-first-helper-cleanup-unproven`,
        detail: `${cleanupDetail}; taskkill outcome=${completion.kind}`,
      };
    }
    const treeCheck = await targetFirstTreeCheck(
      child.pid,
      seam,
      taskkillTimeoutMs,
    );
    const taskkillDetail =
      completion.kind === "exit"
        ? `taskkill exit code=${String(completion.code)} signal=${String(completion.signal)}`
        : completion.kind === "error"
          ? completion.error.message
          : "taskkill timed out";
    return {
      helper: killer,
      targetExitedFirst: true,
      succeeded: treeCheck.succeeded,
      phase: treeCheck.phase,
      detail: `${taskkillDetail}; ${cleanupDetail}${treeCheck.detail === undefined ? "" : `; ${treeCheck.detail}`}`,
    };
  }
  if (outcome.kind === "taskkill-timeout") {
    return {
      helper: killer,
      succeeded: false,
      phase: `taskkill-${attempt}-timeout`,
      detail: `taskkill exceeded ${taskkillTimeoutMs}ms`,
    };
  }
  if (outcome.kind === "taskkill-error") {
    return {
      ...(killer.pid === undefined ? {} : { helper: killer }),
      succeeded: false,
      phase: `taskkill-${attempt}-error`,
      detail: outcome.error.message,
    };
  }
  if (outcome.code !== 0) {
    return {
      helper: killer,
      succeeded: false,
      phase: `taskkill-${attempt}-exit-${String(outcome.code)}`,
      detail: `signal=${String(outcome.signal)}`,
    };
  }
  try {
    await waitForChildExit(child, targetExitGraceMs);
    return {
      helper: killer,
      succeeded: true,
      phase: `taskkill-${attempt}-target-exit-confirmed`,
    };
  } catch (error) {
    return {
      helper: killer,
      succeeded: false,
      phase: `taskkill-${attempt}-target-exit-timeout`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

const killWindowsProcessTree = async (
  child: ChildProcess,
  targetExitGraceMs: number,
  seam: StopChildLifecycleTestSeam,
) => {
  if (child.pid === undefined) {
    throw new Error(
      `cannot stop child without a PID; ${childExitDiagnostic(child)}`,
    );
  }
  const attempts: string[] = [];
  const taskkillTimeoutMs =
    seam.taskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS;
  const cleanupTimeoutMs =
    seam.taskkillCleanupTimeoutMs ?? WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS;

  for (const attemptNumber of [1, 2]) {
    const result = await runTaskkillAttempt(
      child,
      attemptNumber,
      taskkillTimeoutMs,
      targetExitGraceMs,
      seam,
    );
    attempts.push(
      `${result.phase}${result.detail === undefined ? "" : ` (${result.detail})`}`,
    );
    if (result.targetExitedFirst) {
      if (result.succeeded) return;
      break;
    }
    if (result.succeeded) return;
    let helperCleanupProven = true;
    if (result.helper !== undefined && !childHasExited(result.helper)) {
      try {
        await reapTaskkillHelper(
          result.helper,
          cleanupTimeoutMs,
          `taskkill-${attemptNumber}-helper-cleanup`,
        );
        attempts.push(`taskkill-${attemptNumber}-helper-reaped`);
      } catch (error) {
        helperCleanupProven = false;
        attempts.push(
          `taskkill-${attemptNumber}-helper-cleanup-unproven (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (childHasExited(child)) {
      attempts.push(
        `target-exited-after-failed-taskkill-${attemptNumber}; tree-cleanup-unproven`,
      );
      break;
    }
    if (!helperCleanupProven) break;
  }

  if (!childHasExited(child)) {
    attempts.push("fallback-direct-child-SIGKILL");
    try {
      child.kill("SIGKILL");
      await waitForChildExit(child, targetExitGraceMs);
      attempts.push("fallback-direct-child-exit-confirmed");
    } catch (error) {
      attempts.push(
        `fallback-direct-child-exit-unconfirmed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  throw new Error(
    `Windows process-tree cleanup unproven; attempt phases=${attempts.join(" -> ")}; ${childExitDiagnostic(child)}`,
  );
};

export const stopChildBounded = async (
  child: ChildProcess | undefined,
  timeoutMs = 5_000,
  seam: StopChildLifecycleTestSeam = {},
): Promise<void> => {
  if (child === undefined) return;
  const platform = seam.platform ?? process.platform;
  if (platform === "win32") {
    const priorUnprovenOutcome = unprovenWindowsTreeCleanup.get(child);
    if (priorUnprovenOutcome !== undefined) {
      throw new Error(priorUnprovenOutcome);
    }
    if (childHasExited(child)) return;
    try {
      await killWindowsProcessTree(child, timeoutMs, seam);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Windows process-tree cleanup unproven")
      ) {
        unprovenWindowsTreeCleanup.set(child, error.message);
      }
      throw error;
    }
  } else {
    if (childHasExited(child)) return;
    child.kill("SIGKILL");
    await waitForChildExit(child, timeoutMs);
  }
};

export const waitForDaemonListening = (
  child: ChildProcess,
  requestedPort: number,
  options: {
    readonly timeoutMs?: number;
    readonly onStdoutLine?: (line: string) => void;
  } = {},
): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    let settled = false;
    let startedNonce: string | undefined;
    let sawStarted = false;
    let sawListening = false;
    let stdoutBuffer = "";
    let stdoutLineCount = 0;
    const lifecycleMarkers: Array<{
      readonly tag: string;
      readonly pid?: unknown;
      readonly nonce?: unknown;
      readonly port?: unknown;
    }> = [];
    const handshakeDiagnostic = () =>
      JSON.stringify({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        startedNonce: startedNonce ?? null,
        stdoutLineCount,
        lifecycleMarkers,
      });
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finish = (
      result: { readonly port: number } | { readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      if ("error" in result) {
        child.stdout?.removeListener("data", readStdout);
        rejectPort(result.error);
      } else {
        // Keep forwarding stdout after the nonce-bound port is accepted.
        // Runtime qualification probes arrive after the listening marker.
        child.stdout?.once("close", () => {
          child.stdout?.removeListener("data", readStdout);
        });
        resolvePort(result.port);
      }
    };
    const timeout = setTimeout(
      () =>
        finish({
          error: new Error(
            `functional daemon startup handshake timed out; observed=${handshakeDiagnostic()}`,
          ),
        }),
      timeoutMs,
    );
    const readLine = (line: string) => {
      if (line.length === 0) return;
      stdoutLineCount += 1;
      options.onStdoutLine?.(line);
      let event: {
        readonly tag?: unknown;
        readonly nonce?: unknown;
        readonly pid?: unknown;
        readonly port?: unknown;
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      if (
        event.tag === "FUNCTIONAL_DAEMON_STARTED" ||
        event.tag === "FUNCTIONAL_DAEMON_LISTENING"
      ) {
        lifecycleMarkers.push({
          tag: event.tag,
          pid: event.pid,
          nonce: event.nonce,
          port: event.port,
        });
        if (lifecycleMarkers.length > 8) lifecycleMarkers.shift();
      }
      if (event.tag === "FUNCTIONAL_DAEMON_STARTED") {
        if (sawStarted) {
          finish({
            error: new Error(
              `duplicate functional daemon start marker; observed=${handshakeDiagnostic()}`,
            ),
          });
          return;
        }
        sawStarted = true;
        if (
          typeof event.nonce !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            event.nonce,
          ) ||
          event.pid !== child.pid ||
          childHasExited(child)
        ) {
          finish({
            error: new Error(
              `invalid functional daemon start identity; observed=${handshakeDiagnostic()}`,
            ),
          });
          return;
        }
        startedNonce = event.nonce;
        return;
      }
      if (event.tag !== "FUNCTIONAL_DAEMON_LISTENING") return;
      if (sawListening) {
        finish({
          error: new Error(
            `duplicate functional daemon listening marker; observed=${handshakeDiagnostic()}`,
          ),
        });
        return;
      }
      sawListening = true;
      if (
        startedNonce === undefined ||
        event.nonce !== startedNonce ||
        event.pid !== child.pid ||
        typeof event.port !== "number" ||
        !Number.isInteger(event.port) ||
        event.port < 1 ||
        event.port > 65_535 ||
        childHasExited(child)
      ) {
        finish({
          error: new Error(
            `functional daemon listening identity mismatch; observed=${handshakeDiagnostic()}`,
          ),
        });
        return;
      }
      if (requestedPort !== 0 && event.port !== requestedPort) {
        finish({
          error: new Error(
            `functional daemon bound unexpected port: requested=${requestedPort} reported=${event.port}; observed=${handshakeDiagnostic()}`,
          ),
        });
        return;
      }
      // Flush the current stdout chunk first so duplicate/conflicting markers
      // emitted with the listening report fail closed before resolving.
      setImmediate(() => finish({ port: event.port as number }));
    };
    const readStdout = (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        readLine(stdoutBuffer.slice(0, newline).trim());
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({
        error: new Error(
          `functional daemon exited before listening report: code=${String(code)} signal=${String(signal)}; observed=${handshakeDiagnostic()}`,
        ),
      });
    child.once("exit", onExit);
    if (child.stdout === null) {
      finish({
        error: new Error("functional daemon stdout is required for handshake"),
      });
      return;
    }
    child.stdout.on("data", readStdout);
  });

export const closeServerBounded = async (
  server: import("node:http").Server,
  timeoutMs = 5_000,
): Promise<void> => {
  if (!server.listening) return;
  try {
    await withTimeout(
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) rejectClose(error);
          else resolveClose();
        });
      }),
      timeoutMs,
      `HTTP server did not close within ${timeoutMs}ms`,
    );
  } catch (error) {
    server.closeAllConnections();
    throw error;
  }
};

export interface SignalSafeCleanup {
  readonly stop: () => Promise<void>;
  readonly dispose: () => void;
}

export const createSignalSafeCleanup = (
  cleanup: () => Promise<void>,
  options: {
    readonly onInterrupted: (signal: "SIGINT" | "SIGTERM") => void;
    readonly onFailure: (signal: "SIGINT" | "SIGTERM", error: unknown) => void;
  },
): SignalSafeCleanup => {
  let cleanupPromise: Promise<void> | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
  const stop = () => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    dispose();
    cleanupPromise = Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    options.onInterrupted(signal);
    void stop().catch((error: unknown) => options.onFailure(signal, error));
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return { stop, dispose };
};
