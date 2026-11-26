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
} from "../support/p7-app.js";
import {
  cmd,
  countEvents,
  countRows,
  criterionResult,
  EV_C1,
  EV_C2,
  MISSION_C,
  makeStoryApp,
  requireVerification,
  runStory,
  seedProject,
  seedWork,
  setMission,
  settledEventOf,
  WORK_C,
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
  it("Story C (06 §3): insufficient evidence aggregates Unknown; channel 2 still fires; no FAIL semantics, no rework branch, no auto-PASS, zero automatic Work mutation", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_C, cmd("89c0000000c1"));
        yield* setMission(WORK_C, MISSION_C);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-c-settled-1", WORK_C, "claim-c-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_C, 0, "claim-c-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const before = yield* worksSnapshot;
        const record1 = yield* submitRecord(
          cmd("89c0000000c2"),
          recordPayload(ids.verificationId, EV_C1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89c0000000c3"),
          recordPayload(ids.verificationId, EV_C2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");

        const conclude = yield* submitConclude(
          cmd("89c0000000c4"),
          {
            verificationId: ids.verificationId,
            verdict: "Unknown",
            criteriaResults: [
              criterionResult(MISSION_C, "c1", "Unknown", [EV_C1]),
              criterionResult(MISSION_C, "c2", "Pass", [EV_C2]),
            ],
            summaryRef: "summary:c",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");
        if (conclude.resolution._tag === "Committed") {
          expect(conclude.resolution.result).toMatchObject({
            state: "Concluded",
            verdict: "Unknown",
          });
        }
        const concluded = yield* requireVerification(ids.verificationId);
        expect(concluded.state).toEqual({
          status: "Concluded",
          verdict: "Unknown",
        });

        const delivery = yield* deliverConclusion(
          "Unknown",
          WORK_C,
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
        const workRow = yield* workRowOf(WORK_C);
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(0);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countRows("work_acceptances")).toBe(0);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* countEvents("WorkRefined")).toBe(0);
      }),
    );
  });
});
