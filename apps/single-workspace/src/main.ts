import { Principal, parse, WorkspaceId } from "@arbor/domain";
import { startupRecovery } from "@arbor/execution-runtime";
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

/** P5 `01` §3: migrate, then run one scheduler loop step for a workspace.
 * T1 (P9 `03` §2): the startup full recovery pass runs exactly once per
 * daemon start, before any new dispatch or admission. */
export const runOnce = (workspaceId: string, principalRef = "runtime:system") =>
  Effect.gen(function* () {
    yield* runMigrations(P7_MIGRATIONS);
    yield* startupRecovery(parse(Principal)(principalRef));
    return yield* evaluateAndSelect(
      parse(WorkspaceId)(workspaceId),
      parse(Principal)(principalRef),
      { _tag: "Recovery" },
    );
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
