import { Effect } from "effect";

const {
  acquireMaintenanceWriterExclusion,
  acquireRuntimeWriterPermit,
  databaseWriterLockLayer,
  releaseDatabaseWriterPermit,
} = await import("../../../adapters/persistence-sqlite/dist/index.js");

const [lockFilename, mode] = process.argv.slice(2);
if (!lockFilename || (mode !== "shared" && mode !== "exclusive")) {
  throw new Error(
    "usage: database-writer-lock-child.mjs <lock-db> <shared|exclusive>",
  );
}

const acquire =
  mode === "shared"
    ? acquireRuntimeWriterPermit()
    : acquireMaintenanceWriterExclusion();

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
      releaseDatabaseWriterPermit,
    ),
    databaseWriterLockLayer(lockFilename, 1000),
  ),
);

try {
  await Effect.runPromise(program);
} catch (cause) {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
}
