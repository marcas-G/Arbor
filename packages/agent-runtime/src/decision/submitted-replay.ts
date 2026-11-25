import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
} from "@arbor/ports";

interface SubmittedDecisionReplayInput {
  readonly executionWorkspaceId: string;
  readonly episode: {
    readonly decisionId: string;
    readonly requestRevision: number;
  };
  readonly request: {
    readonly workspaceId: string;
    readonly candidateWorkIds: ReadonlyArray<string>;
    readonly workspaceRevision: number;
    readonly revision: number;
    readonly state:
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Submitted"; readonly selectedWorkId: string };
  };
  readonly workspace:
    | {
        readonly currentWorkId: string | null;
        readonly revision: number;
      }
    | undefined;
  readonly step:
    | (Omit<
        Pick<
          AgentLoopStepRecord,
          | "providerTurnId"
          | "state"
          | "nextActionIndex"
          | "manifestId"
          | "decodedOutputHash"
          | "modelOutputSessionSequence"
        >,
        "providerTurnId"
      > & { readonly providerTurnId: string })
    | undefined;
  readonly pendingAction:
    | Pick<
        AgentLoopStepActionRecord,
        "actionIndex" | "routeKind" | "actionKind" | "state"
      >
    | undefined;
  readonly providerTurnId: string;
  readonly providerResult:
    | { readonly _tag: "SettledSuccess"; readonly manifestId: string }
    | undefined;
}

export type SubmittedDecisionBindingFailureCode =
  | "DecisionRequestWorkspaceMismatch"
  | "StepManifestMismatch";

/** Classifies only the two frozen AH10 integrity failures. Other invalid or
 * incomplete replay evidence remains on the existing fail-closed path. */
export const classifySubmittedDecisionBindingFailure = (
  input: SubmittedDecisionReplayInput,
): SubmittedDecisionBindingFailureCode | undefined => {
  const { request, step, pendingAction, providerResult } = input;
  if (
    request.state._tag !== "Submitted" ||
    step === undefined ||
    step.providerTurnId !== input.providerTurnId ||
    step.state !== "ActionsInProgress" ||
    pendingAction === undefined ||
    pendingAction.actionIndex !== step.nextActionIndex ||
    pendingAction.routeKind !== "Control" ||
    pendingAction.actionKind !== "select_current_work" ||
    pendingAction.state !== "Pending"
  ) {
    return undefined;
  }
  if (request.workspaceId !== input.executionWorkspaceId) {
    return "DecisionRequestWorkspaceMismatch";
  }
  if (
    step.manifestId !== undefined &&
    providerResult?._tag === "SettledSuccess" &&
    providerResult.manifestId !== step.manifestId
  ) {
    return "StepManifestMismatch";
  }
  return undefined;
};

/** A terminal DecisionRequest may be reused only to recover this exact
 * already-pinned SelectCurrentWork action. All new or otherwise ambiguous
 * DecisionEpisodes remain Pending-only. */
export const isPinnedSubmittedDecisionReplay = (
  input: SubmittedDecisionReplayInput,
): boolean => {
  const { request, episode, workspace, step, pendingAction, providerResult } =
    input;
  const selectedWorkId =
    request.state._tag === "Submitted"
      ? request.state.selectedWorkId
      : undefined;
  return (
    request.state._tag === "Submitted" &&
    request.workspaceId === input.executionWorkspaceId &&
    request.revision === episode.requestRevision + 1 &&
    selectedWorkId !== undefined &&
    request.candidateWorkIds.includes(selectedWorkId) &&
    workspace?.currentWorkId === selectedWorkId &&
    workspace.revision === request.workspaceRevision + 1 &&
    step !== undefined &&
    step.providerTurnId === input.providerTurnId &&
    step.state === "ActionsInProgress" &&
    step.manifestId !== undefined &&
    step.decodedOutputHash !== undefined &&
    step.modelOutputSessionSequence !== undefined &&
    pendingAction !== undefined &&
    pendingAction.actionIndex === step.nextActionIndex &&
    pendingAction.routeKind === "Control" &&
    pendingAction.actionKind === "select_current_work" &&
    pendingAction.state === "Pending" &&
    providerResult?._tag === "SettledSuccess" &&
    providerResult.manifestId === step.manifestId
  );
};
