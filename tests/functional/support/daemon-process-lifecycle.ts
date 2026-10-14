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

const waitForChildExit = (child: ChildProcess, timeoutMs: number) => {
  if (childHasExited(child)) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    }),
    timeoutMs,
    `daemon process did not exit within ${timeoutMs}ms; ${childExitDiagnostic(child)}`,
  );
};

const killWindowsProcessTree = async (
  child: ChildProcess,
  timeoutMs: number,
) => {
  if (child.pid === undefined) {
    throw new Error(
      `cannot stop child without a PID; ${childExitDiagnostic(child)}`,
    );
  }
  const killer = spawn(
    "taskkill.exe",
    ["/PID", String(child.pid), "/T", "/F"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let killerExited = false;
  const killerExit = new Promise<void>((resolveExit, rejectExit) => {
    killer.once("error", (error) => {
      killerExited = true;
      rejectExit(error);
    });
    killer.once("exit", (code, signal) => {
      killerExited = true;
      if (code === 0 || childHasExited(child)) resolveExit();
      else {
        rejectExit(
          new Error(
            `taskkill failed with code=${String(code)} signal=${String(signal)}; ${childExitDiagnostic(child)}`,
          ),
        );
      }
    });
  });
  const targetExit = waitForChildExit(child, timeoutMs);
  try {
    const outcome = await Promise.race([
      killerExit.then(
        () => "killer" as const,
        (error: unknown) => {
          if (childHasExited(child)) return "target" as const;
          throw error;
        },
      ),
      targetExit.then(() => "target" as const),
    ]);
    if (outcome === "target" && !killerExited) {
      await Promise.race([
        killerExit.catch(() => undefined),
        new Promise<void>((resolveGrace) => setTimeout(resolveGrace, 1_000)),
      ]);
      if (!killerExited) killer.kill();
    }
    await targetExit;
  } finally {
    if (!killerExited) killer.kill();
  }
};

export const stopChildBounded = async (
  child: ChildProcess | undefined,
  timeoutMs = 5_000,
): Promise<void> => {
  if (child === undefined || childHasExited(child)) return;
  if (process.platform === "win32") {
    await killWindowsProcessTree(child, timeoutMs);
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
      child.stdout?.removeListener("data", readStdout);
      if ("error" in result) rejectPort(result.error);
      else resolvePort(result.port);
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
