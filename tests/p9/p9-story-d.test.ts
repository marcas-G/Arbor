import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
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
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  type ProviderPortEvent,
  ProviderRuntime,
  ProviderTurnStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../packages/testkit/src/index.js";
import { labeled } from "../support/p9-harness-api.js";
import { durableFile, runOn } from "./support.js";

// ---------------------------------------------------------------------------
// Story D wiring: the p9-provider-disconnect app (disconnect-injecting
// ProviderPort double + ProviderRuntime retry bound).
// ---------------------------------------------------------------------------

const D_PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789d3");
const D_WORKSPACE = "ws_018f2b3c-4d5e-7abc-8def-0123456789d3";
const D_SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789d3");
const D_EXECUTION = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d3",
) as ExecutionId;
const dManifestIdFor = (turnId: ProviderTurnId) => `mf_story_d_${turnId}`;
const D_PRINCIPAL = parse(Principal)("runtime:system");

const D_TURN_A = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const D_TURN_B = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d4",
);
const D_TURN_C = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d5",
);
const D_TURN_D = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789d6",
);

type DAttemptScript =
  | {
      readonly disconnect: "pre-connect" | "mid-stream";
    }
  | { readonly events: ReadonlyArray<CanonicalProviderEvent> };

interface DProbe {
  readonly calls: Array<{
    readonly providerTurnId: ProviderTurnId;
    readonly attemptNo: number;
  }>;
}

const dProviderFailure = (kind: ProviderFailureKind): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind,
  taxonomyVersion: "phase1-v2",
});

const dCanonical = (event: CanonicalProviderEvent): ProviderPortEvent => ({
  _tag: "Canonical",
  event,
});

const dPreflight: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: false, externalEffectPossible: false },
};
const dResponseStarted: ProviderPortEvent = {
  _tag: "Observation",
  delta: { responseStarted: true },
};

const dSuccessTurn = (
  turnId: ProviderTurnId,
): ReadonlyArray<CanonicalProviderEvent> => [
  {
    _tag: "TurnStarted",
    providerTurnId: turnId,
    attemptNo: 0,
    modelRef: "provider-fake",
  },
  { _tag: "TextDelta", text: "final" },
  { _tag: "UsageReported", inputTokens: 10, outputTokens: 5 },
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

/** Deterministic disconnect-injecting ProviderPort double keyed by turn id
 * (p9-provider-disconnect DisconnectProviderLive pattern, per-turn
 * scripts). */
const DisconnectProviderLive = (
  scriptByTurn: ReadonlyArray<{
    readonly turnId: ProviderTurnId;
    readonly script: ReadonlyArray<DAttemptScript>;
  }>,
  probe: DProbe,
): Layer.Layer<ProviderPort> =>
  Layer.effect(
    ProviderPort,
    Effect.sync(() => {
      const callsByTurn = new Map<ProviderTurnId, number>();
      return ProviderPort.of({
        runTurn: (input) => {
          const turnId = input.context.providerTurnId;
          const attemptNo = input.context.attemptNo;
          probe.calls.push({ providerTurnId: turnId, attemptNo });
          const call = callsByTurn.get(turnId) ?? 0;
          callsByTurn.set(turnId, call + 1);
          const script =
            scriptByTurn.find((entry) => entry.turnId === turnId)?.script ?? [];
          const step: DAttemptScript = script[
            Math.min(call, script.length - 1)
          ] ?? { events: [] };
          if ("disconnect" in step) {
            if (step.disconnect === "pre-connect") {
              return Stream.concat(
                Stream.fromIterable([dPreflight]),
                Stream.fail(dProviderFailure("TransportFailed")),
              );
            }
            const boundary: CanonicalProviderEvent = {
              _tag: "TurnStarted",
              providerTurnId: turnId,
              attemptNo,
              modelRef: input.request.modelRef,
            };
            return Stream.concat(
              Stream.fromIterable([
                dPreflight,
                dResponseStarted,
                dCanonical(boundary),
                dCanonical({
                  _tag: "TextDelta" as const,
                  text: "partial-delta",
                }),
              ]),
              Stream.fail(dProviderFailure("StreamInterrupted")),
            );
          }
          return Stream.fromIterable([
            dPreflight,
            dResponseStarted,
            ...step.events.map(dCanonical),
          ]);
        },
      });
    }),
  );

const makeStoryDApp = (
  scriptByTurn: ReadonlyArray<{
    readonly turnId: ProviderTurnId;
    readonly script: ReadonlyArray<DAttemptScript>;
  }>,
  probe: DProbe,
  filename: string,
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(),
    Layer.mergeAll(
      DisconnectProviderLive(scriptByTurn, probe),
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

const seedStoryD = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          D_PROJECT,
          "p9-accept-d",
          D_WORKSPACE,
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
        [D_SESSION, D_EXECUTION],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'w','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active','t','t')",
        [D_WORKSPACE, D_PROJECT, D_SESSION],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
        [D_EXECUTION, D_PROJECT, D_WORKSPACE, D_SESSION],
      );
    }),
  );
});

const dRunTurnInput = (turnId: ProviderTurnId) => ({
  providerTurnId: turnId,
  executionId: D_EXECUTION,
  sessionId: D_SESSION,
  contextEpoch: 0 as never,
  modelRef: "provider-fake",
  outputContractRef: "oc",
  manifestJson: JSON.stringify({
    providerTurnId: turnId,
    executionId: D_EXECUTION,
    sessionId: D_SESSION,
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
      authorizationDigest: "p9-story-d",
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

const dAttemptRows = (turnId: ProviderTurnId) =>
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
    return rows.map((row) => ({
      attemptNo: Number(row.attempt_no),
      outcome: row.outcome,
      providerErrorKind: row.provider_error_kind,
    }));
  });

const dTurnRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{
    provider_turn_id: string;
    manifest_id: string;
    settled_at: string | null;
    finish_reason: string | null;
    usage_json: string | null;
  }>(
    "SELECT provider_turn_id, manifest_id, settled_at, finish_reason, usage_json FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
    [D_EXECUTION],
  );
});

const dOpenDanglingTurn = (
  turnId: ProviderTurnId,
  crashedAttempts: ReadonlyArray<{
    readonly attemptNo: number;
    readonly kind: "StreamInterrupted" | "RateLimited" | "ProviderUnavailable";
    readonly resumeGuaranteed?: boolean;
  }>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    const manifestJson = JSON.stringify({
      providerTurnId: turnId,
      executionId: D_EXECUTION,
      sessionId: D_SESSION,
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
        authorizationDigest: "p9-story-d",
        environmentRevision: "0",
      },
    });
    const portableRequestJson = JSON.stringify(dRunTurnInput(turnId).request);
    yield* tx.transact(
      turns.startTurnWithManifest(
        {
          providerTurnId: turnId,
          executionId: D_EXECUTION,
          sessionId: D_SESSION,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId: dManifestIdFor(turnId),
          executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY,
          turnDeadlineAt: "2999-01-01T00:00:00.000Z",
        },
        manifestJson,
        portableRequestJson,
        "t",
      ),
    );
    for (const attempt of crashedAttempts) {
      const observation =
        attempt.kind === "StreamInterrupted"
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
  });

const dRecover = () =>
  Effect.gen(function* () {
    const turns = yield* ProviderTurnStore;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    return yield* recoverUnsettledProviderTurns(
      { turns, tx, clock },
      D_PROJECT,
      D_PRINCIPAL,
    );
  });

const dExecutionSettlement = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
    "SELECT settlement_kind FROM executions WHERE execution_id = ?",
    [D_EXECUTION],
  );
  return rows[0] === undefined ? "missing" : rows[0].settlement_kind;
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story D (06 §D) [crash-injected]: safe pre-response replay, unsafe mid-stream replay rejection, and verified cursor recovery share one policy", async () => {
    expect(
      labeled("story-D-provider-disconnect", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: DProbe = { calls: [] };
    await runOn(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seedStoryD;
        const runtime = yield* ProviderRuntime;
        // Pre-response TransportFailed has complete no-effect evidence and
        // is retried under the same ProviderTurn.
        const { events: eventsA } = yield* runtime.runTurn(
          dRunTurnInput(D_TURN_A),
        );
        expect(eventsA.some((event) => event._tag === "TurnCompleted")).toBe(
          true,
        );
        // Mid-stream output without a verified resume cursor is UnsafeReplay.
        const midStreamFailure = yield* Effect.flip(
          runtime.runTurn(dRunTurnInput(D_TURN_B)),
        );
        expect(midStreamFailure).toMatchObject({
          _tag: "ProviderFailure",
          kind: "StreamInterrupted",
        });
        // Crash leftovers: turn C exhausted its retry bound, turn D died
        // mid-stream after one recorded attempt.
        yield* dOpenDanglingTurn(D_TURN_C, [
          { attemptNo: 0, kind: "RateLimited" },
          { attemptNo: 1, kind: "RateLimited" },
          { attemptNo: 2, kind: "RateLimited" },
        ]);
        yield* dOpenDanglingTurn(D_TURN_D, [
          {
            attemptNo: 0,
            kind: "StreamInterrupted",
            resumeGuaranteed: true,
          },
        ]);
        const report = yield* dRecover();
        const turnsAfter = yield* dTurnRows;
        const settlement = yield* dExecutionSettlement;
        // The recovery pass never called the provider (4 live calls: three
        // SafeReplay attempts and one unsafe mid-stream attempt).
        expect(probe.calls).toHaveLength(4);
        expect(
          probe.calls
            .filter((call) => call.providerTurnId === D_TURN_A)
            .map((call) => call.attemptNo),
        ).toEqual([0, 1, 2]);
        expect(
          probe.calls
            .filter((call) => call.providerTurnId === D_TURN_B)
            .map((call) => call.attemptNo),
        ).toEqual([0]);
        // PD1 retries only after durable no-response/no-effect observations.
        expect(yield* dAttemptRows(D_TURN_A)).toEqual([
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
        expect(yield* dAttemptRows(D_TURN_B)).toEqual([
          {
            attemptNo: 0,
            outcome: "TerminalFailure",
            providerErrorKind: "StreamInterrupted",
          },
        ]);
        // Same Turn identity + same Manifest across every retry and every
        // recovery disposition (turnNo invariant).
        expect(turnsAfter).toHaveLength(4);
        expect(
          turnsAfter.find((turn) => turn.provider_turn_id === D_TURN_A)
            ?.manifest_id,
        ).toMatch(/^mft_/u);
        expect(
          turnsAfter.find((turn) => turn.provider_turn_id === D_TURN_B)
            ?.manifest_id,
        ).toMatch(/^mft_/u);
        const settledA = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_A,
        );
        const settledB = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_B,
        );
        expect(settledA?.settled_at).not.toBeNull();
        expect(settledA?.finish_reason).toBe("Stop");
        expect(settledB?.settled_at).not.toBeNull();
        expect(settledB?.finish_reason).toBe("Failed");
        // Bound exhausted and unsafe in-flight attempts fail closed.
        expect(report.retryPlan.map((entry) => entry.providerTurnId)).toEqual([
          D_TURN_D,
        ]);
        expect(report.failedTurns).toHaveLength(2);
        expect(
          report.failedTurns.map((entry) => entry.providerTurnId).sort(),
        ).toEqual([D_TURN_B, D_TURN_C].sort());
        expect(
          report.failedTurns.find((entry) => entry.providerTurnId === D_TURN_C)
            ?.exhausted,
        ).toBe(true);
        const turnC = turnsAfter.find(
          (turn) => turn.provider_turn_id === D_TURN_C,
        );
        expect(turnC?.settled_at).not.toBeNull();
        expect(turnC?.finish_reason).toBe("Failed");
        // Unsettled-turn recovery: same Turn, new Attempt, Manifest intact.
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        const planD = report.retryPlan[0]!;
        expect(planD.manifestId).toBe(dManifestIdFor(D_TURN_D));
        expect(planD.nextAttemptNo).toBe(1);
        expect(planD.lastProviderErrorKind).toBe("StreamInterrupted");
        expect(planD.retryDecision.safety).toBe("SafeResume");
        expect(planD.retryDecision.strategy).toBe("Resume");
        // Recovery never invents an Execution settlement.
        expect(settlement).toBeNull();
        // The resumed transport retry lands under the SAME Turn and
        // settles it with the per-Turn usage aggregate.
        const tx = yield* TransactionPort;
        const store = yield* ProviderTurnStore;
        yield* tx.transact(
          store.recordAttempt(
            D_TURN_D,
            planD.nextAttemptNo,
            { _tag: "Success" },
            "t2",
            "t3",
          ),
        );
        yield* tx.transact(
          store.settleTurn(
            D_TURN_D,
            "Stop",
            JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
            "t3",
          ),
        );
        const resumed = (yield* dTurnRows).find(
          (turn) => turn.provider_turn_id === D_TURN_D,
        );
        expect(resumed?.settled_at).not.toBeNull();
        expect(resumed?.finish_reason).toBe("Stop");
        expect(JSON.parse(resumed?.usage_json ?? "{}")).toEqual({
          inputTokens: 10,
          outputTokens: 5,
        });
        expect(yield* dAttemptRows(D_TURN_D)).toEqual([
          {
            attemptNo: 0,
            outcome: "RetryableFailure",
            providerErrorKind: "StreamInterrupted",
          },
          { attemptNo: 1, outcome: "Success", providerErrorKind: null },
        ]);
      }),
      makeStoryDApp(
        [
          {
            turnId: D_TURN_A,
            script: [
              { disconnect: "pre-connect" },
              { disconnect: "pre-connect" },
              { events: dSuccessTurn(D_TURN_A) },
            ],
          },
          {
            turnId: D_TURN_B,
            script: [
              { disconnect: "mid-stream" },
              { events: dSuccessTurn(D_TURN_B) },
            ],
          },
        ],
        probe,
        durableFile("d"),
      ),
    );
  });
});
