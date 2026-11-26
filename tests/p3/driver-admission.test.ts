import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P17_MIGRATIONS } from "../../adapters/persistence-sqlite/src/index.js";
import { ModelContext } from "../../packages/model-context/src/index.js";
import {
  PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING,
  type ProviderRunInput,
  ProviderRuntime,
  type RuntimeSafetyGateService,
} from "../../packages/ports/src/index.js";

import {
  allowGate,
  drive,
  executionId,
  makeApp,
  projectId,
  run,
  runMigrations,
  seed,
  sendMessageTurn,
  sessionId,
  textTurn,
  workspaceId,
} from "./support.js";

describe("P3-013 agent driver", () => {
  it("admits a compiled ProviderTurn immediately before ProviderRuntime and proves Stop makes no call", async () => {
    const sequence: Array<string> = [];
    const admissionFingerprints: Array<string> = [];
    let compiledFingerprint: string | undefined;
    let providerCalls = 0;
    const providerRuntime = Layer.succeed(ProviderRuntime, {
      runTurn: (input) => {
        providerCalls += 1;
        sequence.push("provider");
        const manifest = JSON.parse(input.manifestJson) as {
          operationKind: string;
          compiledRequestHash: string;
        };
        compiledFingerprint = `provider-turn:${manifest.operationKind}:${manifest.compiledRequestHash}`;
        return Effect.succeed({
          events: [
            {
              _tag: "TurnStarted" as const,
              providerTurnId: input.providerTurnId,
              attemptNo: 2,
              modelRef: input.request.modelRef,
            },
            ...textTurn,
          ],
          attemptNo: 2,
          retryDecisions: [],
        });
      },
    });
    const app = makeApp([], { providerRuntime });
    const continueGate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          sequence.push("gate");
          admissionFingerprints.push(activity.fingerprint);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const admitted = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(continueGate);
      }),
      app,
    );
    expect(admitted._tag).toBe("Completed");
    expect(sequence.indexOf("gate")).toBeGreaterThanOrEqual(0);
    expect(sequence.indexOf("gate")).toBeLessThan(sequence.indexOf("provider"));
    expect(admissionFingerprints).toEqual([compiledFingerprint]);

    providerCalls = 0;
    let stoppedFingerprint: string | undefined;
    const stopGate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          stoppedFingerprint = activity.fingerprint;
          return Effect.succeed("Stop" as const);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const stoppedApp = makeApp([], { providerRuntime });
    const stopped = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(stopGate);
      }),
      stoppedApp,
    );
    expect(stopped._tag).toBe("Interrupted");
    expect(stoppedFingerprint).toMatch(/^provider-turn:Inference:[0-9a-f]+$/);
    expect(providerCalls).toBe(0);
  });
  it("maps an atomic ProviderTurn stop-fence loss to Interrupted without retry", async () => {
    let providerCalls = 0;
    const providerRuntime = Layer.succeed(ProviderRuntime, {
      runTurn: () => {
        providerCalls += 1;
        return Effect.fail({
          _tag: "ProviderFailure" as const,
          kind: "UnknownProviderFailure" as const,
          safeDiagnostic: PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING,
        });
      },
    });
    const app = makeApp([], { providerRuntime });
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(allowGate);
      }),
      app,
    );

    expect(settlement).toEqual({
      _tag: "Interrupted",
      result: { _tag: "StopRequested" },
    });
    expect(providerCalls).toBe(1);
  });
  it("runs an ordinary Prepared step against the P17 schema without reading overflow links", async () => {
    const app = makeApp([textTurn]);
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(allowGate);
      }),
      app,
    );

    expect(settlement._tag).toBe("Completed");
  });
  it("settles from a durable failed ProviderTurn without calling the provider again", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () => Effect.die("provider must not be called"),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
        [
          `ptn_${executionId}_0`,
          executionId,
          sessionId,
          0,
          "model-a",
          "tool-invocation-v1",
          "mft_failed",
          "t",
          "t2",
          "Failed",
          "{}",
          "t",
        ],
      );
      const settlement = yield* drive(allowGate);
      const steps = yield* sql.unsafe<{
        state: string;
        settlement_json: string | null;
      }>(
        "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, step: steps[0] };
    });

    const result = await run(program, app);
    expect(result.settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderTurnSettled:Failed",
      },
    });
    expect(result.step?.state).toBe("SettlementProposed");
  });
  it("settles an exact InboxEpisode on its first text-only response", async () => {
    const app = makeApp([textTurn, sendMessageTurn("question")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string; entryKey?: string };
    };
    expect(settlement._tag).toBe("Completed");
    expect(settlement.result).toEqual({
      _tag: "InboxInputHandled",
      entryKey: "p3-driver-fixture",
    });
  });
  it("stops at the P2 safety gate", async () => {
    const app = makeApp([textTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive({
        admitActivity: () => Effect.succeed("Stop" as const),
      });
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      result?: { _tag: string; reason?: string };
    };
    expect(settlement._tag).toBe("Interrupted");
    expect(settlement.result?.reason).toBe("RuntimeSafetyStop");

    void ModelContext;
  });
  it("settles a terminal Provider failure and durably proposes the settlement", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderFailure",
            kind: "QuotaExceeded",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "quota-exhausted",
          }),
      }),
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );
    expect(result.settlement).toEqual({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderFailure:QuotaExceeded",
      },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("ProviderFailure:QuotaExceeded"),
    });
  });
  it("settles ContextUnsatisfiable instead of leaking it as a driver exception", async () => {
    const app = makeApp([], {
      modelCapability: {
        modelRef: "model-tiny",
        family: "tiny",
        contextWindow: 64,
        outputCeiling: 16,
        toolProtocol: "json",
      },
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        return { settlement, step: steps[0] };
      }),
      app,
    );
    expect(result.settlement).toEqual({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ContextUnsatisfiable",
      },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("ContextUnsatisfiable"),
    });
  });
  it("settles the execution when a persisted ProviderTurn belongs to a different binding", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "provider-turn-resume-binding-invalid",
          }),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      failure?: { _tag: string; reason?: string };
    };
    expect(settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderTurnBindingChanged",
      },
    });
  });
  it("settles the execution when the ProviderTurn exceeds its stream idle timeout", async () => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () =>
          Effect.fail({
            _tag: "ProviderExecutionTimeout",
            phase: "StreamIdleTimeout",
          }),
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = (await run(program, app)) as {
      _tag: string;
      failure?: { _tag: string; reason?: string };
    };
    expect(settlement).toMatchObject({
      _tag: "Failed",
      failure: {
        _tag: "ExecutionFailure",
        reason: "ProviderExecutionTimedOut:StreamIdleTimeout",
      },
    });
  });
  it("passes deployment execution-policy overrides to every Provider turn", async () => {
    let received: ProviderRunInput | undefined;
    const overrides = {
      streamIdleTimeoutMs: 90_000,
      turnTimeoutMs: 600_000,
    };
    const app = makeApp([], {
      executionPolicyOverrides: overrides,
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          received = input;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...sendMessageTurn("policy received"),
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      return yield* drive(allowGate);
    });
    const settlement = await run(program, app);
    expect(settlement._tag).toBe("Completed");
    expect(received?.executionPolicyOverrides).toEqual(overrides);
  });
  it("captures live project and workspace revisions in the ControlBasis", async () => {
    let received: ProviderRunInput | undefined;
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          received = input;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...sendMessageTurn("basis captured"),
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE projects SET project_policy_revision = 3 WHERE project_id = ?",
          [projectId],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET workspace_policy_revision = 5, responsibility_revision = 7, resource_boundary_revision = 9 WHERE workspace_id = ?",
          [workspaceId],
        );
        return yield* drive(allowGate);
      }),
      app,
    );

    const manifest = JSON.parse(received?.manifestJson ?? "{}") as {
      readonly controlBasis?: Record<string, unknown>;
    };
    expect(manifest.controlBasis).toMatchObject({
      projectPolicyRevision: 3,
      workspacePolicyRevision: 5,
      responsibilityRevision: 7,
      resourceBoundaryRevision: 9,
      environmentRevision: "0",
    });
    expect(manifest.controlBasis?.authorizationDigest).not.toBe("digest");
  });
});
