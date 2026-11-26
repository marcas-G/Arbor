import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  completionCommandId,
  runCompletionConsumer,
} from "../../packages/application/src/completion-consumer.js";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../../packages/application/src/verification-consumer.js";
import {
  TransactionPort,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { p7Project, p7TestPrincipal } from "../support/p7-app.js";
import {
  ACC_A,
  acceptanceOf,
  acceptedEventOf,
  cmd,
  countEvents,
  countRows,
  criterionResult,
  EV_A1,
  EV_A2,
  eventPayloads,
  executionRowOf,
  insertWait,
  MISSION_A,
  makeStoryApp,
  receiptResolution,
  requireVerification,
  runStory,
  seedProject,
  seedWork,
  setCurrentWork,
  setMission,
  settledEventOf,
  storedCurrentWorkId,
  WORK_A,
  WORK_A_WAITER,
  WREV,
  workRowOf,
} from "./support.js";
import {
  deliverConclusion,
  makeConsumerADeps,
  makeConsumerBDeps,
  recordPayload,
  spawnFor,
  submitAccept,
  submitConclude,
  submitRecord,
} from "./support-wiring.js";

describe("p8-acceptance", () => {
  it("Story A (06 §1): CompletionClaimed → Consumer A Start → verifier spawn → evidence ×2 → Conclude(Pass) → Accept → Consumer B CompleteWork; revision constant, binding chain, channel 1 only", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_A, cmd("89a0000000a1"));
        yield* seedWork(WORK_A_WAITER, cmd("89a0000000a2"));
        yield* setMission(WORK_A, MISSION_A);
        yield* setCurrentWork(WORK_A);
        yield* insertWait(WORK_A_WAITER, [
          {
            _tag: "VerificationChanged",
            workId: WORK_A,
            targetWorkRevision: 0,
          },
        ]);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-a-settled-1", WORK_A, "claim-a-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);

        const ids = verificationSpawnIds(WORK_A, 0, "claim-a-1");
        const verification = yield* requireVerification(ids.verificationId);
        expect(verification.workId).toBe(WORK_A);
        expect(verification.targetWorkRevision).toBe(0);
        expect(verification.state).toEqual({ status: "Open" });
        expect(verification.missionSnapshot).toEqual(MISSION_A);
        expect(verification.verificationExecutionIds).toEqual([
          ids.verifierExecutionId,
        ]);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* receiptResolution(ids.commandId)).toBe("Committed");

        const spawn = yield* spawnFor(verification, ids.verifierExecutionId);
        expect(spawn).toEqual({ _tag: "Spawned", admitted: true });
        const executionRow = yield* executionRowOf(ids.verifierExecutionId);
        expect(executionRow.binding_kind).toBe("execution_bound");
        expect(executionRow.parent_execution_id).toBeNull();

        const record1 = yield* submitRecord(
          cmd("89a0000000a3"),
          recordPayload(ids.verificationId, EV_A1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89a0000000a4"),
          recordPayload(ids.verificationId, EV_A2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");
        expect(yield* countRows("verification_evidence")).toBe(2);

        const conclude = yield* submitConclude(
          cmd("89a0000000a5"),
          {
            verificationId: ids.verificationId,
            verdict: "Pass",
            criteriaResults: [
              criterionResult(MISSION_A, "c1", "Pass", [EV_A1]),
              criterionResult(MISSION_A, "c2", "Pass", [EV_A2]),
            ],
            summaryRef: "summary:a",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");

        expect(yield* countEvents("VerificationConcluded")).toBe(1);
        const concludedPayloads = yield* eventPayloads("VerificationConcluded");
        expect(concludedPayloads[0]).toEqual({
          verificationId: ids.verificationId,
          workId: WORK_A,
          targetWorkRevision: 0,
          verdict: "Pass",
          conclusionReason: null,
          evidenceRefs: [EV_A1, EV_A2],
          summaryRef: "summary:a",
          missionSnapshot: MISSION_A,
          criteriaResults: [
            criterionResult(MISSION_A, "c1", "Pass", [EV_A1]),
            criterionResult(MISSION_A, "c2", "Pass", [EV_A2]),
          ],
          snapshotStatus: "Available",
        });

        const accept = yield* submitAccept(cmd("89a0000000a6"), {
          acceptanceId: ACC_A,
          workId: WORK_A,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expect(accept.resolution._tag).toBe("Committed");
        expect(yield* countEvents("WorkOutcomeAccepted")).toBe(1);

        const consumerB = yield* makeConsumerBDeps;
        const completed = yield* runCompletionConsumer(
          [
            acceptedEventOf("evt-a-accepted-1", {
              acceptanceId: ACC_A,
              workId: WORK_A,
              targetWorkRevision: 0,
              verificationId: ids.verificationId,
            }),
          ],
          consumerB,
          p7Project,
          p7TestPrincipal,
        );
        expect(completed).toEqual(["CompleteWork"]);
        expect(
          yield* receiptResolution(
            completionCommandId(WORK_A, WREV(0), ids.verificationId),
          ),
        ).toBe("Committed");

        const workRow = yield* workRowOf(WORK_A);
        expect(workRow.lifecycle).toBe("Completed");
        expect(workRow.revision).toBe(0);
        expect(yield* storedCurrentWorkId).toBe(null);
        expect(yield* countEvents("WorkCompleted")).toBe(1);

        const concluded = yield* requireVerification(ids.verificationId);
        expect(concluded.workId).toBe(WORK_A);
        expect(concluded.targetWorkRevision).toBe(0);
        expect(concluded.state).toEqual({
          status: "Concluded",
          verdict: "Pass",
        });
        const acceptance = yield* acceptanceOf(WORK_A, 0);
        expect(Option.isSome(acceptance)).toBe(true);
        if (Option.isSome(acceptance)) {
          expect(acceptance.value.acceptanceId).toBe(ACC_A);
          expect(acceptance.value.verificationId).toBe(ids.verificationId);
          expect(acceptance.value.targetWorkRevision).toBe(0);
        }

        const delivery = yield* deliverConclusion(
          "Pass",
          WORK_A,
          ids.verificationId,
        );
        expect(delivery.releasedWaits).toBeGreaterThanOrEqual(1);
        expect(delivery.routed).toBe(false);
        expect(calls).toEqual([]);
        const tx = yield* TransactionPort;
        const waits = yield* WorkWaitStore;
        expect(yield* tx.transact(waits.findByWork(WORK_A_WAITER))).toEqual(
          Option.none(),
        );
      }),
    );
  });
});
