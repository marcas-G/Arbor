import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../../packages/application/src/verification-consumer.js";
import {
  p7Project,
  p7RootWorkspace,
  p7TestPrincipal,
} from "../support/consumer-harness.js";
import {
  cmd,
  countEvents,
  countRows,
  criterionResult,
  EV_B1,
  EV_B2,
  MISSION_B,
  makeStoryApp,
  requireVerification,
  runStory,
  seedProject,
  seedWork,
  setMission,
  settledEventOf,
  WORK_B,
  workRowOf,
  worksSnapshot,
} from "./support.js";
import {
  deliverConclusion,
  makeConsumerADeps,
  recordPayload,
  spawnFor,
  submitConclude,
  submitRecord,
} from "./support-wiring.js";

describe("p8-acceptance", () => {
  it("Story B (06 §2): Conclude(Fail) routes channel 2 (VerificationReturned); same Producer work stays Open, no new Work, verifier writes zero works rows", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_B, cmd("89b0000000b1"));
        yield* setMission(WORK_B, MISSION_B);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-b-settled-1", WORK_B, "claim-b-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_B, 0, "claim-b-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const before = yield* worksSnapshot;
        const record1 = yield* submitRecord(
          cmd("89b0000000b2"),
          recordPayload(ids.verificationId, EV_B1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89b0000000b3"),
          recordPayload(ids.verificationId, EV_B2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");

        const conclude = yield* submitConclude(
          cmd("89b0000000b4"),
          {
            verificationId: ids.verificationId,
            verdict: "Fail",
            criteriaResults: [
              criterionResult(MISSION_B, "c1", "Fail", [EV_B1]),
              criterionResult(MISSION_B, "c2", "Pass", [EV_B2]),
            ],
            summaryRef: "summary:b",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");
        if (conclude.resolution._tag === "Committed") {
          expect(conclude.resolution.result).toMatchObject({
            state: "Concluded",
            verdict: "Fail",
          });
        }

        const delivery = yield* deliverConclusion(
          "Fail",
          WORK_B,
          ids.verificationId,
        );
        expect(delivery).toEqual({ releasedWaits: 0, routed: true });
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReasonTag: "VerificationReturned",
          },
        ]);

        expect(yield* worksSnapshot).toBe(before);
        const workRow = yield* workRowOf(WORK_B);
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(0);
        expect(yield* countRows("works")).toBe(1);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* countEvents("WorkRefined")).toBe(0);
      }),
    );
  });
});
