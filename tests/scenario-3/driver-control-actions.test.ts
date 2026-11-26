import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P17_MIGRATIONS,
  P19_MIGRATIONS,
} from "../../adapters/persistence-sqlite/src/index.js";
import type { AgentActionHandler } from "../../packages/agent-runtime/src/index.js";
import { decideSessionProjection } from "../../packages/model-context/src/index.js";
import {
  type RuntimeSafetyGateService,
  SessionRepository,
  TransactionPort,
} from "../../packages/ports/src/index.js";

import {
  allowGate,
  drive,
  driveAndCount,
  executionId,
  makeApp,
  readToolTurn,
  run,
  runMigrations,
  seed,
  sendMessageTurn,
  sessionId,
  workspaceId,
} from "./support.js";

const invalidSendMessageTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c0",
    toolName: "send_message",
    argumentsJson: JSON.stringify({
      kind: "Query",
      recipientWorkspaceId: String(workspaceId),
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];
describe("agent driver", () => {
  it("persists a control settlement in the action ledger before returning", async () => {
    const app = makeApp([sendMessageTurn("settle now")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{
        state: string;
        settlement_ref: string | null;
      }>(
        "SELECT state, settlement_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, actions, stepState: steps[0]?.state };
    });

    const result = await run(program, app);
    expect(result.settlement._tag).toBe("Completed");
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "Applied",
        settlement_ref: expect.stringMatching(/^settlement_/),
      }),
    ]);
    expect(result.stepState).toBe("SettlementProposed");
  });
  it("keeps an OutcomeUnknown action pending reconciliation instead of marking it applied", async () => {
    const recoverySequence: string[] = [];
    const actionResultBoundaries: Array<{
      readonly boundary: string;
      readonly executionId?: string;
      readonly callRef?: string;
    }> = [];
    const escalationCalls: Array<{
      readonly executionId: string;
      readonly fenceExecutionId: string;
      readonly invocationRefs: ReadonlyArray<string>;
    }> = [];
    const app = makeApp([readToolTurn], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "NonIdempotent",
        },
      ],
      executableHandler: {
        handle: () =>
          Effect.succeed({
            _tag: "Settle" as const,
            settlement: {
              _tag: "OutcomeUnknown" as const,
              reconciliation: {
                _tag: "ReconciliationRequired" as const,
                invocationRefs: ["tin_unknown"],
              },
            },
          }),
      },
      recordReconciliationEscalation: (input) => {
        recoverySequence.push("P9EscalationCommitted");
        escalationCalls.push({
          executionId: input.execution.executionId,
          fenceExecutionId: input.fence.executionId,
          invocationRefs: input.invocationRefs,
        });
        return Effect.void;
      },
      qualificationProbe: async (event) => {
        if (
          event.boundary === "AH7BeforeActionResultCommit" ||
          event.boundary === "AH7AfterActionResultCommit"
        ) {
          recoverySequence.push(event.boundary);
          actionResultBoundaries.push(event);
        }
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ?",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        state: string;
        settlement_json: string | null;
      }>(
        "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, actions, step: steps[0] };
    });

    const result = await run(program, app);
    expect(result.settlement._tag).toBe("OutcomeUnknown");
    expect(escalationCalls).toEqual([
      {
        executionId,
        fenceExecutionId: executionId,
        invocationRefs: ["tin_unknown"],
      },
    ]);
    expect(recoverySequence).toEqual([
      "P9EscalationCommitted",
      "AH7BeforeActionResultCommit",
      "AH7AfterActionResultCommit",
    ]);
    expect(actionResultBoundaries).toEqual([
      expect.objectContaining({
        boundary: "AH7BeforeActionResultCommit",
        executionId,
        callRef: "c1",
      }),
      expect.objectContaining({
        boundary: "AH7AfterActionResultCommit",
        executionId,
        callRef: "c1",
      }),
    ]);
    expect(result.actions).toEqual([{ state: "ReconciliationPending" }]);
    expect(result.step).toEqual(
      expect.objectContaining({
        state: "SettlementProposed",
        settlement_json: expect.stringContaining("OutcomeUnknown"),
      }),
    );
  });
  it("returns invalid control arguments to the model and accepts a corrected action", async () => {
    const progressAtProviderBoundary: Array<boolean | undefined> = [];
    const gate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          progressAtProviderBoundary.push(observation?.durableProgress);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const app = makeApp([
      invalidSendMessageTurn,
      sendMessageTurn("corrected question"),
    ]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const driven = yield* driveAndCount(gate);
        const sql = yield* SqlClient;
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence",
        );
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY logical_step_no, action_index",
          [executionId],
        );
        return { ...driven, results, actions };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.turns).toBe(2);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c0",
      actionKind: "send_message",
      status: "Failed",
      disposition: "ModelCorrectable:InvalidControlArguments",
    });
    expect(result.actions[0]).toMatchObject({
      state: "Applied",
      disposition_json: expect.stringContaining(
        "ModelCorrectable:InvalidControlArguments",
      ),
    });
    expect(progressAtProviderBoundary).toEqual([false, false]);
  });
  it("returns a semantic action rejection to the model without hiding it as an exception", async () => {
    let attempts = 0;
    const progressAtProviderBoundary: Array<boolean | undefined> = [];
    const gate: RuntimeSafetyGateService = {
      admitActivity: (_executionId, activity, observation) => {
        if (
          activity._tag === "ProviderTurn" &&
          observation?.inFlight !== "end"
        ) {
          progressAtProviderBoundary.push(observation?.durableProgress);
        }
        return Effect.succeed("Continue" as const);
      },
    };
    const handler: AgentActionHandler = {
      action: "SendMessage",
      handle: () => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail({
              _tag: "AgentActionRejected" as const,
              code: "action/target-unavailable" as const,
              safeMessage: "the selected recipient is not currently available",
              correction: "ChooseAlternative" as const,
            })
          : Effect.succeed({
              _tag: "Settle" as const,
              settlement: {
                _tag: "Completed" as const,
                result: { _tag: "CoordinationCompleted" as const },
              },
            });
      },
    };
    const app = makeApp(
      [
        sendMessageTurn("unavailable target", "c0"),
        sendMessageTurn("alternative target", "c1"),
      ],
      { controlHandlers: [handler] },
    );
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const driven = yield* driveAndCount(gate);
        const sql = yield* SqlClient;
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence",
        );
        return { ...driven, results };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.turns).toBe(2);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c0",
      status: "Failed",
      disposition: "ModelUsable:action/target-unavailable",
      outputText: expect.stringContaining("selected recipient"),
    });
    expect(progressAtProviderBoundary).toEqual([false, false]);
  });
  it("closes a rejected control call with a durable ControlResult before interruption", async () => {
    const rejectingHandler: AgentActionHandler = {
      action: "SendMessage",
      handle: () =>
        Effect.fail({
          _tag: "AgentActionOperationalFailure" as const,
          operation: "test.injected-handler-failure",
          cause: "not applicable to this execution",
        }),
    };
    const app = makeApp([sendMessageTurn("cannot route")], {
      controlHandlers: [rejectingHandler],
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
          [executionId],
        );
        const steps = yield* sql.unsafe<{
          state: string;
          settlement_json: string | null;
        }>(
          "SELECT state, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
          [executionId],
        );
        const timeline = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
        }>(
          "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ControlResult') ORDER BY sequence",
        );
        return { settlement, actions, steps, timeline };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { reason: "ControlActionHandlerRejected" },
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "TerminalRejected",
        disposition_json: expect.stringContaining("HandlerRejected"),
      }),
    ]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        state: "SettlementProposed",
        settlement_json: expect.stringContaining(
          "ControlActionHandlerRejected",
        ),
      }),
    ]);
    expect(result.timeline.map((entry) => entry.item_type)).toEqual([
      "ToolCall",
      "ControlResult",
    ]);
    expect(JSON.parse(result.timeline[1]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      callRef: "c1",
      status: "Denied",
      disposition: "HandlerRejected",
    });
  });
  it("turns a changed control registration into a typed stale result", async () => {
    const app = makeApp([sendMessageTurn("stale")], {
      turnProfileResolver: {
        resolve: () =>
          Effect.succeed({
            purpose: "WorkspaceWork",
            profileVersion: "turn-profile-v1",
            outputContractRef: "tool-invocation-v1",
            executableTools: [],
            controlTools: [
              {
                stableId: "core.control.send-message",
                name: "send_message",
                description: "stale registration",
                schemaJson: "{}",
                version: "1",
                hash: "stale-hash",
                requiredCapability: "agent:communicate",
              },
            ],
            contextPolicyRef: "workspace-coordination-context-v1",
            fingerprint: "tpf_stale",
          }),
      },
    });
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{
          state: string;
          disposition_json: string | null;
        }>(
          "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ?",
          [executionId],
        );
        const results = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult'",
        );
        return { settlement, actions, results };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { reason: "StaleToolRegistration" },
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        state: "TerminalRejected",
        disposition_json: expect.stringContaining("StaleToolRegistration"),
      }),
    ]);
    expect(JSON.parse(result.results[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      status: "Denied",
      disposition: "StaleToolRegistration",
    });
  });
  it("pairs every call when the first control action settles and later calls are skipped", async () => {
    const twoCalls = [
      ...sendMessageTurn("first").slice(0, 1),
      {
        _tag: "ToolCallProposed" as const,
        callRef: "c2",
        toolName: "send_message",
        argumentsJson: JSON.stringify({
          kind: "Query",
          body: "second",
          recipientWorkspaceId: String(workspaceId),
        }),
      },
      { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
    ];
    const app = makeApp([twoCalls]);
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const settlement = yield* drive(allowGate);
        const sql = yield* SqlClient;
        const actions = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
          [executionId],
        );
        const timeline = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
        }>(
          "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ControlResult') ORDER BY sequence",
        );
        return { settlement, actions, timeline };
      }),
      app,
    );

    expect(result.settlement._tag).toBe("Completed");
    expect(result.actions).toEqual([
      { state: "Applied" },
      { state: "SkippedEarlySettlement" },
    ]);
    const results = result.timeline
      .filter((entry) => entry.item_type === "ControlResult")
      .map((entry) => JSON.parse(entry.payload_json));
    expect(results).toEqual([
      expect.objectContaining({ callRef: "c1", status: "Succeeded" }),
      expect.objectContaining({
        callRef: "c2",
        status: "Interrupted",
        disposition: "SkippedEarlySettlement",
      }),
    ]);
  });
  it("repairs a dangling call from an ended execution before the next Provider turn", async () => {
    const app = makeApp([sendMessageTurn("frontier repaired")]);
    const originatingProviderTurnId =
      "ptn_exe_018f2b3c-4d5e-7abc-8def-0123456789a9_0";
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P19_MIGRATIONS);
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            sessionId,
            0,
            "ModelOutput",
            "ToolCall",
            2,
            0,
            JSON.stringify({
              _tag: "ToolCall",
              providerTurnId: originatingProviderTurnId,
              callRef: "dangling",
              toolRef: "read",
              argumentsRef: "inline:test",
              argumentsJson: "{}",
            }),
            "t",
            "ProviderTurnCall",
            `${originatingProviderTurnId}:dangling`,
            "hash-dangling",
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
        const repaired = yield* sql.unsafe<{
          item_type: string;
          payload_json: string;
          source_kind: string | null;
          source_ref: string | null;
        }>(
          "SELECT item_type, payload_json, source_kind, source_ref FROM session_entries WHERE session_id = ? AND item_type = 'ToolResult' ORDER BY sequence",
          [sessionId],
        );
        const sessions = yield* SessionRepository;
        const tx = yield* TransactionPort;
        const frontier = yield* tx.transact(
          sessions.listRecentEntries(sessionId, 64),
        );
        return {
          settlement,
          step: steps[0],
          repaired,
          projectionDecision: decideSessionProjection(frontier),
        };
      }),
      app,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      settlement_json: expect.stringContaining("CoordinationCompleted"),
    });
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]?.source_kind).toBe("SessionFrontierRepair");
    expect(result.repaired[0]?.source_ref).toMatch(
      new RegExp(
        `^session-frontier-repair:v1:${executionId}:${originatingProviderTurnId}:[0-9a-f]{64}$`,
      ),
    );
    expect(JSON.parse(result.repaired[0]?.payload_json ?? "{}")).toMatchObject({
      _tag: "ToolResult",
      callRef: "dangling",
      status: "Interrupted",
    });
    expect(result.projectionDecision._tag).toBe("Ready");
  });
});
