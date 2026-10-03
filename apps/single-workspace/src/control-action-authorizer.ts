import {
  type AgentAction,
  ControlActionAuthorizer,
  type ControlActionAuthorizerService,
  permissionGrantMatchesExecution,
} from "@arbor/agent-runtime";
import type { WorkspacePolicy } from "@arbor/domain";
import {
  Clock,
  ControlApprovalStore,
  InboxProjectionStore,
  PermissionGrantRepository,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const stableIdOf = (action: AgentAction): string =>
  ({
    AssignWork: "core.control.assign-work",
    ListWorkspaces: "core.control.list-workspaces",
    ReadWorkspace: "core.control.read-workspace",
    AcceptResult: "core.control.accept-result",
    SelectCurrentWork: "core.control.select-current-work",
    UpdatePlan: "core.control.update-plan",
    RecordVerificationEvidence: "core.control.record-verification-evidence",
    ConcludeVerification: "core.control.conclude-verification",
    Wait: "core.control.wait",
    SendMessage: "core.control.send-message",
    ClaimCompletion: "core.control.claim-completion",
    SpawnSpecialist: "core.control.spawn-specialist",
    DeclareDependency: "core.control.declare-dependency",
    ProduceDeliverable: "core.control.produce-deliverable",
    Deliver: "core.control.deliver",
    ProposeChildWorkspace: "core.control.propose-workspace",
  })[action._tag];

const targetOf = (action: AgentAction, workspaceId: string): string => {
  switch (action._tag) {
    case "AssignWork":
      return (
        action.targetWorkspaceRef ?? action.targetWorkspaceId ?? workspaceId
      );
    case "ReadWorkspace":
      return action.workspaceRef;
    case "AcceptResult":
      return action.resultRef;
    default:
      return workspaceId;
  }
};

const summaryOf = (action: AgentAction, targetRef: string): string => {
  switch (action._tag) {
    case "AssignWork":
      return JSON.stringify({
        action: "AssignWork",
        targetWorkspaceId: targetRef,
        objective: action.objective,
        why: action.why,
        constraints: action.constraints,
        completionExpectation: action.completionExpectation,
        verificationMission: action.verificationMission,
      });
    case "SpawnSpecialist":
      return JSON.stringify({
        action: "SpawnSpecialist",
        targetWorkspaceId: targetRef,
        mission: action.mission,
        constraints: action.constraints,
      });
    default:
      return JSON.stringify({ action: action._tag, targetRef });
  }
};

const intrinsic = new Set<AgentAction["_tag"]>([
  "SelectCurrentWork",
  "ListWorkspaces",
  "ReadWorkspace",
  "AcceptResult",
  "UpdatePlan",
  "RecordVerificationEvidence",
  "ConcludeVerification",
  "Wait",
  "SendMessage",
  "ClaimCompletion",
  "DeclareDependency",
  "ProduceDeliverable",
  "Deliver",
  "ProposeChildWorkspace",
]);

type ApprovalMode = "Deny" | "Ask" | "AllowWithinGrant";

const modeOf = (policy: WorkspacePolicy, stableId: string): ApprovalMode => {
  const raw = (policy as Readonly<Record<string, unknown>>)
    .controlApprovalPolicy;
  if (typeof raw === "object" && raw !== null) {
    const value = (raw as Readonly<Record<string, unknown>>)[stableId];
    if (value === "Deny" || value === "Ask" || value === "AllowWithinGrant") {
      return value;
    }
  }
  return stableId === "core.control.assign-work" ||
    stableId === "core.control.spawn-specialist"
    ? "Ask"
    : "AllowWithinGrant";
};

const ttlOf = (policy: WorkspacePolicy): number => {
  const raw = (policy as Readonly<Record<string, unknown>>)
    .controlApprovalTtlSeconds;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : 900;
};

const addSeconds = (instant: string, seconds: number): string =>
  new Date(Date.parse(instant) + seconds * 1000).toISOString();

export const ControlActionAuthorizerLive: Layer.Layer<
  ControlActionAuthorizer,
  never,
  | Clock
  | ControlApprovalStore
  | InboxProjectionStore
  | PermissionGrantRepository
  | TransactionPort
  | WorkspaceRepository
> = Layer.effect(
  ControlActionAuthorizer,
  Effect.gen(function* () {
    const clock = yield* Clock;
    const approvals = yield* ControlApprovalStore;
    const inbox = yield* InboxProjectionStore;
    const grants = yield* PermissionGrantRepository;
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;

    const authorize: ControlActionAuthorizerService["authorize"] = (input) =>
      Effect.gen(function* () {
        const stableActionId = stableIdOf(input.action);
        const targetRef = targetOf(input.action, input.execution.workspaceId);
        const now = yield* clock.now();
        const actionDigest = sha256Hex(
          JSON.stringify({ stableActionId, action: input.action }),
        );
        const controlBasisDigest = sha256Hex(
          JSON.stringify(input.controlBasis),
        );
        const approvalId = `cap_${sha256Hex(
          JSON.stringify({
            executionId: input.execution.executionId,
            callRef: input.invocation.callRef,
            actionDigest,
            controlBasisDigest,
          }),
        )}`;
        const workspace = yield* tx.transact(
          workspaces.findById(input.execution.workspaceId),
        );
        if (Option.isNone(workspace)) {
          return { _tag: "Denied" as const, reason: "workspace missing" };
        }
        if (intrinsic.has(input.action._tag)) {
          return {
            _tag: "Authorized" as const,
            authorityRef: `intrinsic:${stableActionId}`,
            actionDigest,
            controlBasisDigest,
          };
        }
        const snapshot = yield* tx.transact(
          Effect.gen(function* () {
            const activeGrants = yield* grants.activeGrants(
              input.execution.projectId,
            );
            const approval = yield* approvals.findById(approvalId);
            return { activeGrants, approval };
          }),
        );
        const mode = modeOf(workspace.value.workspacePolicy, stableActionId);
        if (mode === "Deny") {
          return { _tag: "Denied" as const, reason: "policy denied action" };
        }
        const grant = snapshot.activeGrants.find((candidate) =>
          permissionGrantMatchesExecution(candidate, {
            execution: input.execution,
            principal: input.context.principal,
            capability: stableActionId,
            targetRef,
            now,
          }),
        );
        if (grant !== undefined) {
          return {
            _tag: "Authorized" as const,
            authorityRef: `grant:${grant.permissionGrantId}`,
            actionDigest,
            controlBasisDigest,
          };
        }
        if (mode === "AllowWithinGrant") {
          return {
            _tag: "Denied" as const,
            reason: "no matching subject-bound grant",
          };
        }
        if (Option.isSome(snapshot.approval)) {
          const approval = snapshot.approval.value;
          if (
            approval.actionDigest !== actionDigest ||
            approval.controlBasisDigest !== controlBasisDigest ||
            approval.targetRef !== targetRef ||
            Date.parse(now) >= Date.parse(approval.expiresAt)
          ) {
            return {
              _tag: "Denied" as const,
              reason: "approval is stale or expired",
            };
          }
          if (approval.state === "Approved" || approval.state === "Consumed") {
            return {
              _tag: "Authorized" as const,
              authorityRef: `approval:${approval.approvalId}`,
              approvalId: approval.approvalId,
              approvalRevision: approval.revision,
              actionDigest,
              controlBasisDigest,
            };
          }
          if (approval.state === "Rejected") {
            return {
              _tag: "Denied" as const,
              reason: approval.decisionReason ?? "human rejected action",
            };
          }
          if (approval.state === "Expired") {
            return {
              _tag: "Denied" as const,
              reason: "control approval expired",
            };
          }
          return {
            _tag: "ApprovalRequired" as const,
            approvalId,
            revision: approval.revision,
          };
        }
        const expiresAt = addSeconds(
          now,
          ttlOf(workspace.value.workspacePolicy),
        );
        yield* tx.transact(
          Effect.gen(function* () {
            yield* approvals.putPending({
              approvalId,
              projectId: input.execution.projectId,
              workspaceId: input.execution.workspaceId,
              executionId: input.execution.executionId,
              stableActionId,
              actionDigest,
              argumentsJson: input.invocation.argumentsJson,
              targetRef,
              controlBasisDigest,
              state: "Pending",
              revision: 0,
              requestedAt: now,
              expiresAt,
              decidedAt: null,
              decidedBy: null,
              decisionReason: null,
              consumedAt: null,
            });
            yield* inbox.admitUpsert({
              recipientWorkspaceId: input.execution.workspaceId,
              entryKey: `cap:${approvalId}:0`,
              kind: "Governance",
              summary: summaryOf(input.action, targetRef),
              admittedAt: now,
            });
          }),
        );
        return { _tag: "ApprovalRequired" as const, approvalId, revision: 0 };
      }).pipe(Effect.orDie);

    const consumeApproval: ControlActionAuthorizerService["consumeApproval"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const now = yield* clock.now();
        const consumed = yield* tx.transact(
          approvals.consumeApproved({
            approvalId: input.approvalId,
            expectedRevision: input.approvalRevision,
            actionDigest: input.actionDigest,
            controlBasisDigest: input.controlBasisDigest,
            consumedAt: now,
          }),
        );
        if (Option.isSome(consumed)) return true;
        const existing = yield* tx.transact(
          approvals.findById(input.approvalId),
        );
        return (
          Option.isSome(existing) &&
          existing.value.state === "Consumed" &&
          existing.value.actionDigest === input.actionDigest &&
          existing.value.controlBasisDigest === input.controlBasisDigest
        );
      }).pipe(Effect.orDie);

    return ControlActionAuthorizer.of({ authorize, consumeApproval });
  }),
);
