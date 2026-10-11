import type {
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { AgentLoopStepIdentity } from "./agent-loop-step.js";
import type {
  LeaseFencingRejected,
  ToolInvocationStoreError,
} from "./errors.js";
import type { TransactionScope } from "./session.js";
import type { ToolExecutionContext } from "./tool.js";

export interface ExecutableApprovalKey {
  readonly executionId: ExecutionId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: string;
}

/** Runtime-derived immutable identity for one Executable approval request.
 * Lifecycle state, revision and expiresAt are deliberately excluded. */
export interface ExecutableApprovalBinding extends ExecutableApprovalKey {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly subject: Principal;
  readonly callRef: string;
  readonly toolInvocationId: ToolInvocationId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly sideEffectSemantics:
    | "ReadOnly"
    | "Idempotent"
    | "Reconcilable"
    | "NonIdempotent";
  readonly argumentsJson: string;
  readonly actionDigest: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
}

export type ExecutableApprovalState =
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Consumed"
  | "Expired"
  | "Cancelled";

export interface ExecutableApprovalRecord extends ExecutableApprovalBinding {
  readonly approvalId: string;
  readonly routeKind: "Executable";
  readonly revision: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly state: ExecutableApprovalState;
  readonly decidedAt: string | null;
  readonly decidedBy: Principal | null;
  readonly decisionReason: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledBy: Principal | null;
  readonly cancellationReason: string | null;
  readonly consumedAt: string | null;
  readonly consumedBy: ToolInvocationId | null;
}

export interface ExecutableApprovalRequest extends ExecutableApprovalBinding {
  readonly approvalId: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly executionFence: NonNullable<ToolExecutionContext["executionFence"]>;
}

/** Exact immutable consumption snapshot captured in the P4 fenced claim
 * transaction. P39 persists this receipt into RecoveryBinding before any
 * effect admission. */
export interface ExecutableApprovalConsumptionReceipt {
  readonly approvalId: string;
  readonly preConsumeRevision: number;
  readonly consumedRevision: number;
  readonly approvalDigest: string;
  readonly binding: ExecutableApprovalBinding;
  readonly expiresAt: string;
  readonly consumedBy: ToolInvocationId;
}

export interface ExecutableApprovalStoreService {
  /** Read-only replay lookup. A prior lease holder can observe the bound row,
   * but this operation cannot decide, consume, wake, or admit an effect. Any
   * Approved result must still pass the caller's current P4 lease/authority
   * claim before progression. */
  readonly findByActionKey: (
    key: ExecutableApprovalKey,
  ) => Effect.Effect<
    Option.Option<ExecutableApprovalRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  /** Must atomically insert/read the exact Pending row, admit its eap: Inbox
   * item, append request and durable wake facts, and enforce the active
   * Execution/Step/action plus complete P2 lease fence. On a unique-key race,
   * return the committed winner only when its immutable binding matches. */
  readonly putPendingExact: (
    request: ExecutableApprovalRequest,
  ) => Effect.Effect<
    ExecutableApprovalRecord | "ExecutionStopping",
    ToolInvocationStoreError | LeaseFencingRejected,
    TransactionScope
  >;
  readonly findById: (
    approvalId: string,
  ) => Effect.Effect<
    Option.Option<ExecutableApprovalRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly decide: (input: {
    readonly approvalId: string;
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly decision: "Approve" | "Reject";
    readonly decidedAt: string;
    readonly decidedBy: Principal;
    readonly reason: string | null;
  }) => Effect.Effect<
    Option.Option<ExecutableApprovalRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  /** Expire a bounded set of due Pending/Approved rows. Each row is a
   * revision-CAS against state + expiresAt; Inbox consumption and the durable
   * Resolved wake event share this transaction. */
  readonly expireDue: (input: {
    readonly now: string;
    readonly expiredBy: Principal;
    readonly batchSize?: number;
  }) => Effect.Effect<
    ReadonlyArray<ExecutableApprovalRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  /** Called inside the same fenced transaction as ToolInvocation intent
   * admission. It consumes only the exact Approved revision and immutable
   * invocation binding. */
  readonly consumeApproved: (input: {
    readonly approvalId: string;
    readonly expectedRevision: number;
    readonly consumedBy: ToolInvocationId;
    readonly consumedAt: string;
    readonly binding: ExecutableApprovalBinding;
    readonly executionFence: NonNullable<
      ToolExecutionContext["executionFence"]
    >;
  }) => Effect.Effect<
    ExecutableApprovalConsumptionReceipt | false | "ExecutionStopping",
    ToolInvocationStoreError | LeaseFencingRejected,
    TransactionScope
  >;
  /** Authorized StopExecution composition calls this after committing the
   * stop flag in the same TransactionScope. It closes only unclaimed proven
   * Executable approvals and consumes their original revision-0 Inbox key. */
  readonly cancelForExecution: (input: {
    readonly executionId: ExecutionId;
    readonly cancelledAt: string;
    readonly cancelledBy: Principal;
    readonly reason: "StopRequested";
  }) => Effect.Effect<
    ReadonlyArray<ExecutableApprovalRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
}

export class ExecutableApprovalStore extends Context.Service<
  ExecutableApprovalStore,
  ExecutableApprovalStoreService
>()("arbor/ExecutableApprovalStore") {}

export const executableApprovalKeyOf = (
  binding: ExecutableApprovalBinding,
): ExecutableApprovalKey => ({
  executionId: binding.executionId,
  logicalStepNo: binding.logicalStepNo,
  repairAttempt: binding.repairAttempt,
  actionIndex: binding.actionIndex,
  logicalActionId: binding.logicalActionId,
});

export const executableApprovalBindingMatches = (
  left: ExecutableApprovalBinding,
  right: ExecutableApprovalBinding,
): boolean =>
  left.executionId === right.executionId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt &&
  left.actionIndex === right.actionIndex &&
  left.logicalActionId === right.logicalActionId &&
  left.projectId === right.projectId &&
  left.workspaceId === right.workspaceId &&
  left.subject === right.subject &&
  left.callRef === right.callRef &&
  left.toolInvocationId === right.toolInvocationId &&
  left.toolName === right.toolName &&
  left.toolVersion === right.toolVersion &&
  left.sideEffectSemantics === right.sideEffectSemantics &&
  left.argumentsJson === right.argumentsJson &&
  left.actionDigest === right.actionDigest &&
  left.controlBasisDigest === right.controlBasisDigest &&
  sameStrings(left.targetResourceSpaceIds, right.targetResourceSpaceIds);

const sameStrings = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const executableApprovalStepOf = (
  identity: AgentLoopStepIdentity,
): Pick<
  ExecutableApprovalBinding,
  "executionId" | "logicalStepNo" | "repairAttempt"
> => ({
  executionId: identity.executionId,
  logicalStepNo: identity.logicalStepNo,
  repairAttempt: identity.repairAttempt,
});
