import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  EnvironmentRevisionStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { p7Project } from "../support/consumer-harness.js";
import {
  ART_E,
  cmd,
  countRows,
  DEL_E,
  EXE_E1,
  EXE_E2,
  EXE_E3,
  EXE_E4,
  EXE_E5,
  FORMATION_PLACEHOLDER_MISSION,
  LEGACY_PLACEHOLDER_MISSION,
  MISSION_E,
  makeStoryApp,
  requireVerification,
  runStory,
  seedDeliverable,
  seedProject,
  seedWork,
  setMission,
  VER_E1,
  VER_E2,
  VER_E3,
  VER_E4,
  VER_E5,
  WORK_E1,
  WORK_E2,
  WORK_E3,
} from "./support.js";
import {
  expectTerminalRejected,
  startPayload,
  submitStart,
} from "./support-wiring.js";

describe("p8-acceptance", () => {
  it("Story E (06 §5): legacy placeholder mission typed-rejected; formation placeholder passes; deliverable sourceWorkRevision consistency enforced; executable mission requires environmentRevision", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_E1, cmd("89e0000000e1"));
        yield* seedWork(WORK_E2, cmd("89e0000000e2"));
        yield* seedWork(WORK_E3, cmd("89e0000000e3"));

        yield* setMission(WORK_E1, LEGACY_PLACEHOLDER_MISSION);
        const legacy = yield* submitStart(
          cmd("89e0000000e4"),
          startPayload(VER_E1, WORK_E1, 0, LEGACY_PLACEHOLDER_MISSION, EXE_E1),
        );
        expectTerminalRejected(legacy, "InvalidVerificationMission");
        expect(yield* countRows("verifications")).toBe(0);

        yield* setMission(WORK_E1, FORMATION_PLACEHOLDER_MISSION);
        const formation = yield* submitStart(
          cmd("89e0000000e5"),
          startPayload(
            VER_E1,
            WORK_E1,
            0,
            FORMATION_PLACEHOLDER_MISSION,
            EXE_E1,
          ),
        );
        expect(formation.resolution._tag).toBe("Committed");
        const formationVerification = yield* requireVerification(VER_E1);
        expect(formationVerification.state).toEqual({ status: "Open" });

        yield* setMission(WORK_E2, MISSION_E);
        yield* seedDeliverable(DEL_E, WORK_E2, ART_E);
        const bound = yield* submitStart(
          cmd("89e0000000e6"),
          startPayload(VER_E2, WORK_E2, 0, MISSION_E, EXE_E2, {
            targetDeliverables: [DEL_E],
          }),
        );
        expect(bound.resolution._tag).toBe("Committed");
        const boundVerification = yield* requireVerification(VER_E2);
        expect(boundVerification.targetDeliverables).toEqual([DEL_E]);
        expect(boundVerification.targetArtifactVersions).toEqual([ART_E]);

        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE deliverables SET source_work_revision = 1 WHERE deliverable_id = ?",
          [DEL_E],
        );
        const mismatch = yield* submitStart(
          cmd("89e0000000e7"),
          startPayload(VER_E3, WORK_E2, 0, MISSION_E, EXE_E3, {
            targetDeliverables: [DEL_E],
          }),
        );
        expectTerminalRejected(mismatch, "InvalidVerificationMission");

        yield* setMission(WORK_E3, MISSION_E);
        const noEnvironment = yield* submitStart(
          cmd("89e0000000e8"),
          startPayload(VER_E4, WORK_E3, 0, MISSION_E, EXE_E4, {
            executableMission: true,
          }),
        );
        expectTerminalRejected(noEnvironment, "InvalidVerificationMission");

        const tx = yield* TransactionPort;
        const environmentRevisions = yield* EnvironmentRevisionStore;
        yield* tx.transact(environmentRevisions.record(p7Project, "env-e3"));
        const withEnvironment = yield* submitStart(
          cmd("89e0000000e9"),
          startPayload(VER_E5, WORK_E3, 0, MISSION_E, EXE_E5, {
            executableMission: true,
          }),
        );
        expect(withEnvironment.resolution._tag).toBe("Committed");
        const executable = yield* requireVerification(VER_E5);
        expect(executable.targetEnvironmentRevision).toBe("env-e3");
      }),
    );
  });
});
