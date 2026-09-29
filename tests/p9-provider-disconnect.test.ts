import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  ProviderTurnStoreLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { recoverUnsettledProviderTurns } from "../packages/application/src/provider-turn-recovery.js";
import {
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
} from "../packages/domain/dist/index.js";
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
  ProviderRuntime,
  ProviderTurnStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../packages/testkit/src/index.js";
import { labeled } from "./support/p9-harness-api.js";

/**
 * P9-008 — provider disconnect injection (PD1–PD4 / I-4..I-7; P9 `02` §6,
 * `04` §2). Disconnect ≜ ProviderUnavailable (failure before the stream is
 * established) ∪ StreamInterrupted (break after TurnStarted). The harness
 * classifies by the observable boundary (`TurnStarted` emitted or not),
 * never by transport errno (04 §2.1, GQ4 zero-new-tag mapping). Every row
 * is labeled crash-injected (GQ5).
 */

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789d1");
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789d1";
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789d1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d1",
) as ExecutionId;
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const providerTurnIdB = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const providerTurnIdC = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const providerTurnIdD = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d4",
);
const manifestIdFor = (turnId: ProviderTurnId) => `mf_${turnId}`;
const principal = parse(Principal)("runtime:system");

type AttemptScript =
  | { readonly disconnect: "pre-connect" | "mid-stream" }
  | { readonly terminal: ProviderFailureKind }
  | { readonly events: ReadonlyArray<CanonicalProviderEvent> };

interface ProviderProbe {
  readonly calls: Array<{
    readonly providerTurnId: ProviderTurnId;
    readonly attemptNo: number;
    readonly requestJson: string;
    readonly continuationCheckpoint: ProviderContinuationCheckpoint | null;
  }>;
}

const successTurn: ReadonlyArray<CanonicalProviderEvent> = [
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

const providerFailure = (kind: ProviderFailureKind): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind,
  taxonomyVersion: "phase1-v2",
});

const canonical = (event: CanonicalProviderEvent): ProviderPortEvent => ({
  _tag: "Canonical",
  event,
});

const preflight: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: false, externalEffectPossible: false },
};
const responseStarted: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: true },
};

/** Deterministic disconnect-injecting ProviderPort double. The raw transport
 * error (errno-style) never decides the classification — only the
 * observable boundary does; translation happens at this adapter boundary
 * (P3 `06` §1). */
const DisconnectProviderLive = (
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

const makeApp = (
  script: ReadonlyArray<AttemptScript>,
  probe: ProviderProbe,
) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
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

const seed = Effect.gen(function* () {
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

const boot = Effect.gen(function* () {
  yield* runMigrations(P16_MIGRATIONS);
  yield* seed;
});

const runTurnInput = (turnId: ProviderTurnId) => ({
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

const recoveryRunTurnInput = (plan: {
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

const run = <A>(
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

const attemptRows = (turnId: ProviderTurnId) =>
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

const recoveryDecisionRows = (turnId: ProviderTurnId) =>
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

const turnRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<TurnFact>(
    "SELECT provider_turn_id, manifest_id, settled_at, finish_reason, usage_json FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
    [executionId],
  );
});

const executionSettlement = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [executionId],
  );
  return rows[0] === undefined ? "missing" : rows[0].settlement_kind;
});

const sessionEntryCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
    [sessionId],
  );
  // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
  return Number(rows[0]!.count);
});

/** Recovery face under test (deps injected from the same app layers). */
const recover = () =>
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
const openDanglingTurn = (
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

describe("p9-provider-disconnect (PD1–PD4 / I-4..I-7, 02 §6 + 04 §2)", () => {
  it("PD1/I-4 [crash-injected]: pre-response TransportFailed → SafeReplay under the SAME ProviderTurn", async () => {
    expect(
      labeled("PD1-pre-connection-ProviderUnavailable", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        const { events } = yield* runtime.runTurn(runTurnInput(providerTurnId));
        const attempts = yield* attemptRows(providerTurnId);
        const turns = yield* turnRows;
        const entries = yield* sessionEntryCount;
        return { events, attempts, turns, entries };
      }),
      makeApp(
        [
          { disconnect: "pre-connect" },
          { disconnect: "pre-connect" },
          { events: successTurn },
        ],
        probe,
      ),
    );
    // Same ProviderTurn across all transport attempts (DID §6A.9 — a
    // transport retry is never a new model round): one turn identity, no
    // new ProviderTurn issued, turnNo unchanged.
    expect(probe.calls).toHaveLength(3);
    expect(new Set(probe.calls.map((call) => call.providerTurnId))).toEqual(
      new Set([providerTurnId]),
    );
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([0, 1, 2]);
    expect(r.turns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.manifest_id).toMatch(/^mft_/u);
    // Pre-response TransportFailed retries are admitted only with complete
    // negative observations and a persisted SafeReplay decision.
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "TransportFailed",
      },
      {
        attemptNo: 1,
        outcome: "RetryableFailure",
        providerErrorKind: "TransportFailed",
      },
      { attemptNo: 2, outcome: "Success", providerErrorKind: null },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.finish_reason).toBe("Stop");
    expect(r.events.some((event) => event._tag === "TurnCompleted")).toBe(true);
    expect(r.entries).toBe(0);
  });

  it("PD2/I-5 [crash-injected]: mid-stream output without a verified cursor is UnsafeReplay", async () => {
    expect(
      labeled("PD2-mid-stream-StreamInterrupted", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        const failure = yield* Effect.flip(
          runtime.runTurn(runTurnInput(providerTurnId)),
        );
        const attempts = yield* attemptRows(providerTurnId);
        const turns = yield* turnRows;
        const entries = yield* sessionEntryCount;
        return { failure, attempts, turns, entries };
      }),
      makeApp([{ disconnect: "mid-stream" }, { events: successTurn }], probe),
    );
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([0]);
    expect(new Set(probe.calls.map((call) => call.providerTurnId))).toEqual(
      new Set([providerTurnId]),
    );
    // turnNo unchanged across attempts: exactly one Turn row, same manifest.
    expect(r.turns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.manifest_id).toMatch(/^mft_/u);
    expect(r.failure).toMatchObject({
      _tag: "ProviderFailure",
      kind: "StreamInterrupted",
    });
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "TerminalFailure",
        providerErrorKind: "StreamInterrupted",
      },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).toBeNull();
    // Streaming deltas never enter Session history (DID §9.8): the crashed
    // mid-stream attempt left no partial durable output — resume is clean
    // by construction.
    expect(r.entries).toBe(0);
  });

  it("PD3 [crash-injected]: terminal class → no transport retry, dangling Turn never settles the Execution; recovery marks the Turn failed with no retry plan", async () => {
    expect(
      labeled("PD3-terminal-no-transport-retry", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        // AuthenticationFailed is terminal for the Turn (P3 `06` §2).
        const failure = yield* Effect.flip(
          runtime.runTurn(runTurnInput(providerTurnId)),
        );
        const attempts = yield* attemptRows(providerTurnId);
        const turnsBefore = yield* turnRows;
        const execution = yield* executionSettlement;
        // Crash window: the worker died after the terminal attempt was
        // recorded, before any driver disposition of the dangling Turn.
        const report = yield* recover();
        const turnsAfter = yield* turnRows;
        const executionAfter = yield* executionSettlement;
        return {
          failure,
          attempts,
          turnsBefore,
          execution,
          report,
          turnsAfter,
          executionAfter,
        };
      }),
      makeApp([{ terminal: "AuthenticationFailed" }], probe),
    );
    expect(r.failure._tag).toBe("ProviderFailure");
    if (r.failure._tag === "ProviderFailure") {
      expect(r.failure.kind).toBe("AuthenticationFailed");
    }
    // No transport retry for terminal classes.
    expect(probe.calls).toHaveLength(1);
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "TerminalFailure",
        providerErrorKind: "AuthenticationFailed",
      },
    ]);
    // The Turn dangles (driver decides), and a terminal Turn failure does
    // NOT itself settle the Execution Failed.
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsBefore[0]!.settled_at).toBeNull();
    expect(r.execution).toBeNull();
    // Recovery decision table, terminal row: failure mark, no resume.
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe(
      "AuthenticationFailed",
    );
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.exhausted).toBe(false);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsAfter[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsAfter[0]!.finish_reason).toBe("Failed");
    // Recovery never invents an Execution settlement (P2 `06` §4).
    expect(r.executionAfter).toBeNull();
  });

  it("PD4/I-7 [crash-injected]: daemon crash leaves the Turn unsettled → recovery plans resume-by-retry on the SAME Turn (attempt_no = MAX+1 / 0 for a no-attempt leftover); never calls the provider", async () => {
    expect(
      labeled("PD4-crash-resume-same-turn", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash leftovers: turn A died mid-stream after one recorded
        // interrupted attempt; turn B died before any attempt persisted.
        yield* openDanglingTurn(providerTurnId, [
          {
            attemptNo: 0,
            kind: "StreamInterrupted",
            resumeGuaranteed: true,
          },
        ]);
        yield* openDanglingTurn(providerTurnIdB);
        const report = yield* recover();
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        expect(probe.calls).toHaveLength(0);
        const planA = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnId,
        );
        const planB = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnIdB,
        );
        if (planA === undefined || planB === undefined) {
          throw new Error("recovery did not provide both retry plans");
        }
        const runtime = yield* ProviderRuntime;
        yield* runtime.runTurn({
          ...recoveryRunTurnInput(planA),
          recovery: {
            manifestId: planA.manifestId,
            nextAttemptNo: planA.nextAttemptNo,
            retryDecision: planA.retryDecision,
            ...(planA.continuationCheckpoint === undefined
              ? {}
              : { continuationCheckpoint: planA.continuationCheckpoint }),
          },
        });
        yield* runtime.runTurn({
          ...recoveryRunTurnInput(planB),
          recovery: {
            manifestId: planB.manifestId,
            nextAttemptNo: planB.nextAttemptNo,
            retryDecision: planB.retryDecision,
          },
        });
        const attempts = yield* attemptRows(providerTurnId);
        const attemptsB = yield* attemptRows(providerTurnIdB);
        const settled = yield* turnRows;
        return {
          report,
          turns,
          execution,
          attempts,
          attemptsB,
          settled,
          recoveryDecisions: yield* recoveryDecisionRows(providerTurnId),
          recoveryDecisionsB: yield* recoveryDecisionRows(providerTurnIdB),
        };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    // Resume-by-retry plan: same Turn identity + same Manifest (no new
    // Manifest — a resumed Turn is a transport retry, not a new model
    // decision); next attempt_no = MAX+1, Turn-local; the no-attempt
    // leftover plans attempt 0.
    expect(r.report.failedTurns).toEqual([]);
    const planA = r.report.retryPlan.find(
      (entry) => entry.providerTurnId === providerTurnId,
    );
    const planB = r.report.retryPlan.find(
      (entry) => entry.providerTurnId === providerTurnIdB,
    );
    expect(planA?.manifestId).toBe(manifestIdFor(providerTurnId));
    expect(planA?.retryDecision.safety).toBe("SafeResume");
    expect(planA?.retryDecision.strategy).toBe("Resume");
    expect(planA?.nextAttemptNo).toBe(1);
    expect(planA?.lastProviderErrorKind).toBe("StreamInterrupted");
    expect(planB?.nextAttemptNo).toBe(0);
    expect(planB?.lastProviderErrorKind).toBeNull();
    expect(r.recoveryDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProviderFailure",
        cause_detail: "StreamInterrupted",
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
        retry_reason: expect.stringContaining("StreamInterrupted retry"),
      },
    ]);
    expect(r.recoveryDecisionsB).toEqual([
      {
        attempt_no: -1,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "SafeReplay",
        retry_decision: "Retry",
        retry_strategy: "Replay",
        retry_reason: expect.stringContaining("ProcessLost retry"),
      },
    ]);
    // The recovery pass itself never called the provider and minted no new
    // Turn rows (transport retry is never an extra model round).
    expect(probe.calls.map((call) => call.providerTurnId)).toEqual([
      providerTurnId,
      providerTurnIdB,
    ]);
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([1, 0]);
    expect(r.turns).toHaveLength(2);
    expect(r.turns.map((turn) => turn.provider_turn_id).sort()).toEqual(
      [providerTurnId, providerTurnIdB].sort(),
    );
    // Recovery leaves the Execution Active for Scheduler re-dispatch.
    expect(r.execution).toBeNull();
    // The resumed transport retry lands under the SAME Turn and settles it
    // with the per-Turn usage aggregate (I-7).
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "StreamInterrupted",
      },
      { attemptNo: 1, outcome: "Success", providerErrorKind: null },
    ]);
    expect(r.attemptsB).toEqual([
      { attemptNo: 0, outcome: "Success", providerErrorKind: null },
    ]);
    const resumed = r.settled.find(
      (turn) => turn.provider_turn_id === providerTurnId,
    );
    expect(resumed?.settled_at).not.toBeNull();
    expect(resumed?.finish_reason).toBe("Stop");
    // Gate C C1: usage_json now carries the five-field canonical model
    // (null semantics — this turn reported input/output only).
    expect(JSON.parse(resumed?.usage_json ?? "{}")).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("PD4 [crash-injected]: ProcessLost fails closed with incomplete evidence and resumes only from a complete durable checkpoint", async () => {
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // biome-ignore lint/correctness/noUnusedVariables: destructured for interface symmetry
        const incompleteFixture = yield* openDanglingTurn(providerTurnIdC, [
          { attemptNo: 0, inProgress: true },
        ]);
        const resumableFixture = yield* openDanglingTurn(providerTurnIdD, [
          {
            attemptNo: 0,
            inProgress: true,
            resumeGuaranteed: true,
          },
        ]);
        const report = yield* recover();
        const incompleteFailure = report.failedTurns.find(
          (entry) => entry.providerTurnId === providerTurnIdC,
        );
        const plan = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnIdD,
        );
        if (incompleteFailure === undefined || plan === undefined) {
          throw new Error("ProcessLost recovery evidence was not classified");
        }
        expect(incompleteFailure.providerErrorKind).toBeNull();
        expect(incompleteFailure.retryDecision).toMatchObject({
          safety: "UnsafeReplay",
          decision: "Stop",
          strategy: null,
        });
        expect(report.retryPlan.map((entry) => entry.providerTurnId)).toEqual([
          providerTurnIdD,
        ]);
        expect(plan.manifestId).toBe(manifestIdFor(providerTurnIdD));
        expect(plan.manifestJson).toBe(resumableFixture.manifestJson);
        expect(plan.portableRequestJson).toBe(
          resumableFixture.portableRequestJson,
        );
        expect(plan.nextAttemptNo).toBe(1);
        expect(plan.retryDecision).toMatchObject({
          safety: "SafeResume",
          decision: "Retry",
          strategy: "Resume",
        });
        expect(plan.retryDecision.reason).toMatch(/^ProcessLost retry:/u);

        const expectedCheckpoint: ProviderContinuationCheckpoint = {
          cursor: "cursor-0",
          canonicalEventPrefixJson: JSON.stringify([
            {
              _tag: "TurnStarted",
              providerTurnId: providerTurnIdD,
              attemptNo: 0,
              modelRef: "provider-fake",
            },
            { _tag: "TextDelta", text: "partial" },
          ]),
          deliveredPosition: 0,
          resumeGuaranteed: true,
        };
        expect(plan.continuationCheckpoint).toEqual(expectedCheckpoint);

        const recoveryInput = recoveryRunTurnInput(plan);
        expect(recoveryInput.manifestJson).toBe(resumableFixture.manifestJson);
        expect(JSON.stringify(recoveryInput.request)).toBe(
          resumableFixture.portableRequestJson,
        );
        expect(recoveryInput.recovery).toEqual({
          manifestId: plan.manifestId,
          nextAttemptNo: 1,
          retryDecision: plan.retryDecision,
          continuationCheckpoint: expectedCheckpoint,
        });

        const runtime = yield* ProviderRuntime;
        const result = yield* runtime.runTurn(recoveryInput);
        return {
          report,
          incompleteFailure,
          plan,
          result,
          attempts: yield* attemptRows(providerTurnIdD),
          incompleteDecisions: yield* recoveryDecisionRows(providerTurnIdC),
          resumableDecisions: yield* recoveryDecisionRows(providerTurnIdD),
        };
      }),
      makeApp([{ events: successTurn }], probe),
    );

    expect(r.report.retryPlan).toHaveLength(1);
    expect(r.report.failedTurns).toHaveLength(1);
    expect(r.incompleteFailure.providerErrorKind).toBeNull();
    expect(r.plan.retryDecision.reason).toMatch(/^ProcessLost retry:/u);
    expect(r.incompleteDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "UnsafeReplay",
        retry_decision: "Stop",
        retry_strategy: null,
        retry_reason:
          "durable observation is incomplete or proves replay may duplicate effects",
      },
    ]);
    expect(r.resumableDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
        retry_reason: expect.stringContaining("ProcessLost retry"),
      },
    ]);
    expect(r.result.attemptNo).toBe(1);
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: null,
      },
      { attemptNo: 1, outcome: "Success", providerErrorKind: null },
    ]);
    expect(probe.calls).toEqual([
      {
        providerTurnId: providerTurnIdD,
        attemptNo: 1,
        requestJson: r.plan.portableRequestJson,
        continuationCheckpoint: r.plan.continuationCheckpoint,
      },
    ]);
  });

  it("I-6 [crash-injected]: bounded retries exhausted → the Turn settles failed (driver Turn-failure semantics), the Execution stays unsettled", async () => {
    expect(
      labeled("I-6-retry-budget-exhausted-failure-mark", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash window: all three safe-retry attempts exhausted with a
        // retryable kind; the worker died before the driver disposed.
        yield* openDanglingTurn(providerTurnId, [
          { attemptNo: 0, kind: "RateLimited" },
          { attemptNo: 1, kind: "RateLimited" },
          { attemptNo: 2, kind: "RateLimited" },
        ]);
        const report = yield* recover();
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        return { report, turns, execution };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe("RateLimited");
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.exhausted).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.markedBy).toEqual(principal);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.finish_reason).toBe("Failed");
    // Execution-level disposition follows P2 `06` §4 — recovery never
    // invents a settlement.
    expect(r.execution).toBeNull();
    expect(probe.calls).toHaveLength(0);
    void Exit;
    void Cause;
  });
});
