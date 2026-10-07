import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { Principal, parse, WorkspaceId } from "@arbor/domain";
import {
  consumeWorkspaceWake,
  preDispatchCheck,
  runExecution,
  startupRecovery,
} from "@arbor/execution-runtime";
import {
  ExecutionRepository,
  type ModelDeployment,
  ProjectDirectory,
  type ProviderExecutionPolicyOverrides,
  secretRef,
  TransactionPort,
} from "@arbor/ports";
import { Duration, Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
  type SingleWorkspaceConfig,
  type SingleWorkspaceServices,
} from "./composition.js";
import { evaluateAndSelect } from "./loop.js";
import { ProductionDaemonService, TransportBoundary } from "./production.js";
import {
  findArborConfigFile,
  providerDeploymentOfConfig,
} from "./provider-config.js";
import {
  makeBasicAuthenticator,
  makeStaticAuthenticator,
} from "./transport/auth.js";
import { startWebTransport } from "./transport/server.js";

/** The production composition entry: build the single-workspace slice layer
 * with every frozen production capability assembled (B-7). */
export const main = (
  overrides: Partial<SingleWorkspaceConfig> = {},
): ReturnType<typeof buildSingleWorkspaceLayer> => {
  const authenticator = authenticatorFromEnv();
  // Standard config file (arbor.config.json) is the primary provider source;
  // legacy env vars remain a compatibility fallback; absent both = fake.
  const configFile = findArborConfigFile();
  if (configFile !== undefined && configFile.ok === false) {
    throw new Error(
      `invalid provider config ${configFile.error.path}: ${configFile.error.reason}`,
    );
  }
  const fromConfig =
    configFile !== undefined && configFile.ok === true
      ? providerDeploymentOfConfig(configFile.config)
      : undefined;
  const deployment = fromConfig?.deployment ?? deploymentFromEnv();
  return buildSingleWorkspaceLayer({
    databaseFile: process.env.ARBOR_DB ?? "./arbor-slice.db",
    ...(process.env.ARBOR_PROJECT_ID !== undefined
      ? { projectId: process.env.ARBOR_PROJECT_ID as never }
      : {}),
    ...(authenticator !== undefined ? { authenticator } : {}),
    ...(deployment !== undefined
      ? {
          deployment,
          modelRef: deployment.modelRef,
          secretRef: deployment.secretRef,
          ...(fromConfig?.secretStore !== undefined
            ? { secretStore: fromConfig.secretStore }
            : {}),
        }
      : {}),
    ...overrides,
  });
};

/** Real-provider wiring (P16 `01` §5 — formalized as a ModelDeployment;
 * construction only, resolution happens in the Composition Root):
 *
 *   ARBOR_PROVIDER_DEPLOYMENT_ID  dep-env            (stable deployment id)
 *   ARBOR_MODEL_BASE_URL          https://api.deepseek.com/v1
 *   ARBOR_MODEL_NAME              deepseek-chat      (wire model name)
 *   ARBOR_MODEL_API_KEY_VAR       ARBOR_MODEL_API_KEY (env var NAME holding
 *                                 the key — the SecretRef, resolved by the
 *                                 P12 secret store; never the raw key)
 *   ARBOR_MODEL_POLICY_JSON       optional execution-policy overrides
 *
 * Absent vars = the deterministic fake provider (CI never needs network).
 * `ARBOR_MODEL_API_KEY_VAR` defaults to `ARBOR_MODEL_API_KEY` when set. */
const deploymentFromEnv = (): ModelDeployment | undefined => {
  const baseUrl = process.env.ARBOR_MODEL_BASE_URL;
  const modelName = process.env.ARBOR_MODEL_NAME;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return undefined;
  }
  const keyVar = process.env.ARBOR_MODEL_API_KEY_VAR ?? "ARBOR_MODEL_API_KEY";
  if (!(keyVar in process.env) || (process.env[keyVar] ?? "").length === 0) {
    return undefined;
  }
  const policyJson = process.env.ARBOR_MODEL_POLICY_JSON;
  let executionPolicyOverrides: ProviderExecutionPolicyOverrides | undefined;
  if (policyJson !== undefined && policyJson.length > 0) {
    const parsed = JSON.parse(policyJson) as ProviderExecutionPolicyOverrides;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("ARBOR_MODEL_POLICY_JSON must be a JSON object");
    }
    executionPolicyOverrides = parsed;
  }
  return {
    deploymentId: process.env.ARBOR_PROVIDER_DEPLOYMENT_ID ?? "dep-env",
    modelRef: "model-openai",
    endpoint: baseUrl,
    ...(modelName !== undefined && modelName.length > 0
      ? { wireModelName: modelName }
      : {}),
    secretRef: secretRef(keyVar),
    ...(executionPolicyOverrides !== undefined
      ? { executionPolicyOverrides }
      : {}),
  };
};

/** Authenticator selection (OpenCode-style model, product decision
 * 2026-09-29):
 *
 *   ARBOR_SERVER_PASSWORD set (non-empty)  → Basic access gate (remote
 *     exposure; direct comparison, no JWT/session — an HTTP access gate,
 *     not an identity system; authorized requests act as the single
 *     configured principal)
 *   ARBOR_AUTH_TOKENS set                  → static principal map (P12 `10`
 *     §3 boundary-proof mechanism, multi-user)
 *   neither                                → local single-user form: the
 *     daemon is a loopback desktop process; OS user + loopback isolation is
 *     the security boundary (same model as `opencode` with no
 *     OPENCODE_SERVER_PASSWORD).
 *
 * No governance facts are granted at the transport; the Authority Resolver
 * remains the sole enforcement. */
const authenticatorFromEnv = () => {
  const serverPassword = process.env.ARBOR_SERVER_PASSWORD;
  if (serverPassword !== undefined && serverPassword.length > 0) {
    return makeBasicAuthenticator({
      username: process.env.ARBOR_SERVER_USERNAME ?? "arbor",
      password: serverPassword,
      ...(process.env.ARBOR_SERVER_PRINCIPAL !== undefined
        ? { principal: parse(Principal)(process.env.ARBOR_SERVER_PRINCIPAL) }
        : {}),
    });
  }
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

export interface ProductionDaemonRunConfig
  extends Partial<SingleWorkspaceConfig> {
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
const isWorkspaceId = (value: string): boolean =>
  /^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );

export const runOnce = (workspaceId: string, principalRef = "runtime:system") =>
  Effect.gen(function* () {
    yield* runMigrations(CURRENT_MIGRATIONS);
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
    // The scheduler tick drives EVERY open project's root workspace (the
    // same product-shape fix the conversation tick received): a configured
    // workspace stays as an explicit fast path. Legacy non-v7 workspace ids
    // are skipped defensively — they predate the id schema and must not
    // crash the loop.
    const schedulerTick = Effect.gen(function* () {
      const resumeActiveExecution = (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const executions = yield* ExecutionRepository;
          const active = yield* tx.transact(
            executions.findActiveMainByWorkspace(workspaceId),
          );
          if (Option.isNone(active)) return;
          const executionId = active.value.executionId;
          if (!(yield* preDispatchCheck(executionId))) {
            return;
          }
          // ApprovalRequired releases the lease but deliberately keeps the
          // Execution active. Only the approval resolution consumer may wake
          // it; an ordinary scheduler tick must not poll a human decision.
          const sql = yield* SqlClient;
          const pendingApproval = yield* sql.unsafe<{ present: number }>(
            "SELECT 1 AS present FROM action_approvals WHERE execution_id = ? AND state = 'Pending' LIMIT 1",
            [executionId],
          );
          if (pendingApproval.length > 0) {
            return;
          }
          yield* runExecution(
            executionId,
            { _tag: "Recovery" },
            principal,
            undefined,
            config.executionSettlementQualificationProbe,
            config.executionLeaseQualificationProbe,
          ).pipe(Effect.catchTag("LeaseFencingRejected", () => Effect.void));
        });
      if (config.workspaceId !== undefined) {
        yield* evaluateAndSelect(config.workspaceId, principal, {
          _tag: "Recovery",
        });
        yield* resumeActiveExecution(config.workspaceId);
        return;
      }
      const sql = yield* SqlClient;
      // Drive EVERY workspace with runnable work (roots via their projects,
      // child workspaces via their own open works) — a work assigned to a
      // child workspace must not wait for a per-workspace config.
      const rows = yield* sql.unsafe<{ workspace_id: string }>(
        `SELECT DISTINCT w.workspace_id AS workspace_id
           FROM works w JOIN workspaces ws ON ws.workspace_id = w.workspace_id
          WHERE w.lifecycle = 'Open' AND ws.lifecycle = 'Active'
          UNION
         SELECT root_workspace_id AS workspace_id FROM projects WHERE lifecycle = 'Open'`,
      );
      for (const row of rows) {
        if (!isWorkspaceId(row.workspace_id)) {
          continue;
        }
        const workspaceId = parse(WorkspaceId)(row.workspace_id);
        yield* consumeWorkspaceWake(
          workspaceId,
          { _tag: "Recovery" },
          principal,
          config.executionSettlementQualificationProbe,
          config.executionLeaseQualificationProbe,
        );
        yield* resumeActiveExecution(workspaceId);
      }
    });
    yield* deployment.daemon.start;
    let webTransportHandle:
      | Awaited<ReturnType<typeof startWebTransport>>
      | undefined;
    if (config.webTransport !== undefined) {
      const boundary = yield* TransportBoundary;
      const sql = yield* SqlClient;
      const projectDirectory = yield* ProjectDirectory;
      const handle = yield* Effect.promise(() =>
        startWebTransport({
          http: boundary.http,
          webSocket: boundary.webSocket,
          authenticator: boundary.authenticator,
          sql,
          projectDirectory,
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
      webTransportHandle = handle;
      yield* Effect.addFinalizer(() => Effect.promise(handle.close));
    }
    // ResponseJob transitions may happen in the daemon sweep without a
    // transport command event. Track the latest Job update beside the event
    // watermark so retry/attention/answer status invalidates immediately.
    // Broadcast ONLY on real movement, never per-tick: (a) journal-watermark
    // movement covers every event-producing change; (b) the latest answered
    // settled_at covers the conversation settle write-back, which
    // deliberately emits NO domain event (P14 `02` §4.1) and therefore never
    // moves the watermark — without signal (b) an answer only appears after
    // the user's NEXT message moves something. Both signals are cheap; idle
    // ticks broadcast nothing.
    let lastBroadcastWatermark: number | undefined;
    let lastBroadcastConversationAt: string | undefined;
    const conversationTickWithRefresh = Effect.gen(function* () {
      yield* deployment.daemon.conversationTick;
      if (webTransportHandle !== undefined) {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{
          watermark: number;
          conversationAt: string | null;
        }>(
          "SELECT (SELECT COALESCE(MAX(sequence), 0) FROM domain_events) AS watermark, (SELECT MAX(updated_at) FROM conversation_response_jobs) AS conversationAt",
        );
        const watermark = Number(rows[0]?.watermark ?? 0);
        const conversationAt = rows[0]?.conversationAt ?? undefined;
        if (
          watermark !== lastBroadcastWatermark ||
          conversationAt !== lastBroadcastConversationAt
        ) {
          lastBroadcastWatermark = watermark;
          lastBroadcastConversationAt = conversationAt;
          webTransportHandle.fanout.publishWatermark(watermark);
        }
      }
    });
    return {
      deployment,
      schedulerTick,
      conversationTick: conversationTickWithRefresh,
    };
  });

/** One bounded daemon cycle: start (migrate + T1) -> scheduler/loop ->
 * consumer polls -> recovery sweep. Used by the smoke test and `--once`. */
export const runDaemonOnce = (config: ProductionDaemonRunConfig = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { deployment, schedulerTick, conversationTick } =
        yield* runProductionDaemon(config);
      yield* schedulerTick;
      yield* deployment.daemon.pollConsumers;
      yield* deployment.daemon.recoveryTick;
      yield* conversationTick;
    }),
  );

/** The long-running production daemon: start, then tick forever until
 * interrupted (the stop signal). */
export const runDaemonForever = (config: ProductionDaemonRunConfig = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { deployment, schedulerTick, conversationTick } =
        yield* runProductionDaemon(config);
      yield* Effect.forever(
        Effect.gen(function* () {
          yield* schedulerTick;
          yield* deployment.daemon.pollConsumers;
          yield* deployment.daemon.recoveryTick;
          yield* conversationTick;
          yield* Effect.sleep(Duration.millis(config.tickIntervalMs ?? 1000));
        }),
      );
    }),
  );

export type { SingleWorkspaceServices };

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
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
