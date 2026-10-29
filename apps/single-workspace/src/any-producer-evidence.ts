import {
  type Dependency,
  matchesExpectedDeliverable,
  type ProjectId,
  type Work,
  type WorkId,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  DeliverableRepositoryService,
  FormationFulfillmentStoreService,
  FormationProposalStoreService,
  ProjectRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
  WorkWait,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface AnyProducerEvidenceDependencies {
  readonly projects: Pick<ProjectRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly listWorkspaceIdsByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceId>, unknown>;
  readonly works: Pick<WorkRepositoryService, "listByWorkspace">;
  readonly proposals: Pick<FormationProposalStoreService, "listByParent">;
  readonly fulfillments: Pick<
    FormationFulfillmentStoreService,
    "findByProposal"
  >;
  readonly deliverables: Pick<
    DeliverableRepositoryService,
    "listByProject" | "listArtifactRoles"
  >;
  readonly tx: TransactionPortService;
}

export interface AnyProducerEvidenceRequest {
  readonly projectId: ProjectId;
  readonly consumerWorkId: WorkId;
  readonly expectedDeliverable: {
    readonly kind: string;
    readonly requiredArtifactRoles: ReadonlyArray<string>;
  };
}

export interface MatchingAnyProducerDeliverable {
  readonly deliverableId: string;
  readonly sourceWorkId: WorkId;
}

export interface AnyProducerEvidenceFacts {
  readonly workspaceIds: ReadonlyArray<WorkspaceId>;
  readonly otherOpenWork: boolean;
  readonly approvedMaterializingFormation: boolean;
  readonly matchingDeliverables: ReadonlyArray<MatchingAnyProducerDeliverable>;
  readonly pendingFormation: boolean;
  readonly projectOpen: boolean;
}

export const isSettledAnyProducerWaitEligible = (input: {
  readonly projectId: ProjectId;
  readonly projectOpen: boolean;
  readonly projectHasActiveExecution: boolean;
  readonly dependency: Dependency;
  readonly consumerWork: Work | undefined;
  readonly wait: WorkWait | undefined;
  readonly evidence: AnyProducerEvidenceFacts;
  readonly matchingDeliverableMayConverge: boolean;
}): boolean => {
  const { dependency, consumerWork, wait, evidence } = input;
  return (
    input.projectOpen &&
    !input.projectHasActiveExecution &&
    dependency.state === "Unsatisfied" &&
    dependency.producerBinding._tag === "AnyProducer" &&
    consumerWork !== undefined &&
    consumerWork.projectId === input.projectId &&
    consumerWork.workId === dependency.consumerWorkId &&
    consumerWork.lifecycle === "Open" &&
    wait !== undefined &&
    wait.waitSpec.mode === "Any" &&
    wait.waitSpec.conditions.some(
      (condition) =>
        condition._tag === "DependencyChanged" &&
        condition.dependencyId === dependency.dependencyId &&
        Number(condition.observedRevision) === Number(dependency.revision),
    ) &&
    !evidence.otherOpenWork &&
    !evidence.approvedMaterializingFormation &&
    !evidence.pendingFormation &&
    !input.matchingDeliverableMayConverge
  );
};

/** Caller must execute this query inside the transaction that owns the
 * surrounding read. It inspects only canonical IDs, lifecycle/state, and
 * P7 matcher fields—never Work/proposal prose, Message/Inbox, or Provider
 * text. */
export const collectAnyProducerEvidenceFacts = (
  dependencies: AnyProducerEvidenceDependencies,
  request: AnyProducerEvidenceRequest,
) =>
  Effect.gen(function* () {
    const project = yield* dependencies.projects.findById(request.projectId);
    if (Option.isNone(project)) {
      return yield* Effect.fail(
        new Error("AnyProducer evidence Project is unavailable"),
      );
    }
    const workspaceIds = yield* dependencies.listWorkspaceIdsByProject(
      request.projectId,
    );
    if (!workspaceIds.includes(project.value.rootWorkspaceId)) {
      return yield* Effect.fail(
        new Error("AnyProducer evidence Project root is unavailable"),
      );
    }
    const validWorkspaceIds: WorkspaceId[] = [];
    for (const workspaceId of workspaceIds) {
      const workspace = yield* dependencies.workspaces.findById(workspaceId);
      if (
        Option.isSome(workspace) &&
        workspace.value.projectId === request.projectId
      ) {
        validWorkspaceIds.push(workspaceId);
      }
    }

    const worksByWorkspace = yield* Effect.forEach(
      validWorkspaceIds,
      (workspaceId) => dependencies.works.listByWorkspace(workspaceId),
      { concurrency: 1 },
    );
    const projectWorks = worksByWorkspace
      .flat()
      .filter((work) => work.projectId === request.projectId);

    let pendingFormation = false;
    let approvedMaterializingFormation = false;
    for (const parentWorkspaceId of validWorkspaceIds) {
      const proposals =
        yield* dependencies.proposals.listByParent(parentWorkspaceId);
      for (const proposal of proposals) {
        if (proposal.state === "Pending") pendingFormation = true;
        if (proposal.state !== "Approved") continue;
        const fulfillment = yield* dependencies.fulfillments.findByProposal(
          proposal.proposalId,
          proposal.revision,
        );
        if (
          Option.isSome(fulfillment) &&
          (fulfillment.value.state === "PendingApplication" ||
            fulfillment.value.state === "WorkspaceCreated") &&
          fulfillment.value.expectedInitialWorkId !== null
        ) {
          approvedMaterializingFormation = true;
        }
      }
    }

    const deliverables = yield* dependencies.deliverables.listByProject(
      request.projectId,
    );
    const matchingDeliverables: MatchingAnyProducerDeliverable[] = [];
    for (const deliverable of deliverables) {
      const sourceWork = projectWorks.find(
        (work) => work.workId === deliverable.sourceWorkId,
      );
      if (sourceWork === undefined) continue;
      const roles = yield* dependencies.deliverables.listArtifactRoles(
        deliverable.deliverableId,
      );
      if (
        matchesExpectedDeliverable(
          { _tag: "AnyProducer" },
          request.expectedDeliverable as never,
          {
            deliverableId: deliverable.deliverableId,
            sourceWorkId: deliverable.sourceWorkId,
            sourceWorkspaceId: sourceWork.workspaceId,
            kind: deliverable.kind as never,
            artifactRoles: new Set(roles as never),
          },
        )
      ) {
        matchingDeliverables.push({
          deliverableId: deliverable.deliverableId,
          sourceWorkId: deliverable.sourceWorkId,
        });
      }
    }
    return {
      workspaceIds: validWorkspaceIds,
      otherOpenWork: projectWorks.some(
        (work) =>
          work.workId !== request.consumerWorkId && work.lifecycle === "Open",
      ),
      approvedMaterializingFormation,
      matchingDeliverables,
      pendingFormation,
      projectOpen: project.value.lifecycle === "Open",
    } satisfies AnyProducerEvidenceFacts;
  });

export const readAnyProducerEvidenceFacts = (
  dependencies: AnyProducerEvidenceDependencies,
  request: AnyProducerEvidenceRequest,
) =>
  dependencies.tx.transact(
    collectAnyProducerEvidenceFacts(dependencies, request),
  );

export const hasAnyProducerEvidence = (
  dependencies: AnyProducerEvidenceDependencies,
  request: AnyProducerEvidenceRequest,
) =>
  Effect.map(
    readAnyProducerEvidenceFacts(dependencies, request),
    (facts) =>
      facts.otherOpenWork ||
      facts.approvedMaterializingFormation ||
      facts.matchingDeliverables.length > 0,
  );
