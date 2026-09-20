import { buildSliceLayer } from "./composition.js";

/** Minimal runnable entry: build the slice layer. A full production daemon/CLI
 * is explicitly out of P5 scope (DID v1.9 G1). */
export const main = () =>
  buildSliceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
