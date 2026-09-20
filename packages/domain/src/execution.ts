import type { ExecutionBoundAgentBinding } from "./authority.js";
import type {
  ExecutionId,
  ProjectId,
  SessionId,
  WorkId,
  WorkspaceId,
} from "./ids.js";
import type { WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";
import type { WaitSpec, WakeReason } from "./scheduler.js";

export type ExecutionFocus =
  | { readonly _tag: "Work"; readonly workId: WorkId }
  | { readonly _tag: "Coordination" };

export interface WorkspaceExecution {
  readonly _tag: "WorkspaceExecution";
  readonly workspaceId: WorkspaceId;
  readonly focus: ExecutionFocus;
}

export type ExecutionBinding = WorkspaceExecution | ExecutionBoundAgentBinding;

export const workspaceExecution = (
  workspaceId: WorkspaceId,
  focus: ExecutionFocus,
): WorkspaceExecution => ({ _tag: "WorkspaceExecution", workspaceId, focus });

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
  | { readonly _tag: "QueryCompleted" };

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

export const isExecutionActive = (execution: Execution): boolean =>
  execution.state.status === "Active";

export const isExecutionSettled = (execution: Execution): boolean =>
  execution.state.status === "Settled";

/** DID v1.7 §3.7 — current episode control state. */
export interface AgentExecutionState {
  readonly executionId: ExecutionId;
  readonly focus: ExecutionFocus;
  readonly wakeReason: WakeReason;
  readonly currentMode: string | null;
  readonly activeSkillRefs: ReadonlyArray<string>;
  readonly turnNo: number;
  readonly recentDirectiveRefs: ReadonlyArray<string>;
  readonly recentActionFingerprints: ReadonlyArray<string>;
  readonly updatedAt: string;
}
