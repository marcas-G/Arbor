import { satisfactionCommandId } from "@arbor/application";
import type { ProjectId, WorkspaceId } from "@arbor/domain";
import type {
  CommandStoreService,
  DependencyRepositoryService,
  ExecutionRepositoryService,
  WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type AnyProducerEvidenceDependencies,
  collectAnyProducerEvidenceFacts,
  isSettledAnyProducerWaitEligible,
} from "./any-producer-evidence.js";

export interface AnyProducerAttentionDependencies {
  readonly evidence: AnyProducerEvidenceDependencies;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findUnsettledExecutions"
  >;
  readonly waits: Pick<WorkWaitStoreService, "listActive">;
  readonly dependencies: Pick<
    DependencyRepositoryService,
    "listUnsatisfiedByProject"
  >;
  readonly commandReceipts: Pick<CommandStoreService, "findResolution">;
}

/** APW-3's full read-side query. The transaction encloses the canonical
 * Dependency/WorkWait/Work/Execution/formation/Deliverable/receipt reads so
 * the derived Attention never combines different snapshots. */
export const listAnyProducerSettledWaits = (
  dependencies: AnyProducerAttentionDependencies,
  projectId: ProjectId,
) =>
  dependencies.evidence.tx.transact(
    Effect.gen(function* () {
      const project = yield* dependencies.evidence.projects.findById(projectId);
      if (Option.isNone(project) || project.value.lifecycle !== "Open") {
        return [];
      }
      const workspaceIds =
        yield* dependencies.evidence.listWorkspaceIdsByProject(projectId);
      const projectWorkspaces = [] as Array<{
        readonly workspaceId: WorkspaceId;
      }>;
      for (const workspaceId of workspaceIds) {
        const workspace =
          yield* dependencies.evidence.workspaces.findById(workspaceId);
        if (
          Option.isSome(workspace) &&
          workspace.value.projectId === projectId &&
          workspace.value.lifecycle === "Active"
        ) {
          projectWorkspaces.push(workspace.value);
        }
      }
      const activeExecutions =
        yield* dependencies.executions.findUnsettledExecutions();
      if (
        activeExecutions.some(
          (execution) =>
            execution.projectId === projectId &&
            execution.state.status === "Active",
        )
      ) {
        return [];
      }
      const projectWorks = yield* Effect.forEach(
        projectWorkspaces,
        (workspace) =>
          dependencies.evidence.works.listByWorkspace(workspace.workspaceId),
        { concurrency: 1 },
      );
      const openWorks = projectWorks
        .flat()
        .filter(
          (work) => work.projectId === projectId && work.lifecycle === "Open",
        );
      const waits = yield* dependencies.waits.listActive();
      const output: Array<{
        readonly dependencyId: string;
        readonly consumerWorkspaceId: WorkspaceId;
      }> = [];

      for (const dependency of yield* dependencies.dependencies.listUnsatisfiedByProject(
        projectId,
      )) {
        if (
          dependency.state !== "Unsatisfied" ||
          dependency.producerBinding._tag !== "AnyProducer"
        ) {
          continue;
        }
        const consumerWork = openWorks.find(
          (work) => work.workId === dependency.consumerWorkId,
        );
        if (consumerWork === undefined) continue;
        const wait = waits.find(
          (candidate) => candidate.workId === dependency.consumerWorkId,
        );
        const evidence = yield* collectAnyProducerEvidenceFacts(
          dependencies.evidence,
          {
            projectId,
            consumerWorkId: dependency.consumerWorkId,
            expectedDeliverable: dependency.expectedDeliverable,
          },
        );
        let matchingDeliverableMayConverge = false;
        for (const deliverable of evidence.matchingDeliverables) {
          const receipt = yield* dependencies.commandReceipts.findResolution(
            satisfactionCommandId(
              deliverable.deliverableId as never,
              dependency.dependencyId,
              dependency.revision,
            ),
          );
          if (
            Option.isNone(receipt) ||
            (receipt.value.resolution !== "Committed" &&
              receipt.value.resolution !== "TerminalRejected")
          ) {
            matchingDeliverableMayConverge = true;
            break;
          }
        }
        if (
          !isSettledAnyProducerWaitEligible({
            projectId,
            projectOpen: evidence.projectOpen,
            projectHasActiveExecution: false,
            dependency,
            consumerWork,
            wait,
            evidence,
            matchingDeliverableMayConverge,
          })
        ) {
          continue;
        }
        const owner = yield* dependencies.evidence.workspaces.findById(
          consumerWork.workspaceId,
        );
        if (
          Option.isSome(owner) &&
          owner.value.projectId === projectId &&
          owner.value.lifecycle === "Active"
        ) {
          output.push({
            dependencyId: dependency.dependencyId,
            consumerWorkspaceId: owner.value.workspaceId,
          });
        }
      }
      return output;
    }),
  );
