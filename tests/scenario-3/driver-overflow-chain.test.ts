import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P19_MIGRATIONS,
  P20_MIGRATIONS,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  ProviderRuntime,
  type RuntimeSafetyGateService,
} from "../../packages/ports/src/index.js";

import {
  allowGate,
  drive,
  executionId,
  makeApp,
  run,
  runMigrations,
  seed,
  sendMessageTurn,
  sessionId,
} from "./support.js";

describe("agent driver", () => {
  it("reads classification from the highest terminal attempt, not an earlier attempt", async () => {
    const app = makeApp([]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_mixed_failure",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "RetryableFailure",
            "ContextLimitExceeded",
            "phase1-v2",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            1,
            "t2",
            "t3",
            "TerminalFailure",
            "RequestRejected",
            "phase1-v2",
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result).toMatchObject({
      _tag: "Success",
      value: {
        _tag: "Failed",
        failure: {
          _tag: "ExecutionFailure",
          reason: "ProviderTurnSettled:Failed",
        },
      },
    });
  });
  it.each([
    { label: "missing kind", failureKind: null, taxonomy: "phase1-v2" },
    {
      label: "unsupported legacy taxonomy",
      failureKind: "ContextLimitExceeded",
      taxonomy: "legacy-v1",
    },
  ])("fails closed for a terminal attempt with $label", async (input) => {
    const app = makeApp([]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_unclassified_failure",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "TerminalFailure",
            input.failureKind,
            input.taxonomy,
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain('"stage":"ProviderReplay"');
  });
  it.each([
    {
      label: "retry-budget-exhausted RetryableFailure",
      finishReason: "Failed",
      outcome: "RetryableFailure",
      failureKind: "RateLimited",
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:Failed",
    },
    {
      label: "Cancelled attempt",
      finishReason: "Cancelled",
      outcome: "Cancelled",
      failureKind: "Cancelled",
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:Cancelled",
    },
    {
      label: "TimedOut attempt without provider error kind",
      finishReason: "TurnDeadline",
      outcome: "TimedOut",
      failureKind: null,
      taxonomy: "phase1-v2",
      expectedReason: "ProviderTurnSettled:TurnDeadline",
    },
  ])("preserves settled ProviderTurn semantics for $label", async (input) => {
    const app = makeApp([], {
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: () => Effect.die("a settled ProviderTurn must not be called"),
      }),
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const providerTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            providerTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_terminal_attempt",
            "t",
            "t2",
            input.finishReason,
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            providerTurnId,
            0,
            "t",
            "t2",
            input.outcome,
            input.failureKind,
            input.taxonomy,
          ],
        );
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Success");
    expect(JSON.stringify(result)).toContain(input.expectedReason);
  });
  it("fails closed when explicit overflow evidence has no P20 chain table", async () => {
    const app = makeApp([], { providerFailures: ["ContextLimitExceeded"] });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        return yield* Effect.exit(drive(allowGate));
      }),
      app,
    );

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain('"stage":"LoopStepStore"');
    expect(JSON.stringify(result)).toContain(
      '"sourceTag":"PersistenceUnavailable"',
    );
  });
  it("uses one persisted overflow chain and replacement inference", async () => {
    const operations: string[] = [];
    const manifestIdentities: Array<{ kind: string; hash: string }> = [];
    const admittedProviderFingerprints: Array<string> = [];
    const providerRuntime = Layer.succeed(ProviderRuntime, {
      runTurn: (input) => {
        const manifest = JSON.parse(input.manifestJson) as {
          operationKind?: string;
          compiledRequestHash: string;
        };
        const operation =
          input.request.requestVersion === 2
            ? input.request.operationKind
            : "Inference";
        operations.push(operation);
        manifestIdentities.push({
          kind: manifest.operationKind ?? "Inference",
          hash: manifest.compiledRequestHash,
        });
        if (operations.length === 1) {
          return Effect.fail({
            _tag: "ProviderFailure" as const,
            kind: "ContextLimitExceeded" as const,
          });
        }
        if (operation === "CompactionSummary") {
          return Effect.succeed({
            attemptNo: 0,
            retryDecisions: [],
            events: [
              { _tag: "TextDelta" as const, text: "compact state" },
              { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
            ],
          });
        }
        return Effect.succeed({
          attemptNo: 0,
          retryDecisions: [],
          events: [
            {
              _tag: "TurnStarted" as const,
              providerTurnId: input.providerTurnId,
              attemptNo: 0,
              modelRef: input.modelRef,
            },
            ...sendMessageTurn("replacement complete"),
          ],
        });
      },
    });
    const gate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          admittedProviderFingerprints.push(activity.fingerprint);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const app = makeApp([], { providerRuntime });
    const program = Effect.gen(function* () {
      yield* runMigrations(P20_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(gate);
      const sql = yield* SqlClient;
      const links = yield* sql.unsafe<{
        role: string;
        overflow_ordinal: number;
      }>(
        "SELECT role, overflow_ordinal FROM agent_loop_step_provider_turns ORDER BY role",
      );
      return { settlement, links };
    });
    const result = await run(program, app);
    expect(result.settlement, JSON.stringify(result)).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(operations).toEqual(["Inference", "CompactionSummary", "Inference"]);
    expect(admittedProviderFingerprints).toEqual(
      manifestIdentities.map(
        ({ kind, hash }) => `provider-turn:${kind}:${hash}`,
      ),
    );
    expect(result.links).toHaveLength(3);
    expect(new Set(result.links.map((link) => link.role))).toEqual(
      new Set(["Inference", "OverflowCompaction", "OverflowReplacement"]),
    );
    expect(result.links.every((link) => link.overflow_ordinal === 0)).toBe(
      true,
    );
  });
  it("reconstructs an empty ordinal-0 chain from durable ContextLimit evidence", async () => {
    const app = makeApp([
      [
        { _tag: "TextDelta", text: "recovered compact state" },
        { _tag: "TurnCompleted", finishReason: "Stop" },
      ],
      sendMessageTurn("replacement complete"),
    ]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P20_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        const inferenceProviderTurnId = `ptn_${executionId}_0`;
        yield* sql.unsafe(
          "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
          [
            inferenceProviderTurnId,
            executionId,
            sessionId,
            0,
            "model-a",
            "tool-invocation-v1",
            "mft_context_overflow",
            "t",
            "t2",
            "Failed",
            "{}",
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version) VALUES (?,?,?,?,?,?,?)",
          [
            inferenceProviderTurnId,
            0,
            "t",
            "t2",
            "TerminalFailure",
            "ContextLimitExceeded",
            "phase1-v2",
          ],
        );
        const settlement = yield* Effect.exit(drive(allowGate));
        const links = yield* sql.unsafe<{
          role: string;
          overflow_ordinal: number;
          provider_turn_id: string;
          predecessor_provider_turn_id: string | null;
          context_epoch: number;
        }>(
          "SELECT role, overflow_ordinal, provider_turn_id, predecessor_provider_turn_id, context_epoch FROM agent_loop_step_provider_turns WHERE execution_id = ? ORDER BY CASE role WHEN 'Inference' THEN 0 WHEN 'OverflowCompaction' THEN 1 ELSE 2 END",
          [executionId],
        );
        const turns = yield* sql.unsafe<{
          provider_turn_id: string;
        }>(
          "SELECT provider_turn_id FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
          [executionId],
        );
        const attempts = yield* sql.unsafe<{
          attempt_no: number;
        }>(
          "SELECT attempt_no FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
          [inferenceProviderTurnId],
        );
        return { settlement, links, turns, attempts };
      }),
      app,
    );

    const inferenceProviderTurnId = `ptn_${executionId}_0`;
    const compactionProviderTurnId = `ptn_${executionId}_0_compact_0`;
    const replacementProviderTurnId = `ptn_${executionId}_0_overflow_0`;
    expect(result.settlement._tag).toBe("Success");
    expect(JSON.stringify(result.settlement)).toContain(
      '"_tag":"CoordinationCompleted"',
    );
    expect(result.links).toEqual([
      {
        role: "Inference",
        overflow_ordinal: 0,
        provider_turn_id: inferenceProviderTurnId,
        predecessor_provider_turn_id: null,
        context_epoch: 0,
      },
      {
        role: "OverflowCompaction",
        overflow_ordinal: 0,
        provider_turn_id: compactionProviderTurnId,
        predecessor_provider_turn_id: inferenceProviderTurnId,
        context_epoch: 0,
      },
      {
        role: "OverflowReplacement",
        overflow_ordinal: 0,
        provider_turn_id: replacementProviderTurnId,
        predecessor_provider_turn_id: compactionProviderTurnId,
        context_epoch: 1,
      },
    ]);
    expect(result.turns.map((turn) => turn.provider_turn_id)).toEqual([
      inferenceProviderTurnId,
      compactionProviderTurnId,
      replacementProviderTurnId,
    ]);
    expect(result.attempts).toEqual([{ attempt_no: 0 }]);
  });
});
