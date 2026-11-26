import { Effect, Option } from "effect";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { CommandHandlerRegistry } from "../../packages/application/src/index.js";
import {
  parse,
  WorkRevision,
  workBound,
} from "../../packages/domain/dist/index.js";
import { p7SeedProject } from "../support/consumer-harness.js";

import {
  cmd,
  DEP_A1,
  DEP_A2,
  expectedOf,
  makeStoryApp,
  P7_PHASE_COMMAND_TYPES,
  REV,
  runStory,
  submitDeclare,
  WORK_A_CHILD,
  WORK_A_PARENT,
  WORK_A_SIBLING,
} from "./support.js";
import {
  classifyRoot,
  countEvents,
  countRows,
  decideFromTable,
  depChanged,
  eventPayloads,
  insertWait,
  seedWorks,
  setCurrentWork,
  storedDependency,
  timeReached,
} from "./support-store.js";

export const storyADeclareYieldQuiescence = async (): Promise<void> => {
  const { app } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      const registry = yield* CommandHandlerRegistry;
      for (const commandType of P7_PHASE_COMMAND_TYPES) {
        expect(Option.isSome(registry.lookup(commandType)), commandType).toBe(
          true,
        );
      }

      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      yield* seedWorks([
        [WORK_A_CHILD, cmd("89a0000000a1")],
        [WORK_A_PARENT, cmd("89a0000000a2")],
      ]);

      const declared = yield* submitDeclare(cmd("89a0000000a3"), {
        dependencyId: DEP_A1,
        consumerWorkId: WORK_A_CHILD,
        producerBinding: workBound(WORK_A_PARENT),
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declared.resolution._tag).toBe("Committed");
      if (declared.resolution._tag === "Committed") {
        expect(declared.resolution.result.state).toBe("Unsatisfied");
        expect(declared.resolution.result.revision).toBe(0);
      }
      expect(yield* countEvents("DependencyDeclared")).toBe(1);
      const declaredPayloads = yield* eventPayloads("DependencyDeclared");
      expect(declaredPayloads[0]).toEqual({
        dependencyId: DEP_A1,
        consumerWorkId: WORK_A_CHILD,
        producerBinding: { _tag: "WorkBound", workId: WORK_A_PARENT },
        expectedDeliverable: {
          kind: "report",
          requiredArtifactRoles: ["summary"],
        },
        revision: 0,
      });
      const stored = yield* storedDependency(DEP_A1);
      expect(stored?.state).toBe("Unsatisfied");
      expect(stored?.revision).toBe(0);

      const beforeYield = yield* classifyRoot;
      expect([...beforeYield.runnable]).toEqual([WORK_A_CHILD, WORK_A_PARENT]);

      yield* insertWait(WORK_A_CHILD, [depChanged(DEP_A1)]);
      yield* setCurrentWork(WORK_A_CHILD);
      yield* insertWait(WORK_A_PARENT, [timeReached]);

      const blocked = yield* classifyRoot;
      expect(blocked.current).toEqual(Option.none());
      expect([...blocked.runnable]).toEqual([]);
      expect(decideFromTable(blocked.current, blocked.runnable)).toEqual({
        _tag: "Idle",
      });
      expect(yield* countRows("provider_turns")).toBe(0);

      yield* seedWorks([[WORK_A_SIBLING, cmd("89a0000000a4")]]);
      const unyielded = yield* submitDeclare(cmd("89a0000000a5"), {
        dependencyId: DEP_A2,
        consumerWorkId: WORK_A_SIBLING,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(unyielded.resolution._tag).toBe("Committed");
      const afterSecond = yield* classifyRoot;
      expect(afterSecond.current).toEqual(Option.none());
      expect([...afterSecond.runnable]).toEqual([WORK_A_SIBLING]);
    }),
  );
};
