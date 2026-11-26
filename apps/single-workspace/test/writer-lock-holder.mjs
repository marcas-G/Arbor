const {
  acquireP39RuntimeWriterPermit,
  p39WriterLockLayer,
  releaseP39WriterPermit,
} = await import("../../../adapters/persistence-sqlite/dist/index.js");
process.stdout.write("CHILD_STARTED\n");

import { writeFileSync } from "node:fs";
import * as Effect from "../../../node_modules/effect/dist/Effect.js";

const writeDiagnostic = (cause) => {
  const diagnostic = process.env.ARBOR_P6_LOCK_DIAGNOSTIC;
  if (diagnostic === undefined) return;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "P39_LOCK_HOLDER_FAILED";
  writeFileSync(diagnostic, `${code}\n`, { flag: "w" });
};
process.on("uncaughtException", (cause) => {
  writeDiagnostic(cause);
  process.exitCode = 1;
});
process.on("unhandledRejection", writeDiagnostic);

const [lockFilename] = process.argv.slice(2);
if (lockFilename === undefined)
  throw new Error("writer lock database argument missing");

const program = Effect.scoped(
  Effect.provide(
    Effect.acquireUseRelease(
      acquireP39RuntimeWriterPermit(),
      () =>
        Effect.gen(function* () {
          process.stdout.write("READY\n");
          yield* Effect.promise(
            () => new Promise((resolve) => process.stdin.once("data", resolve)),
          );
        }),
      releaseP39WriterPermit,
    ),
    p39WriterLockLayer(lockFilename, 1000),
  ),
);

try {
  await Effect.runPromise(program);
} catch (cause) {
  writeDiagnostic(cause);
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "P39_LOCK_HOLDER_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
