import { executionEpisode, type ExecutionSettlement, type ProviderTurnId, type Work, type Workspace } from "@arbor/domain";
import type { ControlBasis, InstructionFragment } from "@arbor/model-context";
import type { AgentLoopStepRecord, ExecutionDriverError, PortableInputItem } from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ModelDecisionOutcome } from "../../agent-loop-policy.js";
import type { SummaryCompactionInput } from "../../compaction-coordinator.js";
import { GENERIC_INSTRUCTION_ASSETS, instructionAssetFragment } from "../../prompt-assets.js";
import { assembleWorkContext, type WorkContextAssembly } from "../../work-context.js";
import type { ModelDecisionDependencies } from "../contract.js";
import { classifySubmittedDecisionBindingFailure, isPinnedSubmittedDecisionReplay } from "../submitted-replay.js";

type InstructionDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "tx" | "loopSteps" | "providerTurns" | "decisionRequests" | "failure"
>;

export type CompactionWorkPinning = Pick<
  SummaryCompactionInput,
  "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis"
>;

type InstructionAssembly =
  | ModelDecisionOutcome
  | {
      readonly _tag: "Assembled";
      readonly workContext: WorkContextAssembly;
      readonly compactionWorkPinning: CompactionWorkPinning;
      readonly conversationActionFragments: ReadonlyArray<InstructionFragment>;
      readonly workExecutionLoopAsset: typeof GENERIC_INSTRUCTION_ASSETS.baseLoop;
      readonly instructionContents: Map<string, string>;
    };

/** Assemble canonical instruction fragments and the exact decision request
 * context. Input arrays belong to the current decision attempt. */
export const assembleDecisionInstructions = (
  dependencies: InstructionDependencies,
  phase: {
    readonly workspace: Option.Some<Workspace>;
    readonly currentWork: Work | null;
    readonly controlBasis: ControlBasis;
    readonly conversationExecution: boolean;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly providerTurnId: ProviderTurnId;
    readonly inputItems: PortableInputItem[];
    readonly messageContextRefs: string[];
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
  },
): Effect.Effect<InstructionAssembly, ExecutionDriverError> => {
  const { input, tx, loopSteps, providerTurns, decisionRequests, failure } = dependencies;
  const {
    workspace, currentWork, controlBasis, conversationExecution, loopStep,
    providerTurnId, inputItems, messageContextRefs, proposeSettlement,
  } = phase;
  return Effect.gen(function* () {
    const workContext = assembleWorkContext(
      workspace.value,
      currentWork,
      input.execution,
    );
    const compactionWorkPinning =
      executionEpisode(input.execution)?._tag === "WorkEpisode"
        ? {
            pinnedInstructions: workContext.fragments.map((fragment) => ({
              slotId: fragment.scope,
              authorityRole: fragment.authorityRole,
              text:
                workContext.contents.get(fragment.contentRef) ??
                fragment.contentRef,
            })),
            pinnedInstructionFragments: workContext.fragments.map(
              (fragment) => ({
                identity: fragment.identity,
                revision: fragment.revision,
                hash: fragment.hash,
                source: fragment.source,
                scope: fragment.scope,
              }),
            ),
            controlBasis,
          }
        : {};
    const conversationActionAsset =
      GENERIC_INSTRUCTION_ASSETS.rootConversationAction;
    const conversationActionFragments = conversationExecution
      ? [
          instructionAssetFragment(
            "root-conversation-action",
            conversationActionAsset,
          ),
        ]
      : [];
    const workExecutionLoopAsset = GENERIC_INSTRUCTION_ASSETS.baseLoop;
    const instructionContents = new Map(workContext.contents);
    if (conversationExecution) {
      instructionContents.set(
        conversationActionAsset.contentRef,
        conversationActionAsset.text,
      );
    }
    const boundEpisode = executionEpisode(input.execution);
    if (
      boundEpisode?._tag === "DecisionEpisode" &&
      decisionRequests !== undefined
    ) {
      const request = yield* tx
        .transact(decisionRequests.findById(boundEpisode.decisionId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(request)) {
        return yield* proposeSettlement({
          _tag: "Failed",
          failure: {
            _tag: "ExecutionFailure",
            reason: "DecisionRequestMissingOrSettled",
          },
        });
      }
      let requestContextRevision = request.value.revision;
      if (request.value.state._tag !== "Pending") {
        const pinnedActions =
          loopStep !== undefined && loopSteps !== undefined
            ? yield* tx
                .transact(loopSteps.listActions(loopStep.identity))
                .pipe(Effect.mapError(failure))
            : [];
        const pendingSelectionAction = pinnedActions.find(
          (action) =>
            action.actionIndex === loopStep?.nextActionIndex &&
            action.routeKind === "Control" &&
            action.actionKind === "select_current_work" &&
            action.state === "Pending",
        );
        const pinnedProviderResult =
          loopStep !== undefined && providerTurns !== undefined
            ? yield* tx
                .transact(
                  providerTurns.findSettledResult(loopStep.providerTurnId),
                )
                .pipe(Effect.mapError(failure))
            : undefined;
        const replayingPinnedSelection = isPinnedSubmittedDecisionReplay({
          executionWorkspaceId: String(input.execution.workspaceId),
          episode: boundEpisode,
          request: request.value,
          workspace: Option.isSome(workspace)
            ? {
                currentWorkId:
                  workspace.value.currentWorkId === null
                    ? null
                    : String(workspace.value.currentWorkId),
                revision: Number(workspace.value.revision),
              }
            : undefined,
          step: loopStep,
          pendingAction: pendingSelectionAction,
          providerTurnId: String(providerTurnId),
          providerResult:
            pinnedProviderResult?._tag === "SettledSuccess"
              ? {
                  _tag: "SettledSuccess",
                  manifestId: String(pinnedProviderResult.manifestId),
                }
              : undefined,
        });
        const bindingFailure = classifySubmittedDecisionBindingFailure({
          executionWorkspaceId: String(input.execution.workspaceId),
          episode: boundEpisode,
          request: request.value,
          workspace: Option.isSome(workspace)
            ? {
                currentWorkId:
                  workspace.value.currentWorkId === null
                    ? null
                    : String(workspace.value.currentWorkId),
                revision: Number(workspace.value.revision),
              }
            : undefined,
          step: loopStep,
          pendingAction: pendingSelectionAction,
          providerTurnId: String(providerTurnId),
          providerResult:
            pinnedProviderResult?._tag === "SettledSuccess"
              ? {
                  _tag: "SettledSuccess",
                  manifestId: String(pinnedProviderResult.manifestId),
                }
              : undefined,
        });
        if (
          bindingFailure !== undefined &&
          loopStep !== undefined &&
          pendingSelectionAction !== undefined
        ) {
          return {
            _tag: "SubmittedDecisionBindingMismatch" as const,
            failureCode: bindingFailure,
            logicalStepNo: loopStep.identity.logicalStepNo,
            repairAttempt: loopStep.identity.repairAttempt,
            providerTurnId: loopStep.providerTurnId,
            logicalActionId: pendingSelectionAction.logicalActionId,
          };
        }
        if (!replayingPinnedSelection) {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "DecisionRequestMissingOrSettled",
            },
          });
        }
        // The submitted canonical request is the result of this exact
        // pinned SelectCurrentWork Action. Rebuild its original decision
        // context only long enough to replay the settled Provider result;
        // no new Provider request or action is admitted from this snapshot.
        requestContextRevision = boundEpisode.requestRevision;
      }
      inputItems.push({
        _tag: "ContextUpdate",
        sourceRef: `decision-request:${boundEpisode.decisionId}`,
        revision: requestContextRevision,
        updateKind: "Full",
        text: JSON.stringify({
          decisionKind: "SelectCurrentWork",
          candidateWorkIds: request.value.candidateWorkIds,
          workspaceRevision: request.value.workspaceRevision,
        }),
      });
      messageContextRefs.push(
        `decision-request:${boundEpisode.decisionId}:${String(requestContextRevision)}`,
      );
    }
    return {
      _tag: "Assembled" as const,
      workContext,
      compactionWorkPinning,
      conversationActionFragments,
      workExecutionLoopAsset,
      instructionContents,
    };
  });
};
