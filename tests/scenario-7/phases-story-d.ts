import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import type {
  SatisfyDependencyPayload,
  SatisfyDependencyResult,
} from "../../packages/application/src/commands/satisfy-dependency.js";
import {
  CommandGateway,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import {
  type CommandId,
  type DeliverableKind,
  type DependencyId,
  markUnfulfillableOnProducerLoss,
  type ProducerBinding,
  type ProducerLossFacts,
  parse,
  WorkRevision,
  workBound,
  workspaceBound,
} from "../../packages/domain/dist/index.js";
import {
  DependencyRepository,
  DomainEventJournal,
  type PendingDomainEvent,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
  p7TestPrincipal,
} from "../support/consumer-harness.js";

import {
  ART_D,
  cmd,
  DEL_D_AGENT,
  DEL_D_SAT,
  DEP_D_AGENT,
  DEP_D_LOSS_ANY,
  DEP_D_LOSS_WB,
  DEP_D_LOSS_WS,
  DEP_D_MARKED,
  DEP_D_REVISED,
  DEP_D_SATISFIED,
  DEP_D_WITHDRAWN,
  EXE_D,
  envelopeOf,
  expectedOf,
  externalContext,
  fingerprintOf,
  makeStoryApp,
  REV,
  runStory,
  submitDeclare,
  submitMark,
  submitProduce,
  submitRevise,
  submitSatisfy,
  submitWithdraw,
  WORK_D_AGENT,
  WORK_D_CONSUMER,
  WORK_D_PRODUCER,
} from "./support.js";
import {
  countEvents,
  eventPayloads,
  runCoordinatorOverProducedEvents,
  seedWorks,
  storedDependency,
} from "./support-store.js";

export const storyDReviseWithdrawMarkAgentSatisfy = async (): Promise<void> => {
  const { app } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      yield* seedWorks([
        [WORK_D_CONSUMER, cmd("89d000000001")],
        [WORK_D_PRODUCER, cmd("89d000000002")],
        [WORK_D_AGENT, cmd("89d000000003")],
      ]);

      const declaredSat = yield* submitDeclare(cmd("89d000000004"), {
        dependencyId: DEP_D_SATISFIED,
        consumerWorkId: WORK_D_CONSUMER,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredSat.resolution._tag).toBe("Committed");
      const produced = yield* submitProduce(cmd("89d000000005"), {
        deliverableId: DEL_D_SAT,
        sourceWorkId: WORK_D_PRODUCER,
        observedSourceWorkRevision: parse(WorkRevision)(0),
        kind: "report" as never as DeliverableKind,
        artifacts: [{ role: "summary" as never, artifactId: ART_D }],
      });
      expect(produced.resolution._tag).toBe("Committed");
      const coordinated = yield* runCoordinatorOverProducedEvents;
      expect(coordinated).toContain("SatisfyDependency");
      const satisfied = yield* storedDependency(DEP_D_SATISFIED);
      expect(satisfied?.state).toBe("Satisfied");
      expect(satisfied?.satisfiedAtDependencyRevision).toBe(0);

      const revisedAfterSatisfaction = yield* submitRevise(
        cmd("89d000000006"),
        {
          dependencyId: DEP_D_SATISFIED,
          targetDependencyRevision: REV(0),
          newExpectedDeliverable: expectedOf("report-v2", ["summary"]),
        },
      );
      expect(revisedAfterSatisfaction.resolution._tag).toBe("TerminalRejected");
      if (revisedAfterSatisfaction.resolution._tag === "TerminalRejected") {
        expect(revisedAfterSatisfaction.resolution.error._tag).toBe(
          "TerminalLifecycleMutation",
        );
      }
      const unchanged = yield* storedDependency(DEP_D_SATISFIED);
      expect(unchanged?.state).toBe("Satisfied");
      expect(unchanged?.revision).toBe(0);
      expect(unchanged?.satisfiedAtDependencyRevision).toBe(0);
      expect(unchanged?.satisfiedByDeliverableId).toBe(DEL_D_SAT);

      const declaredRevise = yield* submitDeclare(cmd("89d000000007"), {
        dependencyId: DEP_D_REVISED,
        consumerWorkId: WORK_D_CONSUMER,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("chart", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredRevise.resolution._tag).toBe("Committed");
      const revised = yield* submitRevise(cmd("89d000000008"), {
        dependencyId: DEP_D_REVISED,
        targetDependencyRevision: REV(0),
        newExpectedDeliverable: expectedOf("chart-v2", ["summary", "legend"]),
      });
      expect(revised.resolution._tag).toBe("Committed");
      if (revised.resolution._tag === "Committed") {
        expect(revised.resolution.result.toRevision).toBe(1);
      }
      const revisedStored = yield* storedDependency(DEP_D_REVISED);
      expect(revisedStored?.state).toBe("Unsatisfied");
      expect(revisedStored?.revision).toBe(1);
      expect(revisedStored?.expectedDeliverable).toEqual({
        kind: "chart-v2",
        requiredArtifactRoles: ["summary", "legend"],
      });
      expect(yield* countEvents("DependencyContractRevised")).toBe(1);

      const declaredWithdraw = yield* submitDeclare(cmd("89d000000009"), {
        dependencyId: DEP_D_WITHDRAWN,
        consumerWorkId: WORK_D_CONSUMER,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("chart", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredWithdraw.resolution._tag).toBe("Committed");
      const withdrawn = yield* submitWithdraw(cmd("89d00000000a"), {
        dependencyId: DEP_D_WITHDRAWN,
        targetDependencyRevision: REV(0),
        reason: "consumer no longer needs the result",
      });
      expect(withdrawn.resolution._tag).toBe("Committed");
      const withdrawnStored = yield* storedDependency(DEP_D_WITHDRAWN);
      expect(withdrawnStored?.state).toBe("Withdrawn");
      expect(withdrawnStored?.revision).toBe(0);
      const withdrawnPayloads = yield* eventPayloads("DependencyWithdrawn");
      expect(withdrawnPayloads).toHaveLength(1);
      expect(withdrawnPayloads[0]).toEqual({
        dependencyId: DEP_D_WITHDRAWN,
        dependencyRevision: 0,
        reason: "consumer no longer needs the result",
      });

      const declaredMark = yield* submitDeclare(cmd("89d00000000b"), {
        dependencyId: DEP_D_MARKED,
        consumerWorkId: WORK_D_CONSUMER,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("chart", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredMark.resolution._tag).toBe("Committed");
      const marked = yield* submitMark(cmd("89d00000000c"), {
        dependencyId: DEP_D_MARKED,
        targetDependencyRevision: REV(0),
        justification: "adjudicated unfulfillable after producer loss",
      });
      expect(marked.resolution._tag).toBe("Committed");
      const markedStored = yield* storedDependency(DEP_D_MARKED);
      expect(markedStored?.state).toBe("Unfulfillable");
      const markedPayloads = yield* eventPayloads(
        "DependencyMarkedUnfulfillable",
      );
      expect(markedPayloads).toHaveLength(1);
      expect(markedPayloads[0]).toEqual({
        dependencyId: DEP_D_MARKED,
        dependencyRevision: 0,
        justification: "adjudicated unfulfillable after producer loss",
      });

      const lossDeclarations: ReadonlyArray<
        readonly [DependencyId, ProducerBinding, CommandId]
      > = [
        [DEP_D_LOSS_WB, workBound(WORK_D_PRODUCER), cmd("89d00000000d")],
        [DEP_D_LOSS_WS, workspaceBound(p7RootWorkspace), cmd("89d00000000e")],
        [DEP_D_LOSS_ANY, { _tag: "AnyProducer" }, cmd("89d00000000f")],
      ];
      for (const [dependencyId, binding, commandId] of lossDeclarations) {
        const declared = yield* submitDeclare(commandId, {
          dependencyId,
          consumerWorkId: WORK_D_CONSUMER,
          producerBinding: binding,
          expectedDeliverable: expectedOf("losskind", ["summary"]),
          expectedConsumerWorkRevision: parse(WorkRevision)(0),
          revision: REV(0),
        });
        expect(declared.resolution._tag).toBe("Committed");
      }
      const repository = yield* DependencyRepository;
      const journal = yield* DomainEventJournal;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      yield* tx.transact(
        Effect.gen(function* () {
          yield* sql.unsafe(
            "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
            [WORK_D_PRODUCER],
          );
          const unsatisfied =
            yield* repository.listUnsatisfiedByProject(p7Project);
          const facts: ReadonlyArray<ProducerLossFacts> = [
            {
              binding: workBound(WORK_D_PRODUCER),
              lost: { _tag: "WorkCancelled", workId: WORK_D_PRODUCER },
              replacedInSameGovernanceChange: false,
            },
          ];
          const next = markUnfulfillableOnProducerLoss(facts, unsatisfied);
          const events: PendingDomainEvent[] = [];
          for (let index = 0; index < unsatisfied.length; index += 1) {
            // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
            const before = unsatisfied[index]!;
            // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
            const after = next[index]!;
            if (before.state === after.state) {
              continue;
            }
            yield* repository.transitionIfUnsatisfiedRevision(
              before.dependencyId,
              before.revision,
              after,
            );
            events.push({
              projectId: p7Project,
              eventType: "DependencyMarkedUnfulfillable",
              eventVersion: 1,
              occurredAt: "t",
              aggregateRef: before.dependencyId,
              actor: p7TestActor,
              payload: {
                dependencyId: before.dependencyId,
                dependencyRevision: after.revision,
                justification: `producer lost: work ${WORK_D_PRODUCER} cancelled`,
              },
            });
          }
          yield* journal.append(events);
        }),
      );
      const lossWorkBound = yield* storedDependency(DEP_D_LOSS_WB);
      expect(lossWorkBound?.state).toBe("Unfulfillable");
      const lossWorkspaceBound = yield* storedDependency(DEP_D_LOSS_WS);
      expect(lossWorkspaceBound?.state).toBe("Unsatisfied");
      const lossAnyProducer = yield* storedDependency(DEP_D_LOSS_ANY);
      expect(lossAnyProducer?.state).toBe("Unsatisfied");
      const batchPayloads = yield* eventPayloads(
        "DependencyMarkedUnfulfillable",
      );
      expect(batchPayloads).toHaveLength(2);
      expect(batchPayloads[1]?.dependencyId).toBe(DEP_D_LOSS_WB);

      const declaredAgent = yield* submitDeclare(cmd("89d000000010"), {
        dependencyId: DEP_D_AGENT,
        consumerWorkId: WORK_D_AGENT,
        producerBinding: { _tag: "AnyProducer" },
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredAgent.resolution._tag).toBe("Committed");
      const producedAgent = yield* submitProduce(cmd("89d000000011"), {
        deliverableId: DEL_D_AGENT,
        sourceWorkId: WORK_D_AGENT,
        observedSourceWorkRevision: parse(WorkRevision)(0),
        kind: "report" as never as DeliverableKind,
        artifacts: [{ role: "summary" as never, artifactId: ART_D }],
      });
      expect(producedAgent.resolution._tag).toBe("Committed");
      const beforeAgentSatisfy = yield* countEvents("DependencySatisfied");
      const agentSatisfy = yield* submitSatisfy(
        cmd("89d000000012"),
        {
          dependencyId: DEP_D_AGENT,
          targetDependencyRevision: REV(0),
          deliverableId: DEL_D_AGENT,
        },
        {
          _tag: "ConsumerExecution",
          workspaceId: p7RootWorkspace,
          executionId: EXE_D,
        },
      );
      expect(agentSatisfy.resolution._tag).toBe("Committed");
      if (agentSatisfy.resolution._tag === "Committed") {
        expect(agentSatisfy.resolution.result.state).toBe("Satisfied");
        expect(agentSatisfy.resolution.result.wakeSignals).toHaveLength(1);
        expect(agentSatisfy.resolution.result.wakeSignals[0]?.reason).toEqual({
          _tag: "DependencySatisfied",
        });
      }
      expect(yield* countEvents("DependencySatisfied")).toBe(
        beforeAgentSatisfy + 1,
      );
      const agentSatisfied = yield* storedDependency(DEP_D_AGENT);
      expect(agentSatisfied?.state).toBe("Satisfied");
      expect(agentSatisfied?.satisfiedByDeliverableId).toBe(DEL_D_AGENT);

      const wrongAuthority = yield* Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        const payload: SatisfyDependencyPayload = {
          dependencyId: DEP_D_AGENT,
          targetDependencyRevision: REV(0),
          deliverableId: DEL_D_AGENT,
        };
        const commandId = cmd("89d000000013");
        return yield* gateway.execute<
          SatisfyDependencyPayload,
          SatisfyDependencyResult
        >(
          envelopeOf("SatisfyDependency", commandId, payload),
          externalContext,
          {
            _tag: "SteerWorkAuthority",
            principal: p7TestPrincipal,
            commandId,
            semanticRequestFingerprint: fingerprintOf(
              "SatisfyDependency",
              payload,
            ),
            projectId: p7Project,
            targetWorkspaceId: p7RootWorkspace,
            workId: WORK_D_AGENT,
          } as unknown as VerifiedCommandAuthority,
        );
      });
      expect(wrongAuthority.resolution._tag).toBe("TerminalRejected");
      if (wrongAuthority.resolution._tag === "TerminalRejected") {
        expect(wrongAuthority.resolution.error._tag).toBe("AuthorityDenied");
      }
    }),
  );
};
