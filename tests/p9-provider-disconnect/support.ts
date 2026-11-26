import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  runMigrations,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { recoverUnsettledProviderTurns } from "../../packages/application/src/provider-turn-recovery.js";
import {
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
} from "../../packages/domain/dist/index.js";
import {
  type CanonicalProviderEvent,
  Clock,
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  decideProviderRetry,
  type PortableModelRequest,
  type ProviderContinuationCheckpoint,
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  type ProviderPortEvent,
  type ProviderRetryDecisionRecord,
  ProviderTurnStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../packages/testkit/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";

/**
 * P9-008 — provider disconnect injection (PD1–PD4 / I-4..I-7; P9 `02` §6,
 * `04` §2). Disconnect ≜ ProviderUnavailable (failure before the stream is
 * established) ∪ StreamInterrupted (break after TurnStarted). The harness
 * classifies by the observable boundary (`TurnStarted` emitted or not),
 * never by transport errno (04 §2.1, GQ4 zero-new-tag mapping). Every row
 * is labeled crash-injected (GQ5).
 */

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
export const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789d1";
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d1",
) as ExecutionId;
export const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
export const providerTurnIdB = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
export const providerTurnIdC = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
export const providerTurnIdD = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d4",
);
export const manifestIdFor = (turnId: ProviderTurnId) => `mf_${turnId}`;
export const principal = parse(Principal)("runtime:system");

export type AttemptScript =
  | { readonly disconnect: "pre-connect" | "mid-stream" }
  | { readonly terminal: ProviderFailureKind }
  | { readonly events: ReadonlyArray<CanonicalProviderEvent> };

export interface ProviderProbe {
  readonly calls: Array<{
    readonly providerTurnId: ProviderTurnId;
    readonly attemptNo: number;
    readonly requestJson: string;
    readonly continuationCheckpoint: ProviderContinuationCheckpoint | null;
  }>;
}

export const successTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "TurnStarted",
    providerTurnId,
    attemptNo: 0,
    modelRef: "provider-fake",
  },
  { _tag: "TextDelta", text: "final" },
  { _tag: "UsageReported", inputTokens: 10, outputTokens: 5 },
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

export const providerFailure = (
  kind: ProviderFailureKind,
): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind,
  taxonomyVersion: "phase1-v2",
});

export const canonical = (
  event: CanonicalProviderEvent,
): ProviderPortEvent => ({
  _tag: "Canonical",
  event,
});

export const preflight: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: false, externalEffectPossible: false },
};
export const responseStarted: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: true },
};

/** Deterministic disconnect-injecting ProviderPort double. The raw transport
 * error (errno-style) never decides the classification — only the
 * observable boundary does; translation happens at this adapter boundary
 * (P3 `06` §1). */
export const DisconnectProviderLive = (
  script: ReadonlyArray<AttemptScript>,
  probe: ProviderProbe,
): Layer.Layer<ProviderPort> =>
  Layer.effect(
    ProviderPort,
    Effect.sync(() => {
      let call = 0;
      return ProviderPort.of({
        runTurn: (input) => {
          const attemptNo = input.context.attemptNo;
          probe.calls.push({
            providerTurnId: input.context.providerTurnId,
            attemptNo,
            requestJson: JSON.stringify(input.request),
            continuationCheckpoint:
              input.context.continuationCheckpoint ?? null,
          });
          const entry: AttemptScript = script[
            Math.min(call, script.length - 1)
          ] ?? { events: [] };
          call += 1;
          if ("disconnect" in entry) {
            if (entry.disconnect === "pre-connect") {
              return Stream.concat(
                Stream.fromIterable([preflight]),
                Stream.fail(providerFailure("TransportFailed")),
              );
            }
            // Mid-stream semantic output makes replay unsafe unless a
            // verified continuation checkpoint was durably recorded.
            const boundary: CanonicalProviderEvent = {
              _tag: "TurnStarted",
              providerTurnId: input.context.providerTurnId,
              attemptNo,
              modelRef: input.request.modelRef,
            };
            return Stream.concat(
              Stream.fromIterable([
                preflight,
                responseStarted,
                canonical(boundary),
                canonical({
                  _tag: "TextDelta" as const,
                  text: "partial-delta",
                }),
              ]),
              Stream.fail(providerFailure("StreamInterrupted")),
            );
          }
          if ("terminal" in entry) {
            return Stream.concat(
              Stream.fromIterable([preflight]),
              Stream.fail(providerFailure(entry.terminal)),
            );
          }
          return Stream.fromIterable([
            preflight,
            responseStarted,
            ...entry.events.map((event) =>
              event._tag === "TurnStarted"
                ? canonical({
                    ...event,
                    providerTurnId: input.context.providerTurnId,
                    attemptNo,
                    modelRef: input.request.modelRef,
                  })
                : canonical(event),
            ),
          ]);
        },
      });
    }),
  );

export const makeApp = (
  script: ReadonlyArray<AttemptScript>,
  probe: ProviderProbe,
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(),
    Layer.mergeAll(
      DisconnectProviderLive(script, probe),
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      FixedSecretStoreLive(),
      infra,
    ),
  );
  return Layer.mergeAll(
    infra,
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(TransactionPortLive, infra),
    providerRuntime,
  );
};

export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p9pd",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* ensureLegacyProjectResourceSourceFixture();
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?, 'ExecutionScoped', NULL, ?, 0, 't')",
        [sessionId, executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [executionId, projectId, workspaceId, sessionId],
      );
    }),
  );
});

export const boot = Effect.gen(function* () {
  yield* runMigrations(P16_MIGRATIONS);
  yield* seed;
});

export const runTurnInput = (turnId: ProviderTurnId) => ({
  providerTurnId: turnId,
  executionId,
  sessionId,
  contextEpoch: 0 as never,
  modelRef: "provider-fake",
  outputContractRef: "oc",
  manifestJson: JSON.stringify({
    providerTurnId: turnId,
    executionId,
    sessionId,
    contextEpoch: 0,
    modelRef: "provider-fake",
    instructionFragments: [],
    contextRefs: [],
    skillRefs: [],
    toolRefs: [],
    toolRoutes: [],
    outputContractRef: "oc",
    budgetDecision: { maxOutputTokens: 128 },
    compiledRequestHash: "p9-provider-failure-fixture",
    controlBasis: {
      projectPolicyRevision: 0,
      workspacePolicyRevision: 0,
      responsibilityRevision: 0,
      resourceBoundaryRevision: 0,
      authorizationDigest: "p9",
      environmentRevision: "0",
    },
  }),
  request: {
    modelRef: "provider-fake",
    instructions: [],
    messages: [{ role: "user" as const, text: "go" }],
    toolDefinitions: [],
    outputContractRef: "oc",
    budget: { maxOutputTokens: 128 },
    cacheHints: [],
  },
});

export const recoveryRunTurnInput = (plan: {
  readonly providerTurnId: ProviderTurnId;
  readonly manifestId: string;
  readonly manifestJson: string;
  readonly portableRequestJson: string;
  readonly nextAttemptNo: number;
  readonly retryDecision: ProviderRetryDecisionRecord;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
}) => ({
  ...runTurnInput(plan.providerTurnId),
  manifestJson: plan.manifestJson,
  request: JSON.parse(plan.portableRequestJson) as PortableModelRequest,
  recovery: {
    manifestId: plan.manifestId,
    nextAttemptNo: plan.nextAttemptNo,
    retryDecision: plan.retryDecision,
    ...(plan.continuationCheckpoint === undefined
      ? {}
      : { continuationCheckpoint: plan.continuationCheckpoint }),
  },
});

export const run = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

interface AttemptFact {
  readonly attemptNo: number;
  readonly outcome: string;
  readonly providerErrorKind: string | null;
}

export const attemptRows = (turnId: ProviderTurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      attempt_no: number;
      outcome: string;
      provider_error_kind: string | null;
    }>(
      "SELECT attempt_no, outcome, provider_error_kind FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
      [turnId],
    );
    return rows.map(
      (row): AttemptFact => ({
        attemptNo: Number(row.attempt_no),
        outcome: row.outcome,
        providerErrorKind: row.provider_error_kind,
      }),
    );
  });

interface RecoveryDecisionFact {
  readonly attempt_no: number;
  readonly cause_tag: string;
  readonly cause_detail: string | null;
  readonly retry_safety: string;
  readonly retry_decision: string;
  readonly retry_strategy: string | null;
  readonly retry_reason: string;
}

export const recoveryDecisionRows = (turnId: ProviderTurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<RecoveryDecisionFact>(
      "SELECT attempt_no, cause_tag, cause_detail, retry_safety, retry_decision, retry_strategy, retry_reason FROM provider_recovery_decisions WHERE provider_turn_id = ? ORDER BY sequence_no",
      [turnId],
    );
  });

interface TurnFact {
  readonly provider_turn_id: string;
  readonly manifest_id: string;
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
  readonly usage_json: string | null;
}

export const turnRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<TurnFact>(
    "SELECT provider_turn_id, manifest_id, settled_at, finish_reason, usage_json FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
    [executionId],
  );
});

export const executionSettlement = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] === undefined ? "missing" : rows[0].settlement_kind;
});

export const sessionEntryCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
    [sessionId],
  );
  // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
  return Number(rows[0]!.count);
});

/** Recovery face under test (deps injected from the same app layers). */
export const recover = () =>
  Effect.gen(function* () {
    const turns = yield* ProviderTurnStore;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    return yield* recoverUnsettledProviderTurns(
      { turns, tx, clock },
      projectId,
      principal,
    );
  });

/** Crash-window seed: the worker opened the Turn (intent + Manifest
 * persisted before the request, P3 `04` §3) and died — optionally after
 * recording N failed attempts — leaving the Turn unsettled. */
export const openDanglingTurn = (
  turnId: ProviderTurnId,
  crashedAttempts: ReadonlyArray<{
    readonly attemptNo: number;
    readonly kind?: "StreamInterrupted" | "RateLimited" | "ProviderUnavailable";
    readonly resumeGuaranteed?: boolean;
    readonly inProgress?: boolean;
  }> = [],
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    const manifest = JSON.stringify({
      providerTurnId: turnId,
      executionId,
      sessionId,
      contextEpoch: 0,
      modelRef: "provider-fake",
      instructionFragments: [],
      contextRefs: [],
      skillRefs: [],
      toolRefs: [],
      toolRoutes: [],
      outputContractRef: "oc",
      budgetDecision: { maxOutputTokens: 128 },
      compiledRequestHash: `compiled-${turnId}`,
      controlBasis: {
        projectPolicyRevision: 0,
        workspacePolicyRevision: 0,
        responsibilityRevision: 0,
        resourceBoundaryRevision: 0,
        authorizationDigest: "p9",
        environmentRevision: "0",
      },
    });
    const portableRequestJson = JSON.stringify({
      modelRef: "provider-fake",
      instructions: [],
      messages: [{ role: "user", text: "go" }],
      toolDefinitions: [],
      outputContractRef: "oc",
      budget: { maxOutputTokens: 128 },
      cacheHints: [],
    });
    yield* tx.transact(
      turns.startTurnWithManifest(
        {
          providerTurnId: turnId,
          executionId,
          sessionId,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId: manifestIdFor(turnId),
          executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY,
          turnDeadlineAt: "2999-01-01T00:00:00.000Z",
        },
        manifest,
        portableRequestJson,
        "t",
      ),
    );
    for (const attempt of crashedAttempts) {
      const observation =
        attempt.kind === "StreamInterrupted" ||
        attempt.resumeGuaranteed === true
          ? {
              responseStarted: true,
              canonicalEventEmitted: true,
              consumerVisibleOutput: false,
              toolCallProposed: false,
              continuationAvailable: attempt.resumeGuaranteed === true,
              externalEffectPossible: false,
            }
          : {
              responseStarted: false,
              canonicalEventEmitted: false,
              consumerVisibleOutput: false,
              toolCallProposed: false,
              continuationAvailable: false,
              externalEffectPossible: false,
            };
      const checkpoint =
        attempt.resumeGuaranteed === true
          ? {
              cursor: `cursor-${attempt.attemptNo}`,
              canonicalEventPrefixJson: JSON.stringify([
                {
                  _tag: "TurnStarted",
                  providerTurnId: turnId,
                  attemptNo: attempt.attemptNo,
                  modelRef: "provider-fake",
                },
                { _tag: "TextDelta", text: "partial" },
              ]),
              deliveredPosition: 0,
              resumeGuaranteed: true,
            }
          : null;
      yield* tx.transact(
        turns.startAttempt(
          turnId,
          attempt.attemptNo,
          {
            responseStarted: false,
            canonicalEventEmitted: false,
            consumerVisibleOutput: false,
            toolCallProposed: false,
            continuationAvailable: false,
            externalEffectPossible: null,
          },
          "t0",
        ),
      );
      if (attempt.inProgress === true && attempt.resumeGuaranteed !== true) {
        // Preserve the initial InProgress observation with an unknown
        // external-effect boundary. Recovery must classify this as
        // ProcessLost + UnsafeReplay rather than assuming a clean replay.
        continue;
      }
      yield* tx.transact(
        turns.updateAttemptObservation(
          turnId,
          attempt.attemptNo,
          observation,
          checkpoint?.canonicalEventPrefixJson ?? "[]",
          0,
          checkpoint,
          "t1",
        ),
      );
      if (attempt.inProgress === true) {
        // A process can be lost after all continuation evidence is durable,
        // but before it settles the Attempt. Leave it InProgress so recovery
        // must derive ProcessLost from the durable row.
        continue;
      }
      if (attempt.kind === undefined) {
        throw new Error(
          "settled crash fixture requires a provider failure kind",
        );
      }
      const retryDecision = decideProviderRetry({
        cause: { _tag: "ProviderFailure", kind: attempt.kind },
        observation,
        continuationCheckpoint: checkpoint,
        attemptNo: attempt.attemptNo,
        maxAttempts: DEFAULT_PROVIDER_EXECUTION_POLICY.maxAttempts,
        cancelled: false,
        deadlineExpired: false,
      });
      yield* tx.transact(
        turns.settleAttempt(
          turnId,
          attempt.attemptNo,
          {
            outcome: "RetryableFailure",
            providerErrorKind: attempt.kind,
            taxonomyVersion: "phase1-v2",
            observation,
            ...(checkpoint === null
              ? {}
              : { continuationCheckpoint: checkpoint }),
            canonicalEventPrefixJson:
              checkpoint?.canonicalEventPrefixJson ?? "[]",
            deliveredPosition: 0,
            retryDecision,
          },
          "t2",
        ),
      );
    }
    return { manifestJson: manifest, portableRequestJson };
  });
