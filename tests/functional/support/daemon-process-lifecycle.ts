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
  readonly spawnTaskkill?: (pid: number) => ChildProcess;
  /** Test-only clock seam for deterministic process-tree stop race coverage. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;
const WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS = 1_000;

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

const stopKillerAfterTargetExit = async (
  killer: ChildProcess,
  timeoutMs: number,
) => {
  if (childHasExited(killer)) return;
  const killRequested = killer.kill();
  if (childHasExited(killer) || (killer.pid === undefined && !killRequested))
    return;
  try {
    await waitForChildExit(killer, timeoutMs);
  } catch (error) {
    throw new Error(
      `taskkill helper cleanup timed out; phase=taskkill-cleanup; ${childExitDiagnostic(killer)}`,
      { cause: error },
    );
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
  let killer: ChildProcess;
  try {
    killer = (
      seam.spawnTaskkill ??
      ((pid) =>
        spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }))
    )(child.pid);
  } catch (error) {
    throw new Error(
      `taskkill spawn failed; phase=taskkill-start; ${childExitDiagnostic(child)}`,
      { cause: error },
    );
  }

  const cleanupTimeoutMs =
    seam.taskkillCleanupTimeoutMs ?? WINDOWS_TASKKILL_CLEANUP_TIMEOUT_MS;
  const taskkillTimeoutMs =
    seam.taskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS;
  try {
    const outcome = await waitForTaskkillOrTarget(
      killer,
      child,
      taskkillTimeoutMs,
      seam,
    );
    if (outcome.kind === "target-exit") {
      await stopKillerAfterTargetExit(killer, cleanupTimeoutMs);
      return;
    }
    if (outcome.kind === "taskkill-timeout") {
      throw new Error(
        `taskkill process-tree command timed out after ${taskkillTimeoutMs}ms; phase=taskkill; ${childExitDiagnostic(child)}`,
      );
    }
    if (outcome.kind === "taskkill-error") {
      throw new Error(
        `taskkill process-tree command failed; phase=taskkill; ${childExitDiagnostic(child)}; error=${outcome.error.message}`,
        { cause: outcome.error },
      );
    }
    if (outcome.code !== 0 && !childHasExited(child)) {
      throw new Error(
        `taskkill failed with code=${String(outcome.code)} signal=${String(outcome.signal)}; phase=taskkill; ${childExitDiagnostic(child)}`,
      );
    }
    try {
      await waitForChildExit(child, targetExitGraceMs);
    } catch (error) {
      throw new Error(
        `daemon process did not exit within ${targetExitGraceMs}ms after taskkill; phase=target-exit-after-taskkill; ${childExitDiagnostic(child)}`,
        { cause: error },
      );
    }
  } catch (error) {
    const taskkillTimedOut =
      error instanceof Error && error.message.includes("phase=taskkill;");
    if (
      !childHasExited(killer) &&
      (killer.pid !== undefined || taskkillTimedOut)
    ) {
      await stopKillerAfterTargetExit(killer, cleanupTimeoutMs).catch(
        (cleanupError: unknown) => {
          throw new AggregateError(
            [error, cleanupError],
            "taskkill failure and helper cleanup both failed",
            { cause: error },
          );
        },
      );
    }
    throw error;
  }
};

export const stopChildBounded = async (
  child: ChildProcess | undefined,
  timeoutMs = 5_000,
  seam: StopChildLifecycleTestSeam = {},
): Promise<void> => {
  if (child === undefined || childHasExited(child)) return;
  if ((seam.platform ?? process.platform) === "win32") {
    await killWindowsProcessTree(child, timeoutMs, seam);
  } else {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, timeoutMs);
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
