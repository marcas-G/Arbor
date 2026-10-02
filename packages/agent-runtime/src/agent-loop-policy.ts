import type {
  CommandSubmissionContext,
  Execution,
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
} from "@arbor/domain";
import type {
  InstructionFragment,
  ModelOutput,
  PreparedModelTurn,
} from "@arbor/model-context";
import type {
  AgentLoopStepRecord,
  ProviderExecutionTimeout,
  ProviderFailure,
} from "@arbor/ports";
import { CANONICAL_TRUST } from "./prompt-assets.js";
import type { RepairPolicy } from "./repair.js";

/** Bounded execution budget. Sixteen leaves room for inspect → test → bind
 * evidence → conclude workflows while RuntimeSafety still stops non-progress
 * and looping patterns before the hard ceiling. */
export const MAX_TURNS = 16;
export const MAX_REPAIRS = 2;
export const REPAIR_POLICY: RepairPolicy = { maxRepairs: MAX_REPAIRS };

export type ModelDecisionOutcome =
  | {
      readonly _tag: "Ready";
      readonly turn: PreparedModelTurn;
      readonly output: ModelOutput;
      readonly loopStep?: AgentLoopStepRecord;
      readonly conversation?: boolean;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export const safetyStop = (reason: string): ExecutionSettlement => ({
  _tag: "Interrupted",
  result: { _tag: "ControlledInterruption", reason },
});

export const isProviderTurnBindingChanged = (
  cause: unknown,
): cause is ProviderFailure & {
  readonly kind: "UnknownProviderFailure";
  readonly safeDiagnostic: "provider-turn-resume-binding-invalid";
} =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === "ProviderFailure" &&
  (cause as { readonly kind?: unknown }).kind === "UnknownProviderFailure" &&
  (cause as { readonly safeDiagnostic?: unknown }).safeDiagnostic ===
    "provider-turn-resume-binding-invalid";

export const providerTurnBindingChangedSettlement =
  (): ExecutionSettlement => ({
    _tag: "Failed",
    failure: {
      _tag: "ExecutionFailure",
      reason: "ProviderTurnBindingChanged",
    },
  });

export const isProviderExecutionTimeout = (
  cause: unknown,
): cause is ProviderExecutionTimeout =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === "ProviderExecutionTimeout" &&
  typeof (cause as { readonly phase?: unknown }).phase === "string";

export const providerExecutionTimeoutSettlement = (
  timeout: ProviderExecutionTimeout,
): ExecutionSettlement => ({
  _tag: "Failed",
  failure: {
    _tag: "ExecutionFailure",
    reason: `ProviderExecutionTimedOut:${timeout.phase}`,
  },
});

export const sessionFence = (
  executionId: ExecutionId,
  context: CommandSubmissionContext,
):
  | {
      readonly executionId: ExecutionId;
      readonly workerId?: string;
      readonly workerIncarnationId?: string;
      readonly fencingGeneration: LeaseGeneration;
    }
  | undefined =>
  context._tag === "ExecutionOrigin"
    ? {
        executionId,
        fencingGeneration: context.fencingGeneration,
        ...(context.workerId !== undefined
          ? { workerId: context.workerId }
          : {}),
        ...(context.workerIncarnationId !== undefined
          ? { workerIncarnationId: context.workerIncarnationId }
          : {}),
      }
    : undefined;

export const isConversationExecution = (execution: Execution): boolean =>
  execution.binding._tag === "WorkspaceExecution" &&
  execution.binding.focus._tag === "Coordination";

export const workObjectiveFragment = (
  execution: Execution,
): InstructionFragment => ({
  identity: "work-objective",
  revision: 1,
  hash: "h",
  semanticKind: "WorkObjective",
  source: "Canonical",
  scope: "work-objective",
  authorityRole: "A3",
  strength: "Hard",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef: `work:${execution.executionId}`,
  provenance: CANONICAL_TRUST,
});

export const runtimeSafetyFragment: InstructionFragment = {
  identity: "runtime-safety",
  revision: 1,
  hash: "h0",
  semanticKind: "RuntimeSafety",
  source: "Canonical",
  scope: "runtime-safety",
  authorityRole: "A0",
  strength: "Hard",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef: "runtime safety",
  provenance: CANONICAL_TRUST,
};
