import { Effect } from "effect";
import { buildSliceLayer } from "./composition.js";

/** Minimal runnable entry: build the slice layer and run migrations.
 * A full production daemon/CLI is explicitly out of P5 scope (DID v1.9 G1). */
export const main = Effect.gen(function* () {
  const layer = buildSliceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
  });
  yield* Effect.void.pipe(Effect.provide(layer));
  return layer;
});

if (import.meta.url === `file://${process.argv[1]}`) {
  Effect.runPromise(main).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
