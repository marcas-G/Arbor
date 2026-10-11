import { Effect } from "effect";

const {
  acquireP39MaintenanceWriterExclusion,
  acquireP39RuntimeWriterPermit,
  p39WriterLockLayer,
  releaseP39WriterPermit,
} = await import("../../../adapters/persistence-sqlite/dist/index.js");

const [lockFilename, mode] = process.argv.slice(2);
if (!lockFilename || (mode !== "shared" && mode !== "exclusive")) {
  throw new Error(
    "usage: p39-writer-lock-child.mjs <lock-db> <shared|exclusive>",
  );
}

const acquire =
  mode === "shared"
    ? acquireP39RuntimeWriterPermit()
    : acquireP39MaintenanceWriterExclusion();

const waitForRelease = Effect.promise(
  () =>
    new Promise((resolve) => {
      process.stdin.once("data", resolve);
    }),
);

const program = Effect.scoped(
  Effect.provide(
    Effect.acquireUseRelease(
      acquire,
      () =>
        Effect.gen(function* () {
          process.stdout.write("READY\n");
          yield* waitForRelease;
        }),
      releaseP39WriterPermit,
    ),
    p39WriterLockLayer(lockFilename, 1000),
  ),
);

try {
  await Effect.runPromise(program);
} catch (cause) {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
}
