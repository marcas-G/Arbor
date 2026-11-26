import { Cause, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { CriticalSteerCommitted } from "../../packages/application/src/critical-steer.js";
import { CommandId, parse } from "../../packages/domain/dist/index.js";
import {
  admitMainExecution,
  buildHandlers,
  criticalPayload,
  criticalSteerSubmission,
  Effect,
  executionRow,
  inboxEntries,
  makeCriticalSteerApp,
  runCriticalSteer,
  type StopExecutionResult,
  seedWork,
  submitCriticalSteer,
  TransactionPort,
  WorkRevision,
  workId,
  workRow,
} from "./support.js";

const commitSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const commitStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const staleSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e2",
);
const staleStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e3",
);
const normalSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const normalStopCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d4",
);

describe("p6-critical-steer", () => {
  it("commits WorkSteered and stopRequestedAt in the same transaction (04 §4)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const outcome = yield* tx.transact(
        submitCriticalSteer(
          criticalSteerSubmission(handlers, {
            steerCommandId: commitSteerCommandId,
            stopCommandId: commitStopCommandId,
            payload: criticalPayload(),
            executionId,
          }),
        ),
      );
      return {
        outcome,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    const outcome: CriticalSteerCommitted<StopExecutionResult> = result.outcome;
    expect(outcome._tag).toBe("CriticalSteerCommitted");
    expect(outcome.steer.result.severity).toBe("Critical");
    expect(outcome.steer.result.fromRevision).toBe(0);
    expect(outcome.steer.result.toRevision).toBe(1);
    // P10 `06` §2 back-fill: a committed human steer pairs WorkSteered
    // with HumanInterventionApplied(CriticalSteer) in the same events
    // array (the P6 primary event stays first).
    expect(outcome.steer.events).toHaveLength(2);
    expect(outcome.steer.events[0]?.eventType).toBe("WorkSteered");
    expect(outcome.steer.events[0]?.payload).toEqual({
      workId,
      fromRevision: 0,
      toRevision: 1,
      severity: "Critical",
    });
    expect(outcome.steer.events[1]?.eventType).toBe("HumanInterventionApplied");
    expect(outcome.stop.result.stopRequestedAt).toBe("t");
    expect(outcome.stop.events).toHaveLength(1);
    expect(outcome.stop.events[0]?.eventType).toBe("ExecutionStopRequested");
    expect(result.work[0]?.lifecycle).toBe("Open");
    expect(result.work[0]?.revision).toBe(1);
    expect(result.execution[0]?.stop_requested_at).toBe("t");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("HumanInput");
  });

  it("rejects the stale-revision steer without stopping the execution (atomicity)", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const outcome = yield* tx
        .transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: staleSteerCommandId,
              stopCommandId: staleStopCommandId,
              payload: criticalPayload({
                expectedWorkRevision: parse(WorkRevision)(5),
              }),
              executionId,
            }),
          ),
        )
        .pipe(
          Effect.catchTag("CriticalSteerRejected", (failure) =>
            Effect.succeed(failure),
          ),
        );
      return {
        outcome,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.outcome._tag).toBe("CriticalSteerRejected");
    if (result.outcome._tag === "CriticalSteerRejected") {
      expect(result.outcome.stage).toBe("SteerWork");
      expect(result.outcome.rejection._tag).toBe("RevisionConflict");
    }
    expect(result.work[0]?.revision).toBe(0);
    expect(result.execution[0]?.stop_requested_at).toBeNull();
    expect(result.entries).toHaveLength(0);
  });

  it("defects on Normal severity (this path is Critical-only) and mutates nothing", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const executionId = yield* admitMainExecution;
      const handlers = yield* buildHandlers;
      const tx = yield* TransactionPort;
      const exit = yield* Effect.exit(
        tx.transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: normalSteerCommandId,
              stopCommandId: normalStopCommandId,
              payload: criticalPayload({
                steer: {
                  severity: "Normal",
                  guidance: "cnt-normal-guidance-001",
                },
              }),
              executionId,
            }),
          ),
        ),
      );
      return { exit, work: yield* workRow, execution: yield* executionRow };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) {
      expect(
        result.exit.cause.reasons.some((reason) => Cause.isDieReason(reason)),
      ).toBe(true);
    }
    expect(result.work[0]?.revision).toBe(0);
    expect(result.execution[0]?.stop_requested_at).toBeNull();
  });
});
