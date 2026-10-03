import type { ExecutionBoundAgentBinding } from "./authority.js";
import type {
  DecisionId,
  ExecutionId,
  MessageId,
  ProjectId,
  SessionId,
  VerificationId,
  WorkId,
  WorkspaceId,
} from "./ids.js";
import type { WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";
import type { WaitSpec, WakeReason } from "./scheduler.js";
import type { VerificationVerdict } from "./verification.js";

export type ExecutionFocus =
  | { readonly _tag: "Work"; readonly workId: WorkId }
  | { readonly _tag: "Coordination" };

/** DID v1.28 EGP — exact reason a Workspace main execution exists. `focus`
 * remains only as a legacy projection while migration 0024 drains historical
 * rows; new Runtime decisions must consume this binding. */
export type ExecutionEpisodeBinding =
  | {
      readonly _tag: "WorkEpisode";
      readonly workId: WorkId;
      readonly targetWorkRevision: WorkRevision;
    }
  | {
      readonly _tag: "ConversationResponseEpisode";
      readonly messageId: MessageId;
      readonly responseJobRevision: number;
    }
  | {
      readonly _tag: "InboxEpisode";
      readonly entryKey: string;
      readonly inputKind: string;
    }
  | {
      readonly _tag: "DecisionEpisode";
      readonly decisionId: DecisionId;
      readonly decisionKind: "SelectCurrentWork";
      readonly requestRevision: number;
    };

/** Durable identity of the episode currently being driven by an Agent.
 * Workspace executions reuse their exact binding. Execution-bound agents and
 * migrated pre-EGP rows receive explicit identities instead of being folded
 * into the old `Coordination` bucket. */
export type AgentEpisodeIdentity =
  | ExecutionEpisodeBinding
  | {
      readonly _tag: "ExecutionBoundEpisode";
      readonly executionId: ExecutionId;
    }
  | {
      readonly _tag: "LegacyAmbiguousEpisode";
      readonly executionId: ExecutionId;
    };

export interface ExactWorkspaceExecution {
  readonly _tag: "WorkspaceExecution";
  readonly workspaceId: WorkspaceId;
  readonly episode: ExecutionEpisodeBinding;
}

/** Read-only compatibility shape for executions decoded from pre-0024 state. */
export interface LegacyWorkspaceExecution {
  readonly _tag: "WorkspaceExecution";
  readonly workspaceId: WorkspaceId;
  readonly focus: ExecutionFocus;
  readonly episode?: undefined;
}

export type WorkspaceExecution =
  | ExactWorkspaceExecution
  | LegacyWorkspaceExecution;

export type ExecutionBinding = WorkspaceExecution | ExecutionBoundAgentBinding;

export const workspaceExecution = (
  workspaceId: WorkspaceId,
  focus: ExecutionFocus,
): WorkspaceExecution => ({ _tag: "WorkspaceExecution", workspaceId, focus });

export const workspaceEpisodeExecution = (
  workspaceId: WorkspaceId,
  episode: ExecutionEpisodeBinding,
): WorkspaceExecution => ({
  _tag: "WorkspaceExecution",
  workspaceId,
  episode,
});

export const executionEpisode = (
  execution: Execution,
): ExecutionEpisodeBinding | undefined =>
  execution.binding._tag === "WorkspaceExecution"
    ? execution.binding.episode
    : undefined;

export const workEpisode = (
  execution: Execution,
): Extract<
  ExecutionEpisodeBinding,
  { readonly _tag: "WorkEpisode" }
> | null => {
  const episode = executionEpisode(execution);
  if (episode?._tag === "WorkEpisode") return episode;
  if (
    episode === undefined &&
    execution.binding._tag === "WorkspaceExecution" &&
    "focus" in execution.binding &&
    execution.binding.focus._tag === "Work"
  ) {
    return {
      _tag: "WorkEpisode",
      workId: execution.binding.focus.workId,
      targetWorkRevision: 0 as WorkRevision,
    };
  }
  return null;
};

export const conversationResponseEpisode = (
  execution: Execution,
): Extract<
  ExecutionEpisodeBinding,
  { readonly _tag: "ConversationResponseEpisode" }
> | null => {
  const episode = executionEpisode(execution);
  return episode?._tag === "ConversationResponseEpisode" ? episode : null;
};

export type CompletedResult =
  | {
      readonly _tag: "Yielded";
      readonly reason: string;
      readonly waitSpec: WaitSpec;
    }
  | {
      readonly _tag: "CompletionClaimed";
      readonly workRevision: WorkRevision;
      readonly claimRef: string;
    }
  | { readonly _tag: "CoordinationCompleted" }
  | { readonly _tag: "QueryCompleted" }
  | {
      readonly _tag: "ConversationResponseProduced";
      readonly messageId: MessageId;
    }
  | { readonly _tag: "InboxInputHandled"; readonly entryKey: string }
  | { readonly _tag: "DecisionSubmitted"; readonly decisionId: DecisionId }
  | {
      /** DID v1.27 VES: exact-bound verifier delivery completed. */
      readonly _tag: "VerificationConcluded";
      readonly verificationId: VerificationId;
      readonly verdict: VerificationVerdict;
    };

export type InterruptedResult =
  | { readonly _tag: "StopRequested" }
  | { readonly _tag: "ControlledInterruption"; readonly reason: string };

export interface ExecutionFailure {
  readonly _tag: "ExecutionFailure";
  readonly reason: string;
}

export interface ReconciliationRequired {
  readonly _tag: "ReconciliationRequired";
  readonly invocationRefs: ReadonlyArray<string>;
}

export type ExecutionSettlement =
  | { readonly _tag: "Completed"; readonly result: CompletedResult }
  | { readonly _tag: "Interrupted"; readonly result: InterruptedResult }
  | { readonly _tag: "Failed"; readonly failure: ExecutionFailure }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliation: ReconciliationRequired;
    };

export type ExecutionState =
  | { readonly status: "Active"; readonly settlement: null }
  | { readonly status: "Settled"; readonly settlement: ExecutionSettlement };

export interface Execution {
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly binding: ExecutionBinding;
  readonly sessionId: SessionId;
  readonly admittedAt: string;
  readonly stopRequestedAt: string | null;
  readonly state: ExecutionState;
}

export interface AdmitExecutionInput {
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly binding: ExecutionBinding;
  readonly sessionId: SessionId;
  readonly admittedAt: string;
  readonly noOtherActiveMain: boolean;
}

export const admitExecution = (
  input: AdmitExecutionInput,
): DomainResult<Execution> => {
  if (input.binding._tag === "WorkspaceExecution" && !input.noOtherActiveMain) {
    return err({
      _tag: "ActiveExecutionConflict",
      workspaceId: input.binding.workspaceId,
    });
  }
  return ok({
    executionId: input.executionId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    binding: input.binding,
    sessionId: input.sessionId,
    admittedAt: input.admittedAt,
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  });
};

export const stopExecution = (
  execution: Execution,
  stopRequestedAt: string,
): DomainResult<Execution> => {
  if (execution.state.status !== "Active") {
    return err({
      _tag: "TerminalLifecycleMutation",
      entity: "Execution",
      lifecycle: "Settled",
    });
  }
  return ok({ ...execution, stopRequestedAt });
};

export const settleExecution = (
  execution: Execution,
  settlement: ExecutionSettlement,
): DomainResult<Execution> => {
  if (execution.state.status !== "Active") {
    return err({
      _tag: "TerminalLifecycleMutation",
      entity: "Execution",
      lifecycle: "Settled",
    });
  }
  return ok({ ...execution, state: { status: "Settled", settlement } });
};

export const settlementMatchesEpisode = (
  execution: Execution,
  settlement: ExecutionSettlement,
): boolean => {
  const episode = executionEpisode(execution);
  if (episode === undefined || settlement._tag !== "Completed") return true;
  switch (episode._tag) {
    case "WorkEpisode":
      return (
        settlement.result._tag === "Yielded" ||
        settlement.result._tag === "CompletionClaimed"
      );
    case "ConversationResponseEpisode":
      return (
        settlement.result._tag === "ConversationResponseProduced" &&
        settlement.result.messageId === episode.messageId
      );
    case "InboxEpisode":
      return (
        settlement.result._tag === "InboxInputHandled" &&
        settlement.result.entryKey === episode.entryKey
      );
    case "DecisionEpisode":
      return (
        settlement.result._tag === "DecisionSubmitted" &&
        settlement.result.decisionId === episode.decisionId
      );
  }
};

export const isExecutionActive = (execution: Execution): boolean =>
  execution.state.status === "Active";

export const isExecutionSettled = (execution: Execution): boolean =>
  execution.state.status === "Settled";

interface AgentExecutionStateBase {
  readonly executionId: ExecutionId;
  readonly wakeReason: WakeReason;
  readonly currentMode: string | null;
  readonly activeSkillRefs: ReadonlyArray<string>;
  readonly turnNo: number;
  readonly recentDirectiveRefs: ReadonlyArray<string>;
  readonly recentActionFingerprints: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/** DID v1.28 EGP — current exact episode control state. */
export type AgentExecutionState =
  | (AgentExecutionStateBase & {
      readonly episode: AgentEpisodeIdentity;
      readonly focus?: never;
    })
  /** Read-only/write-through compatibility for databases before migration
   * 0026. New runtime state must use `episode`. */
  | (AgentExecutionStateBase & {
      readonly focus: ExecutionFocus;
      readonly episode?: never;
    });
