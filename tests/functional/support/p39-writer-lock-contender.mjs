import { Effect } from "effect";

const { P39WriterLockClient, p39WriterLockLayer } = await import(
  "../../../adapters/persistence-sqlite/dist/index.js"
);

const [lockFilename, mode, timeoutRaw, cancelAfterRaw] = process.argv.slice(2);
if (
  lockFilename === undefined ||
  (mode !== "shared" && mode !== "exclusive") ||
  timeoutRaw === undefined
) {
  throw new Error(
    "usage: p39-writer-lock-contender.mjs <lock-db> <shared|exclusive> <timeout-ms>",
  );
}

let timerFired = false;
let timer;
let cancellationTimer;
let acquireStarted;
const cancelAfterMs =
  cancelAfterRaw === undefined ? undefined : Number(cancelAfterRaw);
const abortController =
  cancelAfterMs === undefined ? undefined : new AbortController();

process.stdout.write("BEFORE_LAYER\n");
const acquireMode =
  mode === "shared" ? "RuntimeShared" : "MaintenanceExclusive";
const program = Effect.scoped(
  Effect.gen(function* () {
    process.stdout.write("LAYER_READY\n");
    const lockClient = yield* P39WriterLockClient;
    process.stdin.setEncoding("utf8");
    yield* Effect.promise(
      () => new Promise((resolve) => process.stdin.once("data", resolve)),
    );
    acquireStarted = performance.now();
    timer = setTimeout(() => {
      timerFired = true;
      process.stdout.write("TIMER_TICK\n");
    }, 50);
    if (abortController !== undefined && cancelAfterMs !== undefined) {
      cancellationTimer = setTimeout(
        () => abortController.abort(),
        cancelAfterMs,
      );
    }
    const result = yield* Effect.result(lockClient.acquire(acquireMode));
    if (result._tag === "Success") {
      const released = yield* Effect.exit(lockClient.release(result.success));
      process.stdout.write(
        `${JSON.stringify({
          _tag: "Acquired",
          elapsedMs: performance.now() - acquireStarted,
          released: released._tag === "Success",
          timerFired,
        })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        _tag: "AcquireFailed",
        code: result.failure.code,
        errorTag: result.failure._tag,
        errorMessage: result.failure.message,
        causeTag:
          typeof result.failure.cause === "object" &&
          result.failure.cause !== null &&
          "_tag" in result.failure.cause
            ? result.failure.cause._tag
            : undefined,
        causeReasonTag:
          typeof result.failure.cause === "object" &&
          result.failure.cause !== null &&
          "reason" in result.failure.cause &&
          typeof result.failure.cause.reason === "object" &&
          result.failure.cause.reason !== null &&
          "_tag" in result.failure.cause.reason
            ? result.failure.cause.reason._tag
            : undefined,
        causeCode:
          typeof result.failure.cause === "object" &&
          result.failure.cause !== null &&
          "reason" in result.failure.cause &&
          typeof result.failure.cause.reason === "object" &&
          result.failure.cause.reason !== null &&
          "cause" in result.failure.cause.reason &&
          typeof result.failure.cause.reason.cause === "object" &&
          result.failure.cause.reason.cause !== null &&
          "code" in result.failure.cause.reason.cause
            ? result.failure.cause.reason.cause.code
            : undefined,
        elapsedMs: performance.now() - acquireStarted,
        timerFired,
      })}\n`,
    );
  }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, Number(timeoutRaw)))),
);

try {
  await Effect.runPromise(
    program,
    abortController === undefined
      ? undefined
      : { signal: abortController.signal },
  );
} catch (cause) {
  if (abortController?.signal.aborted === true) {
    process.stdout.write(
      `${JSON.stringify({
        _tag: "Cancelled",
        elapsedMs:
          acquireStarted === undefined
            ? undefined
            : performance.now() - acquireStarted,
        timerFired,
      })}\n`,
    );
    process.exitCode = 0;
  } else {
    const tagged =
      typeof cause === "object" && cause !== null && "code" in cause
        ? {
            _tag: "_tag" in cause ? cause._tag : undefined,
            code: cause.code,
            message: "message" in cause ? cause.message : undefined,
          }
        : typeof cause === "object" && cause !== null
          ? {
              _tag: "_tag" in cause ? cause._tag : undefined,
              message: "message" in cause ? cause.message : String(cause),
            }
          : { message: cause instanceof Error ? cause.message : String(cause) };
    process.stdout.write(
      `${JSON.stringify({
        _tag: "LayerFailed",
        ...tagged,
        elapsedMs:
          acquireStarted === undefined
            ? undefined
            : performance.now() - acquireStarted,
        timerFired,
      })}\n`,
    );
  }
} finally {
  if (timer !== undefined) clearTimeout(timer);
  if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
}
