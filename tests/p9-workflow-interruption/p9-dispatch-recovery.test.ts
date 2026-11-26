import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Principal,
  startVerification,
} from "../../packages/domain/dist/index.js";
import {
  preDispatchCheck,
  runRecovery,
  sweepRecovery,
} from "../../packages/execution-runtime/src/index.js";
import {
  ExecutionScheduler,
  TransactionPort,
  VerificationRepository,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestPrincipal,
} from "../support/p7-app.js";
import {
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "../support/p9-consumer-app.js";
import { labeled } from "../support/p9-harness-api.js";
import {
  ASSIGN_CMD_1,
  countEvents,
  countRows,
  dispatchRound,
  dyingDispatch,
  EXE_DF1,
  EXE_DF2,
  executionSettlement,
  INSERT_EXECUTION,
  INSERT_MAIN_EXECUTION,
  MISSION,
  recordingDispatch,
  settleCompleted,
  VER,
  WORK_1,
  WREV,
} from "./support.js";

describe("p9-workflow-interruption (WF1–WF3 / DF1–DF2 / D5)", () => {
  it("DF1 [crash-injected]: dispatch port call fails — never settles an Execution; stays Active; reevaluation re-dispatch converges", async () => {
    expect(labeled("DF1-dispatch-failure", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        yield* INSERT_EXECUTION(EXE_DF1);
        const exit = yield* Effect.exit(
          dispatchRound(EXE_DF1, dyingDispatch()),
        );
        expect(exit._tag).toBe("Failure");
        // A dispatch failure never settles (P2 `02` §5): no settlement,
        // no lease, no canonical side effects.
        expect(yield* executionSettlement(EXE_DF1)).toBeNull();
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [EXE_DF1]),
        ).toBe(0);
        expect(
          yield* countRows("commands", "command_id LIKE 'cmd_settle_%'"),
        ).toBe(0);
        // The re-dispatch surface stays eligible (no live lease).
        expect(yield* preDispatchCheck(EXE_DF1 as never)).toBe(true);
        const sink: Array<string> = [];
        yield* dispatchRound(EXE_DF1, recordingDispatch(sink));
        expect(sink).toEqual([EXE_DF1]);
        const receipt = yield* settleCompleted(EXE_DF1);
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(yield* executionSettlement(EXE_DF1)).toBe("Completed");
      }),
      makeP9ConsumerApp(),
    );
  });

  it("DF2 [crash-injected]: dispatch accepted then lost — next sweep reevaluation re-drives the workspace; single-flight conflict converges to Noop", async () => {
    expect(labeled("DF2-lost-dispatch", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        yield* INSERT_MAIN_EXECUTION(EXE_DF2);
        const sink: Array<string> = [];
        yield* dispatchRound(EXE_DF2, recordingDispatch(sink));
        expect(sink).toEqual([EXE_DF2]);
        // Lost dispatch: ticket accepted, worker never starts — Active +
        // no live lease + no session progress (the observable surface).
        expect(yield* executionSettlement(EXE_DF2)).toBeNull();
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [EXE_DF2]),
        ).toBe(0);
        expect(
          yield* countRows("session_entries", "session_id = ?", [
            "ses_00000000-0000-7000-8000-00000000df02",
          ]),
        ).toBe(0);
        // Bottom line: the next sweep (T2/T3) runs; the reevaluation of
        // the owning workspace sees the Active main execution and
        // converges the single-flight conflict to Noop (P2 `05` §8).
        yield* sweepRecovery(p7TestPrincipal as Principal);
        const scheduler = yield* ExecutionScheduler;
        const decision = yield* scheduler.reevaluate(p7RootWorkspace, {
          _tag: "Recovery",
        });
        expect(decision).toEqual({
          _tag: "Noop",
          reason: "ActiveMainExecution",
        });
        // Re-dispatch within the sweep cadence: eligible, and the
        // workspace continues to settlement on the same execution.
        expect(yield* preDispatchCheck(EXE_DF2 as never)).toBe(true);
        yield* dispatchRound(EXE_DF2, recordingDispatch(sink));
        expect(sink).toHaveLength(2);
        const receipt = yield* settleCompleted(EXE_DF2);
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(yield* executionSettlement(EXE_DF2)).toBe("Completed");
      }),
      makeP9ConsumerApp(),
    );
  });

  it("D5 [crash-injected]: Open verification survives the dirty-restart recovery pass — no auto-conclude, no auto-Unknown", async () => {
    expect(
      labeled("D5-open-verification-preserved", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const seeded = yield* p7SeedWork(WORK_1, ASSIGN_CMD_1);
        expect(seeded.resolution._tag).toBe("Committed");
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER(51),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              missionSnapshot: MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* runRecovery(p7TestPrincipal as Principal);
        const stored = yield* tx.transact(verifications.findById(VER(51)));
        expect(Option.isSome(stored)).toBe(true);
        expect(
          Option.isSome(stored) ? stored.value.state.status : "missing",
        ).toBe("Open");
        expect(yield* countEvents("VerificationConcluded")).toBe(0);
        expect(yield* countEvents("VerificationUnknown")).toBe(0);
      }),
      makeP9ConsumerApp(),
    );
  });
});
