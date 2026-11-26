import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { P17_MIGRATIONS } from "../../adapters/persistence-sqlite/src/index.js";
import type { AgentActionHandler } from "../../packages/agent-runtime/src/index.js";
import type { CanonicalProviderEvent } from "../../packages/ports/src/index.js";
import { EnvironmentRevisionStore } from "../../packages/ports/src/index.js";

import {
  allowGate,
  driveAndCount,
  executionId,
  makeApp,
  run,
  runMigrations,
  seed,
  sendMessageTurn,
} from "./support.js";

const invalidTurn: ReadonlyArray<CanonicalProviderEvent> = [
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

/** B-9: a scripted `EnvironmentRevisionStore` whose `current` face advances
 * through `revisions`, holding the last value afterwards. The driver reads the
 * environment revision to build the turn's ControlBasis and re-reads it at
 * effectful-directive admission, so a change between the two is a real
 * `DecisionStale`. */
const scriptedEnvironmentRevisions = (
  revisions: ReadonlyArray<string>,
): Layer.Layer<EnvironmentRevisionStore> =>
  Layer.effect(
    EnvironmentRevisionStore,
    Effect.sync(() => {
      let calls = 0;
      return EnvironmentRevisionStore.of({
        current: () =>
          Effect.sync(() => {
            const value =
              revisions[Math.min(calls, revisions.length - 1)] ?? "0";
            calls += 1;
            return Option.some(value);
          }),
        record: () => Effect.void,
        lazyInitAnchor: () => Effect.void,
      });
    }),
  );
describe("P3-013 recovery — bounded repair + DecisionStale (B-9)", () => {
  it("repairs an empty provider turn and continues to a registered control action", async () => {
    const app = makeApp([invalidTurn, sendMessageTurn("recovered")]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const steps = yield* sql.unsafe<{
        repair_attempt: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT repair_attempt, state, successor_json FROM agent_loop_steps WHERE execution_id = ? AND logical_step_no = 0 ORDER BY repair_attempt",
        [executionId],
      );
      return { ...driven, steps };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(result.turns).toBe(2);
    expect(
      (
        result as typeof result & {
          steps: ReadonlyArray<{
            repair_attempt: number;
            state: string;
            successor_json: string | null;
          }>;
        }
      ).steps,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repair_attempt: 0,
          state: "OutputRejected",
          successor_json: expect.stringContaining("repairAttempt"),
        }),
        expect.objectContaining({ repair_attempt: 1 }),
      ]),
    );
  });
  it("settles Failed after bounded repair attempts are exhausted", async () => {
    const app = makeApp([invalidTurn, invalidTurn, invalidTurn]);
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        logical_step_no: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT logical_step_no, state, successor_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no",
        [executionId],
      );
      return { ...driven, actions, steps };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; failure?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Failed");
    expect(result.settlement.failure?._tag).toBe("ExecutionFailure");
    expect(result.turns).toBe(3);
  });
  it("does not execute a DecisionStale action and re-prepares instead", async () => {
    let invoked = 0;
    const sendHandler: AgentActionHandler = {
      action: "SendMessage",
      handle: () => {
        invoked += 1;
        return Effect.succeed({
          _tag: "Settle",
          settlement: {
            _tag: "Completed",
            result: { _tag: "CoordinationCompleted" },
          },
        });
      },
    };
    const app = makeApp(
      [sendMessageTurn("stale then fresh"), sendMessageTurn("fresh")],
      {
        environmentRevisions: scriptedEnvironmentRevisions([
          "0",
          "1",
          "1",
          "1",
        ]),
        controlHandlers: [sendHandler],
      },
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const driven = yield* driveAndCount(allowGate);
      const sql = yield* SqlClient;
      const actions = yield* sql.unsafe<{ state: string }>(
        "SELECT state FROM agent_loop_step_actions WHERE execution_id = ? AND logical_step_no = 0 ORDER BY action_index",
        [executionId],
      );
      const steps = yield* sql.unsafe<{
        logical_step_no: number;
        state: string;
        successor_json: string | null;
      }>(
        "SELECT logical_step_no, state, successor_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no",
        [executionId],
      );
      return { ...driven, actions, steps };
    });
    const result = (await run(program, app)) as {
      settlement: { _tag: string; result?: { _tag: string } };
      turns: number;
    };
    expect(result.settlement._tag).toBe("Completed");
    expect(result.settlement.result?._tag).toBe("CoordinationCompleted");
    expect(invoked).toBe(1);
    expect(result.turns).toBe(2);
    expect(
      (result as typeof result & { actions: ReadonlyArray<{ state: string }> })
        .actions,
    ).toEqual([{ state: "SkippedStale" }]);
    expect(
      (
        result as typeof result & {
          steps: ReadonlyArray<{
            logical_step_no: number;
            state: string;
            successor_json: string | null;
          }>;
        }
      ).steps,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_step_no: 0,
          state: "NextStepReady",
          successor_json: expect.stringContaining("logicalStepNo"),
        }),
        expect.objectContaining({ logical_step_no: 1 }),
      ]),
    );
  });
});
