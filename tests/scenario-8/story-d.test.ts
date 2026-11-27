import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { runCompletionConsumer } from "../../packages/application/src/completion-consumer.js";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../../packages/application/src/verification-consumer.js";
import { p7Project, p7TestPrincipal } from "../support/consumer-harness.js";
import {
  ACC_D1,
  ACC_D2,
  acceptanceOf,
  acceptedEventOf,
  cmd,
  countEvents,
  criterionResult,
  EV_D1,
  EV_D2,
  EXE_D2,
  MISSION_D,
  makeStoryApp,
  openVerificationOf,
  refineWork,
  requireVerification,
  runStory,
  seedProject,
  seedWork,
  setMission,
  settledEventOf,
  VER_D2,
  WORK_D,
  WREV,
  workRowOf,
} from "./support.js";
import {
  expectTerminalRejected,
  makeConsumerADeps,
  makeConsumerBDeps,
  recordPayload,
  spawnFor,
  startPayload,
  submitAccept,
  submitConclude,
  submitRecord,
  submitStart,
} from "./support-wiring.js";

describe("-acceptance", () => {
  it("Story D (06 §4): Pass then RefineWork invalidates the acceptance; stale AcceptWorkOutcome rejected; forged old-revision event skips in Consumer B; new revision re-chains", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_D, cmd("89d0000000d1"));
        yield* setMission(WORK_D, MISSION_D);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-d-settled-1", WORK_D, "claim-d-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_D, 0, "claim-d-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);
        const record1 = yield* submitRecord(
          cmd("89d0000000d2"),
          recordPayload(ids.verificationId, EV_D1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89d0000000d3"),
          recordPayload(ids.verificationId, EV_D2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");
        const conclude = yield* submitConclude(
          cmd("89d0000000d4"),
          {
            verificationId: ids.verificationId,
            verdict: "Pass",
            criteriaResults: [
              criterionResult(MISSION_D, "c1", "Pass", [EV_D1]),
              criterionResult(MISSION_D, "c2", "Pass", [EV_D2]),
            ],
            summaryRef: "summary:d",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");

        const accept = yield* submitAccept(cmd("89d0000000d5"), {
          acceptanceId: ACC_D1,
          workId: WORK_D,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expect(accept.resolution._tag).toBe("Committed");

        yield* refineWork(WORK_D);
        const refinedRow = yield* workRowOf(WORK_D);
        expect(refinedRow.lifecycle).toBe("Open");
        expect(refinedRow.revision).toBe(1);

        const staleAccept = yield* submitAccept(cmd("89d0000000d6"), {
          acceptanceId: ACC_D2,
          workId: WORK_D,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expectTerminalRejected(staleAccept, "VerificationAcceptanceMismatch");

        const consumerB = yield* makeConsumerBDeps;
        const completed = yield* runCompletionConsumer(
          [
            acceptedEventOf("evt-d-accepted-1", {
              acceptanceId: ACC_D1,
              workId: WORK_D,
              targetWorkRevision: 0,
              verificationId: ids.verificationId,
            }),
          ],
          consumerB,
          p7Project,
          p7TestPrincipal,
        );
        expect(completed).toEqual(["skip:VerificationAcceptanceMismatch"]);
        const afterSkip = yield* workRowOf(WORK_D);
        expect(afterSkip.lifecycle).toBe("Open");
        expect(afterSkip.revision).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);

        const retained = yield* requireVerification(ids.verificationId);
        expect(retained.state).toEqual({
          status: "Concluded",
          verdict: "Pass",
        });
        const retainedAcceptance = yield* acceptanceOf(WORK_D, 0);
        expect(Option.isSome(retainedAcceptance)).toBe(true);

        const restart = yield* submitStart(
          cmd("89d0000000d7"),
          startPayload(VER_D2, WORK_D, 1, MISSION_D, EXE_D2),
        );
        expect(restart.resolution._tag).toBe("Committed");
        const openAtNewRevision = yield* openVerificationOf(WORK_D, 1);
        expect(Option.isSome(openAtNewRevision)).toBe(true);
        if (Option.isSome(openAtNewRevision)) {
          expect(openAtNewRevision.value.verificationId).toBe(VER_D2);
        }
      }),
    );
  });
});
