import {
  executionEpisode,
  type Work,
  type Workspace,
  workEpisode,
} from "@arbor/domain";
import {
  LocalPlanStore,
  type PortableInputItem,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ModelDecisionDependencies } from "../contract.js";
import type { DecisionWorkspaceContextError } from "./errors.js";

type WorkspaceContextDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "tx" | "workspaces" | "works"
>;

/** Read the bound workspace, accepted knowledge, placement and work plan.
 * Return context additions rather than mutating the decision driver's arrays. */
export const loadDecisionWorkspaceContext = (
  dependencies: WorkspaceContextDependencies,
  placementExecution: boolean,
): Effect.Effect<
  {
    readonly workspace: Option.Some<Workspace>;
    readonly currentWork: Work | null;
    readonly inputItems: PortableInputItem[];
    readonly messageContextRefs: string[];
    readonly localPlanScope: boolean;
  },
  DecisionWorkspaceContextError,
  LocalPlanStore | WorkspaceKnowledgePort | WorkspacePlacementPort
> => {
  const { input, tx, workspaces, works } = dependencies;
  return Effect.gen(function* () {
    // E05 sink: these capabilities belong to this module alone; they are
    // acquired from the environment instead of travelling through the
    // giant Dependencies object.
    const workspaceKnowledge = yield* WorkspaceKnowledgePort;
    const workspacePlacement = yield* WorkspacePlacementPort;
    const localPlans = yield* LocalPlanStore;
    const inputItems: PortableInputItem[] = [];
    const messageContextRefs: string[] = [];
    let localPlanScope = false;
    const workspace = yield* tx.transact(
      workspaces.findById(input.execution.workspaceId),
    );
    if (Option.isNone(workspace)) {
      return yield* Effect.fail<DecisionWorkspaceContextError>({
        _tag: "WorkspaceContextMissing",
        workspaceId: input.execution.workspaceId,
      });
    }
    {
      const knowledge = yield* workspaceKnowledge.load(
        input.execution.workspaceId,
      );
      if (knowledge.entries.length > 0) {
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `workspace-knowledge:${input.execution.workspaceId}`,
          revision: Number(workspace.value.revision),
          updateKind: "Full",
          text: JSON.stringify({
            scope: "accepted-workspace-knowledge",
            provenance: "CanonicalAcceptance",
            entries: knowledge.entries,
          }),
        });
        messageContextRefs.push(
          `workspace-knowledge:${input.execution.workspaceId}:${knowledge.fingerprint}`,
        );
      }
    }
    if (placementExecution) {
      const placement = yield* workspacePlacement.list({
        rootWorkspaceId: input.execution.workspaceId,
      });
      inputItems.push({
        _tag: "ContextUpdate",
        sourceRef: `workspace-placement:${input.execution.workspaceId}`,
        revision: Number(workspace.value.revision),
        updateKind: "Full",
        text: JSON.stringify({
          scope: "workspace-placement",
          current: placement.current,
          directChildren: placement.directChildren,
          inFlightFormations: placement.inFlightFormations,
          nextCursor: placement.nextCursor,
        }),
      });
      messageContextRefs.push(
        `workspace-placement:${input.execution.workspaceId}:${placement.fingerprint}`,
      );
    }
    let currentWork: Work | null = null;
    const boundWork = workEpisode(input.execution);
    if (boundWork !== null) {
      const work = yield* tx.transact(works.findById(boundWork.workId));
      if (Option.isNone(work)) {
        return yield* Effect.fail<DecisionWorkspaceContextError>({
          _tag: "WorkContextMissing",
          workId: boundWork.workId,
        });
      }
      currentWork = work.value;
      if (executionEpisode(input.execution)?._tag === "WorkEpisode") {
        localPlanScope = true;
        const plan = yield* tx.transact(
          localPlans.findByWork(boundWork.workId),
        );
        if (
          Option.isSome(plan) &&
          plan.value.targetWorkRevision === currentWork.revision
        ) {
          inputItems.push({
            _tag: "ContextUpdate",
            sourceRef: `local-plan:${boundWork.workId}`,
            revision: plan.value.revision,
            updateKind: "Full",
            text: JSON.stringify({
              scope: "progress-only",
              items: plan.value.items,
            }),
          });
          messageContextRefs.push(
            `local-plan:${boundWork.workId}:${String(plan.value.revision)}`,
          );
        }
      }
    }
    return {
      workspace,
      currentWork,
      inputItems,
      messageContextRefs,
      localPlanScope,
    };
  });
};
