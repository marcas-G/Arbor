import { Principal, parse, WorkspaceId } from "@arbor/domain";
import { startupRecovery } from "@arbor/execution-runtime";
import { Duration, Effect } from "effect";
import {
  buildSliceLayer,
  P12_MIGRATIONS,
  runMigrations,
  type SliceConfig,
  type SliceServices,
} from "./composition.js";
import { evaluateAndSelect } from "./loop.js";
import { ProductionDaemonService } from "./production.js";

/** The production composition entry: build the single-workspace slice layer
 * with every frozen production capability assembled (B-7). */
export const main = (
  overrides: Partial<SliceConfig> = {},
): ReturnType<typeof buildSliceLayer> =>
  buildSliceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
    ...(process.env.ARBOR_PROJECT_ID !== undefined
      ? { projectId: process.env.ARBOR_PROJECT_ID as never }
      : {}),
    ...overrides,
  });

export interface ProductionDaemonRunConfig extends Partial<SliceConfig> {
  /** The workspace whose scheduler/loop is evaluated each tick. Absent means
   * only the recovery/consumer daemons run. */
  readonly workspaceId?: WorkspaceId;
  readonly principalRef?: string;
  readonly tickIntervalMs?: number;
}

/** P5 `01` §3: migrate, then run one scheduler loop step for a workspace.
 * T1 (P9 `03` §2): the startup full recovery pass runs exactly once per
 * daemon start, before any new dispatch or admission. */
export const runOnce = (workspaceId: string, principalRef = "runtime:system") =>
  Effect.gen(function* () {
    yield* runMigrations(P12_MIGRATIONS);
    yield* startupRecovery(parse(Principal)(principalRef));
    return yield* evaluateAndSelect(
      parse(WorkspaceId)(workspaceId),
      parse(Principal)(principalRef),
      { _tag: "Recovery" },
    );
  });

/**
 * B-7 — the runnable production daemon lifecycle.
 *
 * `start` = canonical migrations, then the T1 startup recovery pass (exactly
 * once, before any new dispatch/admission). `tick` = one scheduler/loop
 * evaluation (when a workspace is configured) plus one offset-driven poll per
 * consumer and a T2/T3 recovery sweep. `runOnce`/`runForever` are the bounded
 * and long-running forms; interruption (`Effect` fiber interrupt) is the stop
 * signal, so no parallel runtime or extra lifecycle service is introduced.
 */
export const runProductionDaemon = (config: ProductionDaemonRunConfig = {}) =>
  Effect.gen(function* () {
    const deployment = yield* ProductionDaemonService;
    const principal = parse(Principal)(config.principalRef ?? "runtime:system");
    const schedulerTick =
      config.workspaceId !== undefined
        ? evaluateAndSelect(config.workspaceId, principal, {
            _tag: "Recovery",
          })
        : Effect.void;
    yield* deployment.daemon.start;
    return { deployment, schedulerTick };
  });

/** One bounded daemon cycle: start (migrate + T1) -> scheduler/loop ->
 * consumer polls -> recovery sweep. Used by the smoke test and `--once`. */
export const runDaemonOnce = (config: ProductionDaemonRunConfig = {}) =>
  Effect.gen(function* () {
    const { deployment, schedulerTick } = yield* runProductionDaemon(config);
    yield* schedulerTick;
    yield* deployment.daemon.pollConsumers;
    yield* deployment.daemon.recoveryTick;
  });

/** The long-running production daemon: start, then tick forever until
 * interrupted (the stop signal). */
export const runDaemonForever = (config: ProductionDaemonRunConfig = {}) =>
  Effect.gen(function* () {
    const { deployment, schedulerTick } = yield* runProductionDaemon(config);
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* schedulerTick;
        yield* deployment.daemon.pollConsumers;
        yield* deployment.daemon.recoveryTick;
        yield* Effect.sleep(Duration.millis(config.tickIntervalMs ?? 1000));
      }),
    );
  });

export type { SliceServices };

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceId = process.env.ARBOR_WORKSPACE_ID;
  const config: ProductionDaemonRunConfig = {
    ...(workspaceId !== undefined
      ? { workspaceId: parse(WorkspaceId)(workspaceId) }
      : {}),
  };
  const program: Effect.Effect<void, unknown, SliceServices> =
    process.argv.includes("--once")
      ? runDaemonOnce(config)
      : (runDaemonForever(config) as Effect.Effect<
          void,
          unknown,
          SliceServices
        >);
  Effect.runPromise(Effect.scoped(Effect.provide(program, main(config)))).catch(
    (error) => {
      process.stderr.write(`arbor daemon failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
