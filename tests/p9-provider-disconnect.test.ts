import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P8_MIGRATIONS,
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
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  ProviderRuntime,
  ProviderTurnStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
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
const manifestId = "mf_p9_pd";
const principal = parse(Principal)("runtime:system");

/** GQ4 frozen mapping (04 §2.1): classify by the observable boundary —
 * `TurnStarted` emitted or not — never by transport errno. */
const classifyDisconnect = (sawTurnStarted: boolean): ProviderFailureKind =>
  sawTurnStarted ? "StreamInterrupted" : "ProviderUnavailable";

type AttemptScript =
  | { readonly disconnect: "pre-connect" | "mid-stream" }
  | { readonly terminal: ProviderFailureKind }
  | { readonly events: ReadonlyArray<CanonicalProviderEvent> };

interface ProviderProbe {
  readonly calls: Array<{
    readonly providerTurnId: ProviderTurnId;
    readonly attemptNo: number;
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
});

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
          });
          const entry: AttemptScript = script[
            Math.min(call, script.length - 1)
          ] ?? { events: [] };
          call += 1;
          if ("disconnect" in entry) {
            if (entry.disconnect === "pre-connect") {
              // connect refused / DNS / TLS / pre-flight timeout — nothing
              // observable emitted before the failure.
              const transportError = new Error("connect ECONNREFUSED");
              void transportError;
              return Stream.fail(providerFailure(classifyDisconnect(false)));
            }
            // mid-stream: the boundary event WAS emitted, then the break.
            const boundary: CanonicalProviderEvent = {
              _tag: "TurnStarted",
              providerTurnId: input.context.providerTurnId,
              attemptNo,
              modelRef: input.request.modelRef,
            };
            return Stream.concat(
              Stream.fromIterable([
                boundary,
                { _tag: "TextDelta" as const, text: "partial-delta" },
              ]),
              Stream.fail(providerFailure(classifyDisconnect(true))),
            );
          }
          if ("terminal" in entry) {
            return Stream.fail(providerFailure(entry.terminal));
          }
          return Stream.fromIterable(entry.events);
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
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      DisconnectProviderLive(script, probe),
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
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
  yield* runMigrations(P8_MIGRATIONS);
  yield* seed;
});

const runTurnInput = (turnId: ProviderTurnId) => ({
  providerTurnId: turnId,
  executionId,
  sessionId,
  contextEpoch: 0 as never,
  modelRef: "provider-fake",
  outputContractRef: "oc",
  manifestId,
  request: {
    modelRef: "provider-fake",
    instructions: [],
    messages: [{ role: "user" as const, text: "go" }],
    toolDefinitions: [],
    outputContractRef: "oc",
    budget: { maxOutputTokens: 128 },
    cacheHints: [],
  },
  secretRef: "secret",
  timeoutMs: 30_000,
  cancellationRef: "cancel",
});

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
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
  return Number(rows[0]!.count);
});

/** Recovery face under test (deps injected from the same app layers). */
const recover = (options?: { readonly maxAttempts?: number }) =>
  Effect.gen(function* () {
    const turns = yield* ProviderTurnStore;
    const tx = yield* TransactionPort;
    const clock = yield* Clock;
    return yield* recoverUnsettledProviderTurns(
      { turns, tx, clock },
      projectId,
      principal,
      options,
    );
  });

/** Crash-window seed: the worker opened the Turn (intent + Manifest
 * persisted before the request, P3 `04` §3) and died — optionally after
 * recording N failed attempts — leaving the Turn unsettled. */
const openDanglingTurn = (
  turnId: ProviderTurnId,
  crashedAttempts: ReadonlyArray<{
    readonly attemptNo: number;
    readonly kind: "StreamInterrupted" | "RateLimited" | "ProviderUnavailable";
  }> = [],
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const turns = yield* ProviderTurnStore;
    yield* tx.transact(
      turns.startTurn(
        {
          providerTurnId: turnId,
          executionId,
          sessionId,
          contextEpoch: 0 as never,
          modelRef: "provider-fake",
          outputContractRef: "oc",
          manifestId,
        },
        "t",
      ),
    );
    for (const attempt of crashedAttempts) {
      yield* tx.transact(
        turns.recordAttempt(
          turnId,
          attempt.attemptNo,
          { _tag: "RetryableFailure", providerErrorKind: attempt.kind },
          "t0",
          "t1",
        ),
      );
    }
  });

describe("p9-provider-disconnect (PD1–PD4 / I-4..I-7, 02 §6 + 04 §2)", () => {
  it("PD1/I-4 [crash-injected]: pre-connection disconnect → ProviderUnavailable RetryableFailure, retried under the SAME Turn, no new ProviderTurn, turnNo unchanged", async () => {
    expect(
      labeled("PD1-pre-connection-ProviderUnavailable", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        const events = yield* runtime.runTurn(runTurnInput(providerTurnId));
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
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    expect(r.turns[0]!.manifest_id).toBe(manifestId);
    // I-4: RetryableFailure + provider_error_kind = ProviderUnavailable on
    // the failed attempts; the final attempt succeeds and settles the Turn.
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "ProviderUnavailable",
      },
      {
        attemptNo: 1,
        outcome: "RetryableFailure",
        providerErrorKind: "ProviderUnavailable",
      },
      { attemptNo: 2, outcome: "Success", providerErrorKind: null },
    ]);
    expect(r.turns[0]!.settled_at).not.toBeNull();
    expect(r.turns[0]!.finish_reason).toBe("Stop");
    expect(r.events.some((event) => event._tag === "TurnCompleted")).toBe(true);
    expect(r.entries).toBe(0);
  });

  it("PD2/I-5 [crash-injected]: mid-stream disconnect → StreamInterrupted, retried under the SAME Turn, append-only attempt history, no partial Session entry", async () => {
    expect(
      labeled("PD2-mid-stream-StreamInterrupted", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        yield* runtime.runTurn(runTurnInput(providerTurnId));
        const attempts = yield* attemptRows(providerTurnId);
        const turns = yield* turnRows;
        const entries = yield* sessionEntryCount;
        return { attempts, turns, entries };
      }),
      makeApp([{ disconnect: "mid-stream" }, { events: successTurn }], probe),
    );
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([0, 1]);
    expect(new Set(probe.calls.map((call) => call.providerTurnId))).toEqual(
      new Set([providerTurnId]),
    );
    // turnNo unchanged across attempts: exactly one Turn row, same manifest.
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    expect(r.turns[0]!.manifest_id).toBe(manifestId);
    // Attempt history append-only: the interrupted attempt AND the
    // successful retry both remain recorded.
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "StreamInterrupted",
      },
      { attemptNo: 1, outcome: "Success", providerErrorKind: null },
    ]);
    expect(r.turns[0]!.settled_at).not.toBeNull();
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
    expect(r.turnsBefore[0]!.settled_at).toBeNull();
    expect(r.execution).toBeNull();
    // Recovery decision table, terminal row: failure mark, no resume.
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe(
      "AuthenticationFailed",
    );
    expect(r.report.failedTurns[0]!.exhausted).toBe(false);
    expect(r.turnsAfter[0]!.settled_at).not.toBeNull();
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
          { attemptNo: 0, kind: "StreamInterrupted" },
        ]);
        yield* openDanglingTurn(providerTurnIdB);
        const report = yield* recover();
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        // The driver resumes the dangling Turn as a transport retry under
        // the same providerTurnId + manifestId: new attempt, turn settle.
        const tx = yield* TransactionPort;
        const store = yield* ProviderTurnStore;
        yield* tx.transact(
          store.recordAttempt(
            providerTurnId,
            report.retryPlan[0]!.nextAttemptNo,
            { _tag: "Success" },
            "t2",
            "t3",
          ),
        );
        yield* tx.transact(
          store.settleTurn(
            providerTurnId,
            "Stop",
            JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
            "t3",
          ),
        );
        const attempts = yield* attemptRows(providerTurnId);
        const settled = yield* turnRows;
        return { report, turns, execution, attempts, settled };
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
    expect(planA?.manifestId).toBe(manifestId);
    expect(planA?.nextAttemptNo).toBe(1);
    expect(planA?.lastProviderErrorKind).toBe("StreamInterrupted");
    expect(planB?.nextAttemptNo).toBe(0);
    expect(planB?.lastProviderErrorKind).toBeNull();
    // The recovery pass itself never called the provider and minted no new
    // Turn rows (transport retry is never an extra model round).
    expect(probe.calls).toHaveLength(0);
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
    const resumed = r.settled.find(
      (turn) => turn.provider_turn_id === providerTurnId,
    );
    expect(resumed?.settled_at).not.toBeNull();
    expect(resumed?.finish_reason).toBe("Stop");
    expect(JSON.parse(resumed?.usage_json ?? "{}")).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
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
        const report = yield* recover({ maxAttempts: 3 });
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        return { report, turns, execution };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe("RateLimited");
    expect(r.report.failedTurns[0]!.exhausted).toBe(true);
    expect(r.report.failedTurns[0]!.markedBy).toEqual(principal);
    expect(r.turns[0]!.settled_at).not.toBeNull();
    expect(r.turns[0]!.finish_reason).toBe("Failed");
    // Execution-level disposition follows P2 `06` §4 — recovery never
    // invents a settlement.
    expect(r.execution).toBeNull();
    expect(probe.calls).toHaveLength(0);
    void Exit;
    void Cause;
  });
});
