export interface CleanupTreeResult {
  readonly confirmed: boolean;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly lastTaskkillExit: number | null;
  readonly lastTaskkillError: string | null;
  readonly helperStopped: boolean;
  readonly directExited: boolean;
  readonly rootAlive: boolean;
}

export interface TaskkillHelperControl {
  readonly exited: Promise<{
    readonly exitCode: number | null;
    readonly error?: string;
  }>;
  readonly terminate: () => boolean;
}

export const cleanupProcessTreeUntilDeadline = async (options: {
  readonly totalDeadlineMs: number;
  readonly retryDelayMs: number;
  readonly now: () => number;
  readonly killTree: (remainingMs: number) => Promise<{
    readonly exitCode: number | null;
    readonly helperStopped: boolean;
    readonly error?: string;
  }>;
  readonly waitForDirectExit: (remainingMs: number) => Promise<boolean>;
  readonly isRootAlive: () => boolean;
  readonly sleep: (durationMs: number) => Promise<void>;
}): Promise<CleanupTreeResult> => {
  const startedAt = options.now();
  const deadline = startedAt + options.totalDeadlineMs;
  let attempts = 0;
  let lastTaskkillExit: number | null = null;
  let lastTaskkillError: string | null = null;
  let helperStopped = true;
  let directExited = false;
  let rootAlive = true;
  while (options.now() < deadline) {
    attempts += 1;
    const remainingForKill = Math.max(0, deadline - options.now());
    const kill = await options.killTree(remainingForKill);
    lastTaskkillExit = kill.exitCode;
    lastTaskkillError = kill.error ?? null;
    helperStopped = kill.helperStopped;
    if (!helperStopped) {
      const remainingForClose = Math.max(0, deadline - options.now());
      if (remainingForClose > 0)
        directExited = await options.waitForDirectExit(remainingForClose);
      rootAlive = options.isRootAlive();
      break;
    }
    const remainingForClose = Math.max(0, deadline - options.now());
    if (remainingForClose > 0)
      directExited = await options.waitForDirectExit(remainingForClose);
    rootAlive = options.isRootAlive();
    if (lastTaskkillExit === 0 && directExited && !rootAlive)
      return {
        confirmed: true,
        attempts,
        elapsedMs: options.now() - startedAt,
        lastTaskkillExit,
        lastTaskkillError,
        helperStopped,
        directExited,
        rootAlive,
      };
    const remainingForRetry = Math.max(0, deadline - options.now());
    if (remainingForRetry > 0)
      await options.sleep(Math.min(options.retryDelayMs, remainingForRetry));
  }
  return {
    confirmed: false,
    attempts,
    elapsedMs: Math.min(options.now() - startedAt, options.totalDeadlineMs),
    lastTaskkillExit,
    lastTaskkillError,
    helperStopped,
    directExited,
    rootAlive,
  };
};

export const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
): Promise<
  { readonly timedOut: true } | { readonly timedOut: false; readonly value: A }
> =>
  new Promise((resolveWithTimeout) => {
    const timeout = setTimeout(
      () => resolveWithTimeout({ timedOut: true }),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveWithTimeout({ timedOut: false, value });
      },
      () => {
        clearTimeout(timeout);
        resolveWithTimeout({ timedOut: true });
      },
    );
  });

export const runTaskkillHelperWithTimeout = async (
  helper: TaskkillHelperControl,
  commandDeadlineMs: number,
  terminateDeadlineMs: number,
): Promise<{
  readonly exitCode: number | null;
  readonly helperStopped: boolean;
  readonly error?: string;
}> => {
  const command = await withTimeout(helper.exited, commandDeadlineMs);
  if (!command.timedOut) return { ...command.value, helperStopped: true };
  let terminateRequested = false;
  let terminateError: string | undefined;
  try {
    terminateRequested = helper.terminate();
  } catch (cause) {
    terminateError = String(cause);
  }
  const terminated = await withTimeout(helper.exited, terminateDeadlineMs);
  if (!terminated.timedOut)
    return {
      exitCode: terminated.value.exitCode,
      helperStopped: true,
      error: `taskkill timed out; terminateRequested=${terminateRequested}`,
    };
  return {
    exitCode: null,
    helperStopped: false,
    error:
      `taskkill timeout; terminateRequested=${terminateRequested}` +
      (terminateError === undefined
        ? ""
        : `; terminateError=${terminateError}`),
  };
};
