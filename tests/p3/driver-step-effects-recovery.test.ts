import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P19_MIGRATIONS } from "../../adapters/persistence-sqlite/src/index.js";
import type { CanonicalProviderEvent } from "../../packages/ports/src/index.js";

import {
  allowGate,
  drive,
  executionId,
  makeApp,
  run,
  runMigrations,
  seed,
  sendMessageTurn,
} from "./support.js";

type StepEffectsCorruption =
  | "hash"
  | "cursor"
  | "ledger-gap"
  | "ledger-identity"
  | "ledger-state";
const runStepEffectsRecovery = async (input: {
  readonly actionCount?: number;
  readonly corruption?: StepEffectsCorruption;
}) => {
  const actionCount = input.actionCount ?? 1;
  let readInvocations = 0;
  let interruptAfterStepEffectsCommit = true;
  const acceptedReadTurn: ReadonlyArray<CanonicalProviderEvent> = [
    ...Array.from({ length: actionCount }, (_, index) => ({
      _tag: "ToolCallProposed" as const,
      callRef: `read-${index + 1}`,
      toolName: "read",
      argumentsJson: JSON.stringify({ path: `README-${index + 1}.md` }),
    })),
    { _tag: "TurnCompleted", finishReason: "ToolCall" },
  ];
  const app = makeApp(
    [acceptedReadTurn, sendMessageTurn("recovery successor")],
    {
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
          readInvocations += 1;
          return Effect.succeed({
            _tag: "Observation",
            source: "Tool",
            observation: { text: "read once", truncated: false },
          });
        },
      },
      qualificationProbe: (event) => {
        if (
          event.boundary === "AH11AfterStepEffectsCommit" &&
          interruptAfterStepEffectsCommit
        ) {
          interruptAfterStepEffectsCommit = false;
          return Promise.reject(new Error("simulated process interruption"));
        }
        return Promise.resolve();
      },
    },
  );
  return run(
    Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const first = yield* Effect.exit(drive(allowGate));
      const sql = yield* SqlClient;
      const beforeRecovery = yield* sql.unsafe<{
        state: string;
        next_action_index: number;
      }>(
        "SELECT state, next_action_index FROM agent_loop_steps WHERE execution_id = ? AND logical_step_no = 0",
        [executionId],
      );
      if (input.corruption === "hash") {
        yield* sql.unsafe(
          "UPDATE agent_loop_steps SET decoded_output_hash = 'corrupt' WHERE execution_id = ? AND logical_step_no = 0",
          [executionId],
        );
      } else if (input.corruption === "cursor") {
        yield* sql.unsafe(
          "UPDATE agent_loop_steps SET next_action_index = 0 WHERE execution_id = ? AND logical_step_no = 0",
          [executionId],
        );
      } else if (input.corruption === "ledger-gap") {
        yield* sql.unsafe(
          "DELETE FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 AND action_index = 0",
          [executionId],
        );
      } else if (input.corruption === "ledger-identity") {
        yield* sql.unsafe(
          "UPDATE agent_loop_step_actions SET call_ref = 'call_corrupt' WHERE execution_id = ? AND logical_step_no = 0 AND action_index = 0",
          [executionId],
        );
      } else if (input.corruption === "ledger-state") {
        yield* sql.unsafe(
          "UPDATE agent_loop_step_actions SET state = 'Pending' WHERE execution_id = ? AND logical_step_no = 0 AND action_index = 0",
          [executionId],
        );
      }
      const recovery = yield* Effect.exit(drive(allowGate));
      const steps = yield* sql.unsafe<{
        logical_step_no: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT logical_step_no, state, successor_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no",
        [executionId],
      );
      const actions = yield* sql.unsafe<{
        logical_step_no: number;
        action_index: number;
        action_kind: string;
        state: string;
      }>(
        "SELECT logical_step_no, action_index, action_kind, state FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY logical_step_no, action_index",
        [executionId],
      );
      const turns = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_turns WHERE execution_id = ?",
        [executionId],
      );
      return {
        first,
        beforeRecovery,
        recovery,
        steps,
        actions,
        providerTurns: Number(turns[0]?.count ?? 0),
        readInvocations,
      };
    }),
    app,
  );
};
describe("P3-013 StepEffectsCommitted recovery", () => {
  it("advances the committed step without replaying its Applied action", async () => {
    const result = await runStepEffectsRecovery({});
    expect(result.first._tag).toBe("Failure");
    expect(result.beforeRecovery).toEqual([
      { state: "StepEffectsCommitted", next_action_index: 1 },
    ]);
    expect(result.recovery).toMatchObject({
      _tag: "Success",
      value: { _tag: "Completed" },
    });
    expect(result.readInvocations).toBe(1);
    expect(result.providerTurns).toBe(2);
    expect(result.steps).toEqual([
      expect.objectContaining({
        logical_step_no: 0,
        state: "NextStepReady",
        successor_json: expect.stringContaining("logicalStepNo"),
      }),
      expect.objectContaining({ logical_step_no: 1 }),
    ]);
    expect(result.actions).toEqual([
      {
        logical_step_no: 0,
        action_index: 0,
        action_kind: "read",
        state: "Applied",
      },
      {
        logical_step_no: 1,
        action_index: 0,
        action_kind: "send_message",
        state: "Applied",
      },
    ]);
  });

  it("validates and advances a committed multi-action output", async () => {
    const result = await runStepEffectsRecovery({ actionCount: 2 });
    expect(result.first._tag).toBe("Failure");
    expect(result.beforeRecovery).toEqual([
      { state: "StepEffectsCommitted", next_action_index: 2 },
    ]);
    expect(result.recovery).toMatchObject({
      _tag: "Success",
      value: { _tag: "Completed" },
    });
    expect(result.readInvocations).toBe(2);
    expect(result.providerTurns).toBe(2);
    expect(result.steps).toEqual([
      expect.objectContaining({
        logical_step_no: 0,
        state: "NextStepReady",
        successor_json: expect.stringContaining("logicalStepNo"),
      }),
      expect.objectContaining({ logical_step_no: 1 }),
    ]);
    expect(result.actions).toEqual([
      {
        logical_step_no: 0,
        action_index: 0,
        action_kind: "read",
        state: "Applied",
      },
      {
        logical_step_no: 0,
        action_index: 1,
        action_kind: "read",
        state: "Applied",
      },
      {
        logical_step_no: 1,
        action_index: 0,
        action_kind: "send_message",
        state: "Applied",
      },
    ]);
  });

  it.each([
    "hash",
    "cursor",
    "ledger-gap",
    "ledger-identity",
    "ledger-state",
  ] as const)(
    "fails closed when the committed step %s evidence is corrupt",
    async (corruption) => {
      const result = await runStepEffectsRecovery({ corruption });
      expect(result.first._tag).toBe("Failure");
      expect(result.beforeRecovery).toEqual([
        { state: "StepEffectsCommitted", next_action_index: 1 },
      ]);
      expect(result.recovery._tag).toBe("Failure");
      expect(JSON.stringify(result.recovery)).toContain(
        "AgentLoopStepReplayBindingMismatch",
      );
      expect(result.readInvocations).toBe(1);
      expect(result.providerTurns).toBe(1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.state).toBe("StepEffectsCommitted");
      expect(result.actions).toHaveLength(corruption === "ledger-gap" ? 0 : 1);
    },
  );
});
