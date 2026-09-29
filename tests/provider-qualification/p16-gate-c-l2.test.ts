import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import type { CanonicalProviderEvent } from "../../packages/ports/src/provider.js";

const { ProviderRuntime } = await import(
  "../../packages/ports/dist/provider.js"
);

import {
  ClockLive,
  IdGeneratorLive,
  P16_MIGRATIONS,
  ProviderTurnStoreLive,
  runMigrations,
  layer as sqliteLayer,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { providerFakeAdapter } from "../../adapters/provider-fake/src/index.js";
import { ProviderRuntimeLive } from "../../packages/provider-runtime/dist/runtime.js";
import { FixedSecretStoreLive } from "../../packages/testkit/src/index.js";

/**
 * P16 Gate C — L2 qualification layer (controlled transport + real
 * ProviderRuntime + durable persistence). Evidence for the L1/L2 entries of
 * the qualification runner: usage aggregation end-to-end and the
 * reportsCacheTokens gate enforced by the runtime.
 */

const SEED_IDS = {
  projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789e3",
  workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789e3",
  sessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789e2",
  executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789e2",
};

const seedForeignKeys = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          SEED_IDS.projectId,
          "p16c",
          SEED_IDS.workspaceId,
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
        [SEED_IDS.sessionId, "WorkspacePrimary", SEED_IDS.workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          SEED_IDS.workspaceId,
          SEED_IDS.projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          SEED_IDS.sessionId,
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
          SEED_IDS.executionId,
          SEED_IDS.projectId,
          "workspace",
          SEED_IDS.workspaceId,
          "coordination",
          SEED_IDS.sessionId,
          "t",
        ],
      );
    }),
  );
});

const makeApp = (
  events: ReadonlyArray<CanonicalProviderEvent>,
  runtimeConfig: Parameters<typeof ProviderRuntimeLive>[0] = {},
) => {
  const base = sqliteLayer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const providerLayer = providerFakeAdapter.layerFor({
    transportOverride: { events },
  });
  return Layer.mergeAll(
    infra,
    Layer.provide(
      ProviderRuntimeLive(runtimeConfig),
      Layer.mergeAll(
        providerLayer,
        Layer.provide(ProviderTurnStoreLive, infra),
        Layer.provide(TransactionPortLive, infra),
        FixedSecretStoreLive(),
        infra,
      ),
    ),
    Layer.provide(ProviderTurnStoreLive, infra),
  );
};

const runTurn = (app: ReturnType<typeof makeApp>) =>
  Effect.gen(function* () {
    yield* runMigrations(P16_MIGRATIONS);
    yield* seedForeignKeys;
    const runtime = yield* ProviderRuntime;
    const run = yield* runtime.runTurn({
      providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2" as never,
      executionId: SEED_IDS.executionId as never,
      sessionId: SEED_IDS.sessionId as never,
      contextEpoch: 0 as never,
      modelRef: "model-fake",
      outputContractRef: "completion-claim-v1",
      manifestJson: JSON.stringify({
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2" as never,
        executionId: SEED_IDS.executionId,
        sessionId: SEED_IDS.sessionId,
        contextEpoch: 0,
        modelRef: "model-fake",
        outputContractRef: "completion-claim-v1",
        compiledRequestHash: "p16-l2",
      }),
      request: {
        modelRef: "model-fake",
        instructions: [],
        messages: [{ role: "user", text: "q" }],
        toolDefinitions: [],
        outputContractRef: "completion-claim-v1",
        budget: { maxOutputTokens: 64 },
        cacheHints: [],
      },
    });
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ usage_json: string | null }>(
      "SELECT usage_json FROM provider_turns WHERE settled_at IS NOT NULL",
    );
    return {
      events: run.events.length,
      usage: rows[0]?.usage_json ?? null,
    };
  }).pipe((program) =>
    Effect.runPromise(Effect.provide(program as never, app as never) as never),
  );

describe("P16 Gate C L2 — usage aggregation end-to-end", () => {
  it("settleTurn persists the five-field canonical usage with null semantics", {
    timeout: 20_000,
  }, async () => {
    const app = makeApp([
      {
        _tag: "TurnStarted",
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2" as never,
        attemptNo: 0,
        modelRef: "model-fake",
      },
      { _tag: "TextDelta", text: "answer" },
      {
        _tag: "UsageReported",
        inputTokens: 21,
        outputTokens: 9,
        reasoningTokens: 4,
      },
      { _tag: "TurnCompleted", finishReason: "Stop" },
    ]);
    const result = (await runTurn(app)) as {
      events: number;
      usage: string | null;
    };
    expect(result.events).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
    expect(JSON.parse(result.usage ?? "{}")).toEqual({
      inputTokens: 21,
      outputTokens: 9,
      reasoningTokens: 4,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("INV-C1-2: cache emission under reportsCacheTokens=false fails the attempt closed", {
    timeout: 20_000,
  }, async () => {
    const app = makeApp(
      [
        {
          _tag: "TurnStarted",
          providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789e2" as never,
          attemptNo: 0,
          modelRef: "model-fake",
        },
        { _tag: "TextDelta", text: "answer" },
        {
          _tag: "UsageReported",
          inputTokens: 21,
          outputTokens: 9,
          cacheReadTokens: 5,
        },
        { _tag: "TurnCompleted", finishReason: "Stop" },
      ],
      { adapterUsageConstraints: { reportsCacheTokens: false } },
    );
    const outcome = await runTurn(app).then(
      (value) => value,
      (error) => error,
    );
    expect(
      JSON.stringify(outcome).includes("usage-cache-capability-violation"),
    ).toBe(true);
  });
});
