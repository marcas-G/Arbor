import { Principal, parse, WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import {
  buildSliceLayer,
  P7_MIGRATIONS,
  runMigrations,
} from "./composition.js";
import { evaluateAndSelect } from "./loop.js";

/** Minimal runnable entry: build the slice layer. A full production daemon/CLI
 * is explicitly out of P5 scope (DID v1.9 G1). */
export const main = () =>
  buildSliceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
  });

/** P5 `01` §3: migrate, then run one scheduler loop step for a workspace. */
export const runOnce = (workspaceId: string, principalRef = "runtime:system") =>
  Effect.gen(function* () {
    yield* runMigrations(P7_MIGRATIONS);
    return yield* evaluateAndSelect(
      parse(WorkspaceId)(workspaceId),
      parse(Principal)(principalRef),
      { _tag: "Recovery" },
    );
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
