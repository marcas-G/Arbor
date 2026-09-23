import { inspect } from "node:util";
import { Principal, parse, WorkspaceId } from "@arbor/domain";
import { startupRecovery } from "@arbor/execution-runtime";
import { Duration, Effect, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  buildSliceLayer,
  P12_MIGRATIONS,
  runMigrations,
  type SliceConfig,
  type SliceServices,
} from "./composition.js";
import { evaluateAndSelect } from "./loop.js";
import { ProductionDaemonService, TransportBoundary } from "./production.js";
import { makeStaticAuthenticator } from "./transport/auth.js";
import { startWebTransport } from "./transport/server.js";

/** The production composition entry: build the single-workspace slice layer
 * with every frozen production capability assembled (B-7). */
export const main = (
  overrides: Partial<SliceConfig> = {},
): ReturnType<typeof buildSliceLayer> => {
  const authenticator = authenticatorFromEnv();
  return buildSliceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
    ...(process.env.ARBOR_PROJECT_ID !== undefined
      ? { projectId: process.env.ARBOR_PROJECT_ID as never }
      : {}),
    ...(authenticator !== undefined ? { authenticator } : {}),
    ...overrides,
  });
};

/** P13 local-smoke/ops wiring: `ARBOR_AUTH_TOKENS="token1=user:alice,token2=user:bob"`
 * populates the static transport authenticator (P12 `10` §3 — the static map
 * is the boundary proof mechanism; production replaces it with an IdP
 * adapter without changing the boundary contract). No governance facts are
 * granted here; the Authority Resolver remains the sole enforcement. */
const authenticatorFromEnv = () => {
  const raw = process.env.ARBOR_AUTH_TOKENS;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const map: Record<string, Principal> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const token = pair.slice(0, eq).trim();
    const principal = pair.slice(eq + 1).trim();
    if (token.length > 0 && principal.length > 0) {
      map[token] = parse(Principal)(principal);
    }
  }
  return Object.keys(map).length === 0
    ? undefined
    : makeStaticAuthenticator(map);
};

export interface ProductionDaemonRunConfig extends Partial<SliceConfig> {
  /** The workspace whose scheduler/loop is evaluated each tick. Absent means
   * only the recovery/consumer daemons run. */
  readonly workspaceId?: WorkspaceId;
  readonly principalRef?: string;
  readonly tickIntervalMs?: number;
  /** P13 TR-W1/W2: when set, the daemon serves the web transport
   * (static dist + frozen API shells + WS invalidation) same-origin. */
  readonly webTransport?: {
    readonly staticRoot?: string | undefined;
    readonly port?: number | undefined;
    readonly host?: string | undefined;
  };
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
    if (config.webTransport !== undefined) {
      const boundary = yield* TransportBoundary;
      const sql = yield* SqlClient;
      const handle = yield* Effect.promise(() =>
        startWebTransport({
          http: boundary.http,
          webSocket: boundary.webSocket,
          sql,
          ...(config.webTransport?.staticRoot !== undefined
            ? { staticRoot: config.webTransport.staticRoot }
            : {}),
          ...(config.webTransport?.port !== undefined
            ? { port: config.webTransport.port }
            : {}),
          ...(config.webTransport?.host !== undefined
            ? { host: config.webTransport.host }
            : {}),
        }),
      );
      yield* Effect.addFinalizer(() => Effect.promise(handle.close));
    }
    return { deployment, schedulerTick };
  });

/** One bounded daemon cycle: start (migrate + T1) -> scheduler/loop ->
 * consumer polls -> recovery sweep. Used by the smoke test and `--once`. */
export const runDaemonOnce = (config: ProductionDaemonRunConfig = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { deployment, schedulerTick } = yield* runProductionDaemon(config);
      yield* schedulerTick;
      yield* deployment.daemon.pollConsumers;
      yield* deployment.daemon.recoveryTick;
    }),
  );

/** The long-running production daemon: start, then tick forever until
 * interrupted (the stop signal). */
export const runDaemonForever = (config: ProductionDaemonRunConfig = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { deployment, schedulerTick } = yield* runProductionDaemon(config);
      yield* Effect.forever(
        Effect.gen(function* () {
          yield* schedulerTick;
          yield* deployment.daemon.pollConsumers;
          yield* deployment.daemon.recoveryTick;
          yield* deployment.daemon.conversationTick;
          yield* Effect.sleep(Duration.millis(config.tickIntervalMs ?? 1000));
        }),
      );
    }),
  );

export type { SliceServices };

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceId = process.env.ARBOR_WORKSPACE_ID;
  const webPort = process.env.ARBOR_HTTP_PORT;
  const webHost = process.env.ARBOR_HTTP_HOST;
  const config: ProductionDaemonRunConfig = {
    ...(workspaceId !== undefined
      ? { workspaceId: parse(WorkspaceId)(workspaceId) }
      : {}),
    ...(process.env.ARBOR_WEB_DIST !== undefined || webPort !== undefined
      ? {
          webTransport: {
            ...(process.env.ARBOR_WEB_DIST !== undefined
              ? { staticRoot: process.env.ARBOR_WEB_DIST }
              : {}),
            ...(webPort !== undefined ? { port: Number(webPort) } : {}),
            ...(webHost !== undefined ? { host: webHost } : {}),
          },
        }
      : {}),
  };
  const program = process.argv.includes("--once")
    ? Effect.scoped(runDaemonOnce(config))
    : Effect.scoped(runDaemonForever(config));
  Effect.runPromise(Effect.provide(program, main(config))).catch((error) => {
    // Structured diagnosis (Cause/Rollback objects do not stringify).
    process.stderr.write(
      `arbor daemon failed: ${inspect(error, { depth: 6, breakLength: 120 })}\n`,
    );
    process.exitCode = 1;
  });
}
