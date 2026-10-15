import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { Principal, parse, WorkspaceId, workEpisode } from "@arbor/domain";
import {
  consumeWorkspaceWake,
  preDispatchCheck,
  runExecution,
  startupRecovery,
} from "@arbor/execution-runtime";
import {
  acquireP39RuntimeWriterPermit,
  type P39MaintenanceFailure,
  type P39WriterLockFailure,
  p39UnsupportedDeployment,
  p39WriterLockLayer,
  prepareP39PrimaryDatabasePath,
  releaseP39WriterPermit,
  type SqliteAdapterError,
} from "@arbor/persistence-sqlite";
import {
  Clock,
  ExecutableApprovalStore,
  ExecutionRepository,
  type ModelDeployment,
  ProjectDirectory,
  ProjectResourceProfilePort,
  type ProviderExecutionPolicyOverrides,
  secretRef,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import type { Scope } from "effect";
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
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "./project-resource-profiles.js";
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
  /** Optional process-local observer for the successful Web transport bind.
   * The reported port is the actual bound port (including when configured as
   * zero). Observer failures must not change daemon startup semantics. */
  readonly onWebTransportListening?: (port: number) => void;
  /** Test-only scheduler trace; absent in ordinary production composition. */
  readonly schedulerQualificationProbe?: (event: {
    readonly boundary:
      | "SchedulerTickEnter"
      | "WorkspaceScanComplete"
      | "ActiveCandidateSummary"
      | "ActiveExecutionSelected"
      | "PreDispatchLeaseCheck";
    readonly tickSequence: number;
    readonly workspaceId?: string;
    readonly workspaceIds?: ReadonlyArray<string>;
    readonly executionId?: string;
    readonly lease?: {
      readonly workerId: string;
      readonly workerIncarnationId: string;
      readonly generation: number;
      readonly expiresAt: string;
    };
    readonly dispatchable?: boolean;
    readonly candidate?: {
      readonly executionId: string;
      readonly workspaceId: string;
      readonly episodeType: string;
      readonly episodeRef?: string;
      readonly episodeRevision?: number;
      readonly executionStatus: string;
      readonly workId?: string;
      readonly workLifecycle?: string;
      readonly workRevision?: number;
      readonly currentWorkId?: string | null;
      readonly currentWorkMatchesEpisode?: boolean;
    };
    readonly selectionRejectionReason?: "NoActiveMainExecution";
  }) => void;
}

const reportStartupPhase = (
  probe: ((phase: string) => void) | undefined,
  phase: string,
): void => {
  try {
    probe?.(phase);
  } catch {
    // Test-only startup diagnostics are non-authoritative.
  }
};

/** P5 `01` §3: migrate, then run one scheduler loop step for a workspace.
 * T1 (P9 `03` §2): the startup full recovery pass runs exactly once per
 * daemon start, before any new dispatch or admission. */
const isWorkspaceId = (value: string): boolean =>
  /^ws_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );

/** The default daemon re-discovers durable Open-work targets on every tick.
 * A configured workspace intentionally narrows scheduling authority to that
 * workspace; Parent Inbox rows are processed only by their owning/global
 * scheduler, never by a child-scoped daemon. */
export const schedulerWorkspaceTargets = (
  rows: ReadonlyArray<{ readonly workspace_id: string }>,
  configuredWorkspaceId?: WorkspaceId,
): ReadonlyArray<WorkspaceId> => {
  if (configuredWorkspaceId !== undefined) return [configuredWorkspaceId];
  return [...new Set(rows.map((row) => row.workspace_id))]
    .filter(isWorkspaceId)
    .map((id) => parse(WorkspaceId)(id));
};

export const runOnce = (workspaceId: string, principalRef = "runtime:system") =>
  Effect.gen(function* () {
    yield* runMigrations(CURRENT_MIGRATIONS);
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    const executableApprovals = yield* ExecutableApprovalStore;
    const now = yield* clock.now();
    yield* tx.transact(
      executableApprovals.expireDue({
        now,
        expiredBy: parse(Principal)(principalRef),
      }),
    );
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
    reportStartupPhase(
      config.startupDiagnosticProbe,
      "production-daemon-service.acquired",
    );
    const principal = parse(Principal)(config.principalRef ?? "runtime:system");
    let schedulerTickSequence = 0;
    const reportSchedulerEvent = (event: {
      readonly boundary:
        | "SchedulerTickEnter"
        | "WorkspaceScanComplete"
        | "ActiveCandidateSummary"
        | "ActiveExecutionSelected"
        | "PreDispatchLeaseCheck";
      readonly tickSequence: number;
      readonly workspaceId?: string;
      readonly workspaceIds?: ReadonlyArray<string>;
      readonly executionId?: string;
      readonly lease?: {
        readonly workerId: string;
        readonly workerIncarnationId: string;
        readonly generation: number;
        readonly expiresAt: string;
      };
      readonly dispatchable?: boolean;
      readonly candidate?: {
        readonly executionId: string;
        readonly workspaceId: string;
        readonly episodeType: string;
        readonly episodeRef?: string;
        readonly episodeRevision?: number;
        readonly executionStatus: string;
        readonly workId?: string;
        readonly workLifecycle?: string;
        readonly workRevision?: number;
        readonly currentWorkId?: string | null;
        readonly currentWorkMatchesEpisode?: boolean;
      };
      readonly selectionRejectionReason?: "NoActiveMainExecution";
    }) => {
      try {
        config.schedulerQualificationProbe?.(event);
      } catch {
        // Test scheduler observation is non-authoritative.
      }
    };
    // The scheduler tick drives EVERY open project's root workspace (the
    // same product-shape fix the conversation tick received): a configured
    // workspace stays as an explicit fast path. Legacy non-v7 workspace ids
    // are skipped defensively — they predate the id schema and must not
    // crash the loop.
    const schedulerTick = Effect.gen(function* () {
      const tickSequence = ++schedulerTickSequence;
      reportSchedulerEvent({
        boundary: "SchedulerTickEnter",
        tickSequence,
      });
      const resumeActiveExecution = (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const executions = yield* ExecutionRepository;
          const active = yield* tx.transact(
            executions.findActiveMainByWorkspace(workspaceId),
          );
          if (Option.isNone(active)) {
            if (config.schedulerQualificationProbe !== undefined) {
              reportSchedulerEvent({
                boundary: "ActiveCandidateSummary",
                tickSequence,
                workspaceId,
                selectionRejectionReason: "NoActiveMainExecution",
              });
            }
            reportSchedulerEvent({
              boundary: "ActiveExecutionSelected",
              tickSequence,
              workspaceId,
            });
            return;
          }
          const executionId = active.value.executionId;
          if (config.schedulerQualificationProbe !== undefined) {
            const workspaces = yield* WorkspaceRepository;
            const works = yield* WorkRepository;
            const workspace = yield* tx.transact(
              workspaces.findById(workspaceId),
            );
            const boundWork = workEpisode(active.value);
            const work =
              boundWork === null
                ? Option.none()
                : yield* tx.transact(works.findById(boundWork.workId));
            const episode =
              active.value.binding._tag === "WorkspaceExecution" &&
              "episode" in active.value.binding
                ? active.value.binding.episode
                : undefined;
            const episodeRef =
              episode === undefined
                ? undefined
                : episode._tag === "WorkEpisode"
                  ? episode.workId
                  : episode._tag === "ConversationResponseEpisode"
                    ? episode.messageId
                    : episode._tag === "InboxEpisode"
                      ? episode.entryKey
                      : episode.decisionId;
            const currentWorkId = Option.isSome(workspace)
              ? workspace.value.currentWorkId
              : undefined;
            reportSchedulerEvent({
              boundary: "ActiveCandidateSummary",
              tickSequence,
              workspaceId,
              candidate: {
                executionId,
                workspaceId: active.value.workspaceId,
                episodeType:
                  episode?._tag ??
                  (boundWork === null
                    ? "LegacyOrBoundAgentEpisode"
                    : "LegacyWorkEpisode"),
                ...(episodeRef !== undefined ? { episodeRef } : {}),
                ...(episode !== undefined && "targetWorkRevision" in episode
                  ? { episodeRevision: episode.targetWorkRevision }
                  : episode !== undefined && "responseJobRevision" in episode
                    ? { episodeRevision: episode.responseJobRevision }
                    : episode !== undefined && "requestRevision" in episode
                      ? { episodeRevision: episode.requestRevision }
                      : {}),
                executionStatus: active.value.state.status,
                ...(boundWork !== null
                  ? {
                      workId: boundWork.workId,
                      ...(Option.isSome(work)
                        ? {
                            workLifecycle: work.value.lifecycle,
                            workRevision: work.value.revision,
                          }
                        : {}),
                      ...(currentWorkId !== undefined
                        ? {
                            currentWorkId,
                            currentWorkMatchesEpisode:
                              currentWorkId === boundWork.workId,
                          }
                        : {}),
                    }
                  : currentWorkId !== undefined
                    ? { currentWorkId }
                    : {}),
              },
            });
          }
          reportSchedulerEvent({
            boundary: "ActiveExecutionSelected",
            tickSequence,
            workspaceId,
            executionId,
          });
          const lease = yield* tx.transact(
            executions.currentLease(executionId),
          );
          const dispatchable = yield* preDispatchCheck(executionId);
          reportSchedulerEvent({
            boundary: "PreDispatchLeaseCheck",
            tickSequence,
            workspaceId,
            executionId,
            ...(Option.isSome(lease)
              ? {
                  lease: {
                    workerId: lease.value.workerId,
                    workerIncarnationId: lease.value.workerIncarnationId,
                    generation: lease.value.generation,
                    expiresAt: lease.value.expiresAt,
                  },
                }
              : {}),
            dispatchable,
          });
          if (!dispatchable) {
            const leaseProbe = config.executionLeaseQualificationProbe;
            if (leaseProbe !== undefined)
              yield* Effect.promise(() =>
                leaseProbe({
                  boundary: "AH10PreDispatchSkippedLiveLease",
                  executionId,
                }),
              );
            return;
          }
          // runExecution owns the shared P38 Pending-approval gate before
          // worker dispatch and lease acquisition; do not duplicate it here.
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
        // The scoped scheduler still owns only this workspace, but must use
        // the Inbox-aware wake boundary so a durable WorkBlocked Parent entry
        // is re-admitted after restart just like it is in global mode.
        yield* consumeWorkspaceWake(
          config.workspaceId,
          { _tag: "Recovery" },
          principal,
          config.executionSettlementQualificationProbe,
          config.executionLeaseQualificationProbe,
        );
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
      const workspaceIds = schedulerWorkspaceTargets(rows);
      reportSchedulerEvent({
        boundary: "WorkspaceScanComplete",
        tickSequence,
        workspaceIds,
      });
      for (const workspaceId of workspaceIds) {
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
    reportStartupPhase(config.startupDiagnosticProbe, "daemon.start.before");
    yield* deployment.daemon.start;
    reportStartupPhase(config.startupDiagnosticProbe, "daemon.start.after");
    let webTransportHandle:
      | Awaited<ReturnType<typeof startWebTransport>>
      | undefined;
    if (config.webTransport !== undefined) {
      const boundary = yield* TransportBoundary;
      const sql = yield* SqlClient;
      const projectDirectory = yield* ProjectDirectory;
      const projectResourceProfiles = yield* ProjectResourceProfilePort;
      reportStartupPhase(
        config.startupDiagnosticProbe,
        "web-transport.bind.before",
      );
      const handle = yield* Effect.promise(() =>
        startWebTransport({
          http: boundary.http,
          webSocket: boundary.webSocket,
          authenticator: boundary.authenticator,
          authenticatorConfigured: boundary.authenticatorConfigured,
          sql,
          projectDirectory,
          projectResourceProfiles,
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
      try {
        config.onWebTransportListening?.(handle.port);
      } catch {
        // Lifecycle observation is non-authoritative and cannot fail startup.
      }
      reportStartupPhase(
        config.startupDiagnosticProbe,
        "web-transport.bind.after",
      );
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
  withP39RuntimeWriterPermit(
    config.databaseFile ?? process.env.ARBOR_DB ?? "./arbor-slice.db",
    config.startupDiagnosticProbe,
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
  withP39RuntimeWriterPermit(
    config.databaseFile ?? process.env.ARBOR_DB ?? "./arbor-slice.db",
    config.startupDiagnosticProbe,
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

/** Hold the shared SQLite lock database read transaction for the whole daemon
 * lifetime. A maintenance process takes the corresponding EXCLUSIVE lock,
 * waits for existing daemons to exit, then prevents another daemon from
 * opening the primary database until its ordered migration transaction ends. */
const withP39RuntimeWriterPermit = <A, E, R>(
  primaryDatabaseFilename: string,
  startupDiagnosticProbe: ((phase: string) => void) | undefined,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | P39MaintenanceFailure | P39WriterLockFailure | SqliteAdapterError,
  Exclude<R, Scope.Scope>
> => {
  reportStartupPhase(
    startupDiagnosticProbe,
    "p39.runtime-path-validation.before",
  );
  const prepared = prepareP39PrimaryDatabasePath(primaryDatabaseFilename);
  reportStartupPhase(
    startupDiagnosticProbe,
    "p39.runtime-path-validation.after",
  );
  if (!("databaseFilename" in prepared)) {
    return Effect.fail(p39UnsupportedDeployment(prepared.code));
  }
  return Effect.scoped(
    Effect.provide(
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          reportStartupPhase(
            startupDiagnosticProbe,
            "p39.writer-permit-acquire.before",
          );
          const permit = yield* acquireP39RuntimeWriterPermit();
          reportStartupPhase(
            startupDiagnosticProbe,
            "p39.writer-permit-acquire.after",
          );
          return permit;
        }),
        () => use,
        releaseP39WriterPermit,
      ),
      p39WriterLockLayer(prepared.writerLockFilename),
    ),
  ).pipe(
    Effect.mapError((cause) =>
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "P39WriterLockFailure" &&
      (cause.code === "P39_WRITER_LOCK_PATH_INVALID" ||
        cause.code === "P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT")
        ? p39UnsupportedDeployment(cause.code)
        : cause,
    ),
  );
};

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
    projectResourceProfiles: makeProjectResourceProfilePort(
      projectResourceProfilesFromEnvironment(),
    ),
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
