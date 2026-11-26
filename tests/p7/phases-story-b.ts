import { Effect, Option } from "effect";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { satisfactionCommandId } from "../../packages/application/src/commands/satisfy-dependency.js";
import { deliverWakeSignal } from "../../packages/application/src/index.js";
import {
  type DeliverableKind,
  parse,
  WorkRevision,
  workBound,
} from "../../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { p7RootWorkspace, p7SeedProject } from "../support/consumer-harness.js";

import {
  ART_B,
  cmd,
  DEL_B1,
  DEL_B2,
  DEP_B1,
  DEP_B2,
  EXE_B,
  expectedOf,
  makeStoryApp,
  REV,
  runStory,
  submitDeclare,
  submitProduce,
  submitRevise,
  submitSatisfy,
  WORK_B_CONSUMER,
  WORK_B_PRODUCER,
} from "./support.js";
import {
  classifyRoot,
  countEvents,
  depChanged,
  insertWait,
  makeSinkDeps,
  receiptResolution,
  runCoordinatorOverProducedEvents,
  seedWorks,
  storedDependency,
} from "./support-store.js";

export const storyBProduceAutoSatisfyWake = async (): Promise<void> => {
  const { app, calls } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      yield* seedWorks([
        [WORK_B_CONSUMER, cmd("89b0000000b1")],
        [WORK_B_PRODUCER, cmd("89b0000000b2")],
      ]);

      const declaredFirst = yield* submitDeclare(cmd("89b0000000b3"), {
        dependencyId: DEP_B1,
        consumerWorkId: WORK_B_CONSUMER,
        producerBinding: workBound(WORK_B_PRODUCER),
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredFirst.resolution._tag).toBe("Committed");
      const declaredSecond = yield* submitDeclare(cmd("89b0000000b4"), {
        dependencyId: DEP_B2,
        consumerWorkId: WORK_B_CONSUMER,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("diagram", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredSecond.resolution._tag).toBe("Committed");

      yield* insertWait(WORK_B_CONSUMER, [depChanged(DEP_B1)]);
      const blocked = yield* classifyRoot;
      expect(blocked.runnable).not.toContain(WORK_B_CONSUMER);

      const revised = yield* submitRevise(cmd("89b0000000b5"), {
        dependencyId: DEP_B1,
        targetDependencyRevision: REV(0),
        newExpectedDeliverable: expectedOf("report", ["summary"]),
      });
      expect(revised.resolution._tag).toBe("Committed");
      if (revised.resolution._tag === "Committed") {
        expect(revised.resolution.result.fromRevision).toBe(0);
        expect(revised.resolution.result.toRevision).toBe(1);
      }
      expect(yield* countEvents("DependencyContractRevised")).toBe(1);

      const producedFirst = yield* submitProduce(cmd("89b0000000b6"), {
        deliverableId: DEL_B1,
        sourceWorkId: WORK_B_PRODUCER,
        observedSourceWorkRevision: parse(WorkRevision)(0),
        kind: "report" as never as DeliverableKind,
        artifacts: [{ role: "summary" as never, artifactId: ART_B }],
      });
      expect(producedFirst.resolution._tag).toBe("Committed");
      if (producedFirst.resolution._tag === "Committed") {
        expect(producedFirst.resolution.result.sourceWorkRevision).toBe(0);
      }
      const producedSecond = yield* submitProduce(cmd("89b0000000b7"), {
        deliverableId: DEL_B2,
        sourceWorkId: WORK_B_PRODUCER,
        observedSourceWorkRevision: parse(WorkRevision)(0),
        kind: "report" as never as DeliverableKind,
        artifacts: [{ role: "summary" as never, artifactId: ART_B }],
      });
      expect(producedSecond.resolution._tag).toBe("Committed");
      expect(yield* countEvents("DeliverableProduced")).toBe(2);
      const deliverables = yield* DeliverableRepository;
      const tx = yield* TransactionPort;
      const storedDeliverable = yield* tx.transact(
        deliverables.findById(DEL_B1),
      );
      expect(Option.isSome(storedDeliverable)).toBe(true);
      if (Option.isSome(storedDeliverable)) {
        expect(storedDeliverable.value.sourceWorkRevision).toBe(0);
        expect(storedDeliverable.value.sourceWorkId).toBe(WORK_B_PRODUCER);
      }

      const records = yield* runCoordinatorOverProducedEvents;
      expect(records).toContain("SatisfyDependency");
      expect(records).toContain(`skipped:DependencyNotSatisfiable:${DEP_B2}`);

      const satisfied = yield* storedDependency(DEP_B1);
      expect(satisfied?.state).toBe("Satisfied");
      expect(satisfied?.satisfiedByDeliverableId).toBe(DEL_B1);
      expect(satisfied?.revision).toBe(1);
      expect(satisfied?.satisfiedAtDependencyRevision).toBe(1);
      expect(yield* countEvents("DependencySatisfied")).toBe(1);
      expect(
        yield* receiptResolution(satisfactionCommandId(DEL_B1, DEP_B1, REV(1))),
      ).toBe("Committed");

      const replay = yield* runCoordinatorOverProducedEvents;
      expect(replay).not.toContain("SatisfyDependency");
      expect(yield* countEvents("DependencySatisfied")).toBe(1);
      const mismatched = yield* storedDependency(DEP_B2);
      expect(mismatched?.state).toBe("Unsatisfied");
      expect(mismatched?.satisfiedByDeliverableId).toBeUndefined();

      const loser = yield* submitSatisfy(
        cmd("89b0000000b8"),
        {
          dependencyId: DEP_B1,
          targetDependencyRevision: REV(1),
          deliverableId: DEL_B2,
        },
        {
          _tag: "ConsumerExecution",
          workspaceId: p7RootWorkspace,
          executionId: EXE_B,
        },
      );
      expect(loser.resolution._tag).toBe("TerminalRejected");
      if (loser.resolution._tag === "TerminalRejected") {
        expect(loser.resolution.error._tag).toBe("TerminalLifecycleMutation");
      }
      const afterRace = yield* storedDependency(DEP_B1);
      expect(afterRace?.satisfiedByDeliverableId).toBe(DEL_B1);
      expect(afterRace?.satisfiedAtDependencyRevision).toBe(1);

      const stillWaiting = yield* classifyRoot;
      expect(stillWaiting.runnable).not.toContain(WORK_B_CONSUMER);

      const signal = {
        workspaceId: p7RootWorkspace,
        reason: "DependencySatisfied" as const,
        detail: {
          dependencyId: DEP_B1,
          fromRevision: satisfied?.revision ?? 1,
          toRevision: satisfied?.revision ?? 1,
        },
      };
      const sink = yield* makeSinkDeps;
      const delivery = yield* deliverWakeSignal(signal, sink);
      expect(delivery).toEqual({ woke: true, clearedWaits: 1 });
      expect(calls).toContainEqual({
        workspaceId: p7RootWorkspace,
        wakeReasonTag: "DependencySatisfied",
      });
      const afterWake = yield* classifyRoot;
      expect([...afterWake.runnable]).toEqual([
        WORK_B_CONSUMER,
        WORK_B_PRODUCER,
      ]);
      const redelivered = yield* deliverWakeSignal(signal, sink);
      expect(redelivered).toEqual({ woke: false, clearedWaits: 0 });
      expect(yield* countEvents("DependencySatisfied")).toBe(1);
    }),
  );
};
