import { Effect } from "effect";

const { P39WriterLockClient, p39WriterLockLayer, releaseP39WriterPermit } =
  await import("../../../adapters/persistence-sqlite/dist/index.js");
const [lockFilename, modeRaw] = process.argv.slice(2);
if (
  lockFilename === undefined ||
  (modeRaw !== "shared" && modeRaw !== "exclusive")
) {
  throw new Error(
    "usage: p39-lock-same-layer-contender.mjs <lock-file> <shared|exclusive>",
  );
}
const mode = modeRaw === "shared" ? "RuntimeShared" : "MaintenanceExclusive";

let timer;
const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* P39WriterLockClient;
    process.stdout.write("LAYER_READY\n");
    process.stdin.setEncoding("utf8");
    const waitForCommand = () =>
      Effect.promise(
        () => new Promise((resolve) => process.stdin.once("data", resolve)),
      );
    for (const phase of ["first", "second"]) {
      yield* waitForCommand();
      let timerFired = false;
      timer = setTimeout(() => {
        timerFired = true;
        process.stdout.write(`TIMER_${phase.toUpperCase()}\n`);
      }, 50);
      const started = performance.now();
      const result = yield* Effect.result(client.acquire(mode));
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const observation =
        result._tag === "Success"
          ? {
              phase,
              _tag: "Acquired",
              elapsedMs: performance.now() - started,
              timerFired,
            }
          : {
              phase,
              _tag: "AcquireFailed",
              code: result.failure.code,
              elapsedMs: performance.now() - started,
              timerFired,
            };
      if (result._tag === "Success") {
        yield* releaseP39WriterPermit(result.success);
        process.stdout.write(`${JSON.stringify(observation)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(observation)}\n`);
    }
  }).pipe(Effect.provide(p39WriterLockLayer(lockFilename, 250))),
);

try {
  await Effect.runPromise(program);
} catch (cause) {
  process.stdout.write(
    `${JSON.stringify({ _tag: "Failed", message: String(cause) })}\n`,
  );
} finally {
  if (timer !== undefined) clearTimeout(timer);
}
