import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { workspaceBound } from "../../packages/domain/dist/index.js";
import { p7SeedProject } from "../support/p7-app.js";

import {
  cmd,
  DEP_F_BLOCKED,
  DEP_F_UNREFERENCED,
  expectedOf,
  makeStoryApp,
  runStory,
  WORK_F_BLOCKED,
  WORK_F_CLEAN,
  WORK_F_DEP_ONLY,
  WORK_F_WAIT,
  WS_F_OTHER,
} from "./support.js";
import {
  classifyRoot,
  decideFromTable,
  depChanged,
  insertWait,
  seedDependency,
  seedWorks,
  setCurrentWork,
  timeReached,
} from "./support-store.js";

export const storyFClassifyOnlyRunnableAuthority = async (): Promise<void> => {
  const { app } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      yield* seedWorks([
        [WORK_F_WAIT, cmd("89f0000000f1")],
        [WORK_F_BLOCKED, cmd("89f0000000f2")],
        [WORK_F_DEP_ONLY, cmd("89f0000000f3")],
        [WORK_F_CLEAN, cmd("89f0000000f4")],
      ]);
      yield* insertWait(WORK_F_WAIT, [timeReached]);
      yield* seedDependency(
        DEP_F_BLOCKED,
        WORK_F_BLOCKED,
        workspaceBound(WS_F_OTHER),
        expectedOf("report", ["summary"]),
      );
      yield* insertWait(WORK_F_BLOCKED, [depChanged(DEP_F_BLOCKED)]);
      yield* seedDependency(
        DEP_F_UNREFERENCED,
        WORK_F_DEP_ONLY,
        workspaceBound(WS_F_OTHER),
        expectedOf("report", ["summary"]),
      );

      const matrix = yield* classifyRoot;
      expect(matrix.current).toEqual(Option.none());
      expect([...matrix.runnable]).toEqual([WORK_F_DEP_ONLY, WORK_F_CLEAN]);
      expect(decideFromTable(matrix.current, matrix.runnable)).toEqual({
        _tag: "RequestWorkSelection",
        candidateWorkIds: [WORK_F_DEP_ONLY, WORK_F_CLEAN],
      });

      yield* setCurrentWork(WORK_F_BLOCKED);
      const blockedCurrent = yield* classifyRoot;
      expect(blockedCurrent.current).toEqual(Option.none());
      expect([...blockedCurrent.runnable]).toEqual([
        WORK_F_DEP_ONLY,
        WORK_F_CLEAN,
      ]);
      expect(
        decideFromTable(blockedCurrent.current, blockedCurrent.runnable),
      ).toEqual({
        _tag: "RequestWorkSelection",
        candidateWorkIds: [WORK_F_DEP_ONLY, WORK_F_CLEAN],
      });

      yield* setCurrentWork(WORK_F_CLEAN);
      const cleanCurrent = yield* classifyRoot;
      expect(cleanCurrent.current).toEqual(Option.some(WORK_F_CLEAN));
      expect([...cleanCurrent.runnable]).toEqual([WORK_F_DEP_ONLY]);
      expect(
        decideFromTable(cleanCurrent.current, cleanCurrent.runnable),
      ).toEqual({ _tag: "AdmitWork", workId: WORK_F_CLEAN });

      yield* setCurrentWork(null);
      yield* insertWait(WORK_F_DEP_ONLY, [{ _tag: "Manual" }]);
      const singleRunnable = yield* classifyRoot;
      expect(singleRunnable.current).toEqual(Option.none());
      expect([...singleRunnable.runnable]).toEqual([WORK_F_CLEAN]);
      expect(
        decideFromTable(singleRunnable.current, singleRunnable.runnable),
      ).toEqual({ _tag: "SelectCurrentWork", workId: WORK_F_CLEAN });

      // tests/p7 (file moved from tests/): the repo root is one level higher.
      expect(
        existsSync(
          join(
            import.meta.dirname,
            "../..",
            "apps/single-workspace/test/p5-runnable-source.test.ts",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            import.meta.dirname,
            "../..",
            "apps/single-workspace/src/runnable-source-p7.ts",
          ),
        ),
      ).toBe(true);
    }),
  );
};
