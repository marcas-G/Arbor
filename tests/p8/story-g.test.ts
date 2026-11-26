import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
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
  EXE_G1B,
  EXE_G3,
  EXE_G4,
  eventPayloads,
  executionRowOf,
  MISSION_G,
  makeStoryApp,
  openVerificationOf,
  ownerWorkspaceIdOf,
  requireVerification,
  runStory,
  seedProject,
  seedWork,
  setMission,
  settledEventOf,
  VER_G1B,
  VER_G3,
  VER_G4,
  WORK_G1,
  WORK_G2,
} from "./support.js";
import {
  expectTerminalRejected,
  makeConsumerADeps,
  spawnFor,
  startPayload,
  submitConcludeOrphaned,
  submitStart,
} from "./support-wiring.js";

describe("p8-acceptance", () => {
  it("Story G (06 §4 owner snapshot): Start records owner; retirement never auto-aborts the verifier; Unknown(Orphaned) carries conclusionReason and allows re-Start; second same-revision Start is VerificationAlreadyOpen", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_G1, cmd("89f0000000f1"));
        yield* seedWork(WORK_G2, cmd("89f0000000f2"));
        yield* setMission(WORK_G1, MISSION_G);
        yield* setMission(WORK_G2, MISSION_G);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-g-settled-1", WORK_G1, "claim-g-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_G1, 0, "claim-g-1");
        expect(yield* ownerWorkspaceIdOf(ids.verificationId)).toBe(
          p7RootWorkspace,
        );
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE workspaces SET lifecycle = 'Retired' WHERE workspace_id = ?",
          [p7RootWorkspace],
        );
        const executionRow = yield* executionRowOf(ids.verifierExecutionId);
        expect(executionRow.settlement_kind).toBeNull();
        expect(executionRow.stop_requested_at).toBeNull();
        const stillOpen = yield* requireVerification(ids.verificationId);
        expect(stillOpen.state).toEqual({ status: "Open" });

        const orphaned = yield* submitConcludeOrphaned(cmd("89f0000000f3"), {
          verificationId: ids.verificationId,
          verdict: "Unknown",
          criteriaResults: [],
          summaryRef: "summary:g",
          conclusionReason: "Orphaned",
        });
        expect(orphaned.resolution._tag).toBe("Committed");
        const concludedPayloads = yield* eventPayloads("VerificationConcluded");
        expect(concludedPayloads[0]).toMatchObject({
          verificationId: ids.verificationId,
          verdict: "Unknown",
          conclusionReason: "Orphaned",
          evidenceRefs: [],
          missionSnapshot: MISSION_G,
          criteriaResults: [],
          snapshotStatus: "NotApplicableOrphaned",
        });
        const orphanedVerification = yield* requireVerification(
          ids.verificationId,
        );
        expect(orphanedVerification.state).toEqual({
          status: "Concluded",
          verdict: "Unknown",
          conclusionReason: "Orphaned",
        });

        const restart = yield* submitStart(
          cmd("89f0000000f4"),
          startPayload(VER_G1B, WORK_G1, 0, MISSION_G, EXE_G1B),
        );
        expect(restart.resolution._tag).toBe("Committed");
        const reopened = yield* openVerificationOf(WORK_G1, 0);
        expect(Option.isSome(reopened)).toBe(true);
        if (Option.isSome(reopened)) {
          expect(reopened.value.verificationId).toBe(VER_G1B);
          expect(reopened.value.verificationId).not.toBe(ids.verificationId);
        }

        const first = yield* submitStart(
          cmd("89f0000000f5"),
          startPayload(VER_G3, WORK_G2, 0, MISSION_G, EXE_G3),
        );
        expect(first.resolution._tag).toBe("Committed");
        const second = yield* submitStart(
          cmd("89f0000000f6"),
          startPayload(VER_G4, WORK_G2, 0, MISSION_G, EXE_G4),
        );
        expectTerminalRejected(second, "VerificationAlreadyOpen");
      }),
    );
  });
});
