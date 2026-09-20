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
import { FakeProviderLive } from "../../provider-fake/src/index.js";
import {
  ClockLive,
  layer,
  P3_MIGRATIONS,
  ProviderTurnStoreLive,
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
  const infra = Layer.mergeAll(base, ClockLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    FakeProviderLive(script),
    Layer.provide(
      ProviderRuntimeLive(3),
      Layer.mergeAll(
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(ProviderTurnStoreLive, infra),
        FakeProviderLive(script),
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

const runTurn = (providerTurnId: string) =>
  Effect.gen(function* () {
    const runtime = yield* ProviderRuntime;
    return yield* runtime.runTurn({
      providerTurnId: parse(ProviderTurnId)(providerTurnId),
      executionId,
      sessionId,
      contextEpoch: parse(ContextEpochNumber)(0),
      modelRef: "model-a",
      outputContractRef: "agent-directive-v1",
      manifestId: "man-1",
      request,
      secretRef: "secret-1",
      timeoutMs: 1000,
      cancellationRef: "cancel-1",
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
  it("streams the frozen ADT and records the turn/attempt", async () => {
    const app = makeApp({ events });
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
      yield* seed;
      const result = yield* runTurn("ptn_018f2b3c-4d5e-7abc-8def-0123456789a1");
      const sql = yield* SqlClient;
      const turns = yield* sql.unsafe<{ finish_reason: string | null }>(
        "SELECT finish_reason FROM provider_turns",
      );
      const attempts = yield* sql.unsafe<{ outcome: string }>(
        "SELECT outcome FROM provider_attempts",
      );
      return { result, turns, attempts };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((r as { result: ReadonlyArray<unknown> }).result).toHaveLength(4);
    expect(
      (r as { turns: ReadonlyArray<{ finish_reason: string | null }> }).turns[0]
        ?.finish_reason,
    ).toBe("Stop");
    expect(
      (r as { attempts: ReadonlyArray<{ outcome: string }> }).attempts.map(
        (a) => a.outcome,
      ),
    ).toEqual(["Success"]);
  });

  it("retries a retryable failure and records both attempts", async () => {
    const app = makeApp({ events, failures: ["ProviderUnavailable"] });
    const program = Effect.gen(function* () {
      yield* runMigrations(P3_MIGRATIONS);
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
});
