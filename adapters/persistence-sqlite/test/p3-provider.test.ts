import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
} from "@arbor/domain";
import {
  Clock,
  ProviderRuntime,
  ProviderTurnStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProviderRuntimeLive } from "../../../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../../../packages/testkit/src/index.js";
import { FakeProviderLive } from "../../provider-fake/src/index.js";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P14_MIGRATIONS,
  P15_MIGRATIONS,
  P17_MIGRATIONS,
  ProviderTurnStoreLive,
  RuntimeClockLive,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const makeApp = (script: Parameters<typeof FakeProviderLive>[0]) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    FakeProviderLive(script),
    Layer.provide(
      ProviderRuntimeLive(),
      Layer.mergeAll(
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(ProviderTurnStoreLive, infra),
        FakeProviderLive(script),
        FixedSecretStoreLive(),
        infra,
      ),
    ),
  );
  return Layer.mergeAll(infra, deps);
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "coordination",
          sessionId,
          "t",
        ],
      );
    }),
  );
});

const request = {
  modelRef: "model-a",
  instructions: [],
  messages: [],
  toolDefinitions: [],
  outputContractRef: "agent-directive-v1",
  budget: { maxOutputTokens: 64 },
  cacheHints: [],
};

const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const manifestJson = JSON.stringify({
  providerTurnId,
  executionId,
  sessionId,
  contextEpoch: 0,
  modelRef: "model-a",
  instructionFragments: [],
  contextRefs: [],
  skillRefs: [],
  toolRefs: [],
  toolRoutes: [],
  outputContractRef: "agent-directive-v1",
  budgetDecision: { maxOutputTokens: 64 },
  compiledRequestHash: "compiled-hash-only-content-identity",
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "auth",
    environmentRevision: "0",
  },
});

const runTurn = (providerTurnId: string) =>
  Effect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    const turnId = parse(ProviderTurnId)(providerTurnId);
    return yield* runtime.runTurn({
      providerTurnId: turnId,
      executionId,
      sessionId,
      contextEpoch: parse(ContextEpochNumber)(0),
      modelRef: "model-a",
      outputContractRef: "agent-directive-v1",
      manifestJson: manifestJson.replaceAll(
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
        providerTurnId,
      ),
      request,
    });
  });

const events = [
  {
    _tag: "TurnStarted" as const,
    providerTurnId: parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
    ),
    attemptNo: 0,
    modelRef: "model-a",
  },
  { _tag: "TextDelta" as const, text: "hello" },
  { _tag: "UsageReported" as const, inputTokens: 1, outputTokens: 2 },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

describe("P3 ProviderRuntime + fake provider", () => {
  it("atomically settles success and replays the validated durable result", async () => {
    const app = makeApp({ events });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const result = yield* runTurn("ptn_018f2b3c-4d5e-7abc-8def-0123456789a1");
      const tx = yield* TransactionPort;
      const store = yield* ProviderTurnStore;
      const replay = yield* tx.transact(
        store.findSettledResult(providerTurnId),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        attempt_outcome: string;
        turn_settled_at: string | null;
        success_evidence_version: string | null;
      }>(
        "SELECT pa.outcome AS attempt_outcome, pt.settled_at AS turn_settled_at, pa.success_evidence_version AS success_evidence_version FROM provider_attempts pa JOIN provider_turns pt ON pt.provider_turn_id = pa.provider_turn_id WHERE pa.provider_turn_id = ?",
        [providerTurnId],
      );
      return { result, replay, row: rows[0] };
    });

    const output = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    const typed = output as {
      result: { events: ReadonlyArray<unknown> };
      replay: {
        _tag: string;
        canonicalEvents?: ReadonlyArray<unknown>;
        evidenceVersion?: string;
      };
      row: {
        attempt_outcome: string;
        turn_settled_at: string | null;
        success_evidence_version: string | null;
      };
    };
    expect(typed.replay._tag).toBe("SettledSuccess");
    expect(typed.replay.canonicalEvents).toEqual(typed.result.events);
    expect(typed.replay.evidenceVersion).toBe("provider-success-v1");
    expect(typed.row.attempt_outcome).toBe("Success");
    expect(typed.row.turn_settled_at).not.toBeNull();
    expect(typed.row.success_evidence_version).toBe("provider-success-v1");
  });

  it("streams the frozen ADT and records the turn/attempt", async () => {
    const app = makeApp({ events });
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      const result = yield* runTurn("ptn_018f2b3c-4d5e-7abc-8def-0123456789a1");
      const sql = yield* SqlClient;
      const turns = yield* sql.unsafe<{ finish_reason: string | null }>(
        "SELECT finish_reason FROM provider_turns",
      );
      const attempts = yield* sql.unsafe<{ outcome: string }>(
        "SELECT outcome FROM provider_attempts",
      );
      const manifests = yield* sql.unsafe<{
        manifest_id: string;
        compiled_request_hash: string;
        manifest_json: string;
      }>(
        "SELECT manifest_id, compiled_request_hash, manifest_json FROM model_context_manifests",
      );
      return { result, turns, attempts, manifests };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect(
      (r as { result: { events: ReadonlyArray<unknown> } }).result.events,
    ).toHaveLength(4);
    expect(
      (r as { turns: ReadonlyArray<{ finish_reason: string | null }> }).turns[0]
        ?.finish_reason,
    ).toBe("Stop");
    expect(
      (r as { attempts: ReadonlyArray<{ outcome: string }> }).attempts.map(
        (a) => a.outcome,
      ),
    ).toEqual(["Success"]);
    expect(
      (
        r as {
          manifests: ReadonlyArray<{
            manifest_id: string;
            compiled_request_hash: string;
            manifest_json: string;
          }>;
        }
      ).manifests,
    ).toHaveLength(1);
    const persistedManifest = (
      r as {
        manifests: ReadonlyArray<{
          manifest_id: string;
          compiled_request_hash: string;
          manifest_json: string;
        }>;
      }
    ).manifests[0];
    expect(persistedManifest?.manifest_id).toMatch(/^mft_/u);
    expect(persistedManifest?.manifest_id).not.toBe(
      persistedManifest?.compiled_request_hash,
    );
    expect(JSON.parse(persistedManifest?.manifest_json ?? "{}")).toMatchObject({
      providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
      compiledRequestHash: "compiled-hash-only-content-identity",
    });
  });

  it("retries a retryable failure and records both attempts", async () => {
    const app = makeApp({ events, failures: ["ProviderUnavailable"] });
    const program = Effect.gen(function* () {
      yield* runMigrations(P15_MIGRATIONS);
      yield* seed;
      yield* runTurn("ptn_018f2b3c-4d5e-7abc-8def-0123456789a1");
      const sql = yield* SqlClient;
      const attempts = yield* sql.unsafe<{ outcome: string }>(
        "SELECT outcome FROM provider_attempts ORDER BY attempt_no",
      );
      return attempts.map((a) => a.outcome);
    });
    const attempts = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect(attempts).toEqual(["RetryableFailure", "Success"]);
    void Clock;
    void ProviderTurnStore;
    void TransactionPort;
  });

  it("preserves historical failure labels as legacy-v1 without reclassifying old rows", async () => {
    const app = makeApp({});
    const historicalTurnId = parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P14_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const store = yield* ProviderTurnStore;
      yield* tx.transact(
        store.startTurn(
          {
            providerTurnId: historicalTurnId,
            executionId,
            sessionId,
            contextEpoch: parse(ContextEpochNumber)(0),
            modelRef: "model-a",
            outputContractRef: "agent-directive-v1",
            manifestId: "legacy-manifest-id",
          },
          "2026-09-28T00:00:00.000Z",
        ),
      );
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, transport_metadata_json) VALUES (?,?,?,?,?,?,NULL)",
        [
          historicalTurnId,
          0,
          "2026-09-28T00:00:01.000Z",
          "2026-09-28T00:00:02.000Z",
          "TerminalFailure",
          "ProtocolViolation",
        ],
      );
      yield* runMigrations(P15_MIGRATIONS);
      const rows = yield* sql.unsafe<{
        outcome: string;
        provider_error_kind: string | null;
        failure_taxonomy_version: string;
        observation_json: string;
      }>(
        "SELECT outcome, provider_error_kind, failure_taxonomy_version, observation_json FROM provider_attempts WHERE provider_turn_id = ?",
        [historicalTurnId],
      );
      return rows[0];
    });
    const row = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect(row).toMatchObject({
      outcome: "TerminalFailure",
      provider_error_kind: "ProtocolViolation",
      failure_taxonomy_version: "legacy-v1",
    });
    expect(
      JSON.parse((row as { observation_json: string }).observation_json),
    ).toEqual({
      responseStarted: null,
      canonicalEventEmitted: null,
      consumerVisibleOutput: null,
      toolCallProposed: null,
      continuationAvailable: null,
      externalEffectPossible: null,
    });
  });
});
