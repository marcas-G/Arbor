import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P17_MIGRATIONS,
  P19_MIGRATIONS,
} from "../../adapters/persistence-sqlite/src/index.js";
import type { ExecutableInvocationHandler } from "../../packages/agent-runtime/src/index.js";
import {
  type CanonicalProviderEvent,
  type ProviderRunInput,
  ProviderRuntime,
  portableInputItems,
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
  textTurn,
} from "./support.js";

describe("recovery — bounded repair + DecisionStale (B-9)", () => {
  it("routes executable invocations to the executable handler", async () => {
    let invoked = 0;
    const app = makeApp([readToolTurn, sendMessageTurn("read completed")], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "ReadOnly",
        },
      ],
      executableHandler: {
        handle: () => {
          invoked += 1;
          return Effect.succeed({
            _tag: "Observation",
            source: "Tool",
            observation: { text: "read", truncated: false },
          });
        },
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{
        state: string;
        result_ref: string | null;
        observation_source_ref: string | null;
      }>(
        "SELECT state, result_ref, observation_source_ref FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const timeline = yield* sql.unsafe<{
        item_type: string;
        payload_json: string;
      }>(
        "SELECT item_type, payload_json FROM session_entries WHERE item_type IN ('ToolCall','ToolResult','ControlResult','LegacyObservation') ORDER BY sequence",
      );
      return {
        ...driven,
        actions,
        timeline,
      };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(invoked).toBe(1);
    expect(result.turns).toBeGreaterThan(0);
    expect(
      (
        result as typeof result & {
          actions: ReadonlyArray<{
            state: string;
            result_ref: string | null;
            observation_source_ref: string | null;
          }>;
          timeline: ReadonlyArray<{
            item_type: string;
            payload_json: string;
          }>;
        }
      ).actions,
    ).toEqual([
      expect.objectContaining({
        state: "Applied",
        result_ref: expect.stringMatching(/^result_/),
        observation_source_ref: expect.stringMatching(/^observation_/),
      }),
    ]);
    const timeline = (
      result as typeof result & {
        timeline: ReadonlyArray<{
          item_type: string;
          payload_json: string;
        }>;
      }
    ).timeline;
    expect(timeline.map((entry) => entry.item_type)).not.toContain(
      "LegacyObservation",
    );
    const callEntry = timeline.find((entry) => {
      if (entry.item_type !== "ToolCall") return false;
      const payload = JSON.parse(entry.payload_json) as { toolRef?: string };
      return payload.toolRef === "read";
    });
    const call = JSON.parse(callEntry?.payload_json ?? "{}") as {
      callRef?: string;
    };
    const resultEntry = timeline.find(
      (entry) => entry.item_type === "ToolResult",
    );
    const toolResult = JSON.parse(resultEntry?.payload_json ?? "{}") as {
      callRef?: string;
      status?: string;
    };
    expect(toolResult).toMatchObject({
      callRef: call.callRef,
      status: "Succeeded",
    });
  });
  it("rolls back a no-effect Denied ToolResult before commit, then replays the same consumed invocation once", async () => {
    const consumedBy: string[] = [];
    const handlerCalls: string[] = [];
    const denialHandler: ExecutableInvocationHandler = {
      handle: ({ invocation }) => {
        const invocationId = `tin_p3_${invocation.callRef}`;
        handlerCalls.push(invocation.callRef);
        if (consumedBy.length === 0) consumedBy.push(invocationId);
        else expect(consumedBy).toEqual([invocationId]);
        return Effect.succeed({
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: { text: "tool authorization denied", truncated: false },
          status: "Denied" as const,
          disposition: "AuthorizationDenied",
          invocationId: invocationId as never,
        });
      },
    };
    const app = makeApp([readToolTurn, textTurn], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "Idempotent",
        },
      ],
      executableHandler: denialHandler,
      failFirstTerminalRejectedActionTransition: true,
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const first = yield* Effect.exit(drive(allowGate));
      const sql = yield* SqlClient;
      const afterRollback = yield* sql.unsafe<{
        count: number;
        state: string;
        next_action_index: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM session_entries WHERE item_type = 'ToolResult') AS count,
           (SELECT state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS state,
           (SELECT next_action_index FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no LIMIT 1) AS next_action_index`,
        [executionId, executionId],
      );
      const second = yield* Effect.exit(drive(allowGate));
      const committed = yield* sql.unsafe<{
        count: number;
        state: string;
        next_action_index: number;
        result_ref: string | null;
        observation_source_ref: string | null;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM session_entries WHERE item_type = 'ToolResult') AS count,
           (SELECT state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS state,
           (SELECT next_action_index FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no LIMIT 1) AS next_action_index,
           (SELECT result_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS result_ref,
           (SELECT observation_source_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS observation_source_ref`,
        [executionId, executionId, executionId, executionId],
      );
      const timeline = yield* sql.unsafe<{ payload_json: string }>(
        "SELECT payload_json FROM session_entries WHERE item_type = 'ToolResult' ORDER BY sequence",
      );
      return {
        first,
        afterRollback: afterRollback[0],
        second,
        committed: committed[0],
        timeline,
      };
    });

    const result = await run(program, app);
    expect(result.first._tag).toBe("Failure");
    expect(result.afterRollback).toEqual({
      count: 0,
      state: "Pending",
      next_action_index: 0,
    });
    expect(result.second._tag).toBe("Success");
    expect(handlerCalls).toEqual(["c1", "c1"]);
    expect(consumedBy).toEqual(["tin_p3_c1"]);
    expect(result.committed).toEqual({
      count: 1,
      state: "TerminalRejected",
      next_action_index: 1,
      result_ref: expect.stringMatching(/^result_/),
      observation_source_ref: expect.stringMatching(/^observation_/),
    });
    const toolResult = JSON.parse(result.timeline[0]?.payload_json ?? "{}") as {
      observationRef?: string;
      modelOutputRef?: string;
      callRef?: string;
      status?: string;
      invocationId?: string;
    };
    expect(toolResult).toMatchObject({
      _tag: "ToolResult",
      callRef: "c1",
      status: "Denied",
      invocationId: "tin_p3_c1",
    });
    expect(toolResult.observationRef).toBe(
      result.committed?.observation_source_ref,
    );
    expect(toolResult.modelOutputRef).toBe(result.committed?.result_ref);
  });
  it("replays committed no-effect Denied without a second handler call after the post-commit crash seam", async () => {
    let handlerCalls = 0;
    let failAfterCommit = true;
    const invocationId = "tin_p3_committed_denial";
    const app = makeApp([readToolTurn, textTurn], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "Idempotent",
        },
      ],
      executableHandler: {
        handle: ({ invocation }) => {
          handlerCalls += 1;
          return Effect.succeed({
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: "tool authorization denied",
              truncated: false,
            },
            status: "Denied" as const,
            disposition: "AuthorizationDenied",
            invocationId: invocationId as never,
            // The provider/action binding remains the exact same call on replay.
            resultRef: invocation.callRef,
          });
        },
      },
      qualificationProbe: async (event) => {
        if (
          failAfterCommit &&
          event.boundary === "AH7AfterActionResultCommit"
        ) {
          failAfterCommit = false;
          throw new Error("injected after durable Denied projection");
        }
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const first = yield* Effect.exit(drive(allowGate));
      const sql = yield* SqlClient;
      const afterCommit = yield* sql.unsafe<{
        count: number;
        state: string;
        next_action_index: number;
        result_ref: string | null;
        observation_source_ref: string | null;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM session_entries WHERE item_type = 'ToolResult') AS count,
           (SELECT state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS state,
           (SELECT next_action_index FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no LIMIT 1) AS next_action_index,
           (SELECT result_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS result_ref,
           (SELECT observation_source_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1) AS observation_source_ref`,
        [executionId, executionId, executionId, executionId],
      );
      const second = yield* Effect.exit(drive(allowGate));
      const afterReplay = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE item_type = 'ToolResult'",
      );
      return {
        first,
        afterCommit: afterCommit[0],
        second,
        afterReplay: afterReplay[0],
      };
    });

    const result = await run(program, app);
    expect(result.first._tag).toBe("Failure");
    expect(result.afterCommit).toEqual({
      count: 1,
      state: "TerminalRejected",
      next_action_index: 1,
      result_ref: expect.stringMatching(/^result_/),
      observation_source_ref: expect.stringMatching(/^observation_/),
    });
    expect(result.second._tag).toBe("Success");
    expect(result.afterReplay?.count).toBe(1);
    expect(handlerCalls).toBe(1);
  });
  it("converges a NotAdmitted Interrupted ToolResult to StopRequested and skips the rest of the action batch", async () => {
    const twoReads: ReadonlyArray<CanonicalProviderEvent> = [
      {
        _tag: "ToolCallProposed",
        callRef: "c1",
        toolName: "read",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      },
      {
        _tag: "ToolCallProposed",
        callRef: "c2",
        toolName: "read",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      },
      { _tag: "TurnCompleted", finishReason: "ToolCall" },
    ];
    let handlerCalls = 0;
    const app = makeApp([twoReads], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "Idempotent",
        },
      ],
      executableHandler: {
        handle: ({ invocation }) => {
          handlerCalls += 1;
          return Effect.succeed({
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: { text: "execution stopping", truncated: false },
            status: "Interrupted" as const,
            disposition: "ExecutionStopping",
            invocationId: `tin_${invocation.callRef}` as never,
          });
        },
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{
        state: string;
        result_ref: string | null;
        observation_source_ref: string | null;
      }>(
        "SELECT state, result_ref, observation_source_ref FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index",
        [executionId],
      );
      const step = yield* sql.unsafe<{
        state: string;
        next_action_index: number;
        settlement_json: string | null;
      }>(
        "SELECT state, next_action_index, settlement_json FROM agent_loop_steps WHERE execution_id = ?",
        [executionId],
      );
      const results = yield* sql.unsafe<{
        payload_json: string;
        source_ref: string | null;
      }>(
        "SELECT payload_json, source_ref FROM session_entries WHERE item_type = 'ToolResult' ORDER BY sequence",
      );
      return { settlement, actions, step: step[0], results };
    });

    const result = await run(program, app);
    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { _tag: "StopRequested" },
    });
    expect(result.actions.map((action) => action.state)).toEqual([
      "TerminalRejected",
      "SkippedEarlySettlement",
    ]);
    expect(result.actions[0]).toMatchObject({
      result_ref: expect.stringMatching(/^result_/),
      observation_source_ref: expect.stringMatching(/^observation_/),
    });
    expect(result.actions[1]).toMatchObject({
      result_ref: expect.stringMatching(/^result_/),
      observation_source_ref: expect.stringMatching(/^observation_/),
    });
    expect(result.step).toMatchObject({
      state: "SettlementProposed",
      next_action_index: 2,
      settlement_json: expect.stringContaining("StopRequested"),
    });
    expect(
      result.results.map((row) => JSON.parse(row.payload_json).status),
    ).toEqual(["Interrupted", "Interrupted"]);
    const firstToolResult = JSON.parse(
      result.results[0]?.payload_json ?? "{}",
    ) as { observationRef?: string };
    expect(firstToolResult.observationRef).toBe(result.results[0]?.source_ref);
    expect(firstToolResult.observationRef).toBe(
      result.actions[0]?.observation_source_ref,
    );
    expect(handlerCalls).toBe(1);
  });
  it("preserves Control Denied action semantics while closing executable Denied as TerminalRejected", async () => {
    const app = makeApp([sendMessageTurn("denied control"), textTurn], {
      controlAuthorizer: {
        authorize: () =>
          Effect.succeed({ _tag: "Denied" as const, reason: "control denied" }),
        consumeApproval: () => Effect.succeed(false),
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const settlement = yield* drive(allowGate);
      const sql = yield* SqlClient;
      const action = yield* sql.unsafe<{
        state: string;
        disposition_json: string | null;
      }>(
        "SELECT state, disposition_json FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index LIMIT 1",
        [executionId],
      );
      const result = yield* sql.unsafe<{ payload_json: string }>(
        "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence LIMIT 1",
      );
      return { settlement, action: action[0], result: result[0] };
    });

    const result = await run(program, app);
    expect(result.settlement._tag).toBe("Completed");
    expect(result.action).toMatchObject({
      state: "Applied",
      disposition_json: expect.stringContaining("AuthorizationDenied"),
    });
    expect(JSON.parse(result.result?.payload_json ?? "{}")).toMatchObject({
      _tag: "ControlResult",
      status: "Denied",
      disposition: "AuthorizationDenied",
    });
  });
  it("returns a durable executable observation to the next model turn", async () => {
    const requests: ProviderRunInput["request"][] = [];
    let call = 0;
    const observationMarker = "OBSERVATION_RETURN_MARKER";
    const app = makeApp([], {
      toolDefinitions: [
        {
          name: "read",
          description: "Read a file.",
          schemaJson: JSON.stringify({ type: "object" }),
          version: "1",
          hash: "read-v1",
          capabilityMetadata: [],
          sideEffectSemantics: "ReadOnly",
        },
      ],
      executableHandler: {
        handle: () =>
          Effect.succeed({
            _tag: "Observation",
            source: "Tool",
            observation: { text: observationMarker, truncated: false },
          }),
      },
      providerRuntime: Layer.succeed(ProviderRuntime, {
        runTurn: (input) => {
          requests.push(input.request);
          const events =
            call === 0 ? readToolTurn : sendMessageTurn("observation received");
          call += 1;
          return Effect.succeed({
            events: [
              {
                _tag: "TurnStarted",
                providerTurnId: input.providerTurnId,
                attemptNo: 0,
                modelRef: input.request.modelRef,
              },
              ...events,
            ],
            attemptNo: 0,
            retryDecisions: [],
          });
        },
      }),
    });
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        yield* seed;
        return yield* drive(allowGate);
      }),
      app,
    );

    expect(settlement._tag).toBe("Completed");
    expect(requests).toHaveLength(2);
    expect(
      requests[1] === undefined ? [] : portableInputItems(requests[1]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Message",
          role: "tool",
          text: observationMarker,
        }),
      ]),
    );
  });
});
