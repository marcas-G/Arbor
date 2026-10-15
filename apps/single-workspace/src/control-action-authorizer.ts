import {
  type AgentAction,
  ControlActionAuthorizer,
  type ControlActionAuthorizerService,
  permissionGrantMatchesExecution,
} from "@arbor/agent-runtime";
import { newUuid7 } from "@arbor/application";
import type {
  CommandId,
  PermissionGrant,
  ProjectId,
  WorkspacePolicy,
} from "@arbor/domain";
import {
  type AssignWorkControlAuthorizationEvidence,
  Clock,
  CommandStore,
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
    ResolveWorkBlocker: "core.control.resolve-work-blocker",
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
  "ResolveWorkBlocker",
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

const assignWorkPermissionGrantEvidence = (input: {
  readonly grant: PermissionGrant;
  readonly projectId: ProjectId;
  readonly targetRef: string;
  readonly actionDigest: string;
  readonly controlBasisDigest: string;
}): AssignWorkControlAuthorizationEvidence | undefined => {
  const { grant } = input;
  const subject = grant.subject;
  if (
    (subject?._tag !== "WorkspaceAgent" && subject?._tag !== "Execution") ||
    grant.capability !== "core.control.assign-work" ||
    grant.target !== input.targetRef ||
    grant.revision === undefined ||
    !Number.isSafeInteger(grant.revision) ||
    grant.revision < 0 ||
    grant.validFrom === undefined
  ) {
    return undefined;
  }
  return {
    _tag: "PermissionGrant",
    permissionGrantId: grant.permissionGrantId,
    permissionGrantRevision: grant.revision,
    projectId: input.projectId,
    subjectKind: subject._tag,
    subjectRef:
      subject._tag === "WorkspaceAgent"
        ? subject.workspaceId
        : subject.executionId,
    capability: "core.control.assign-work",
    targetRef: input.targetRef,
    validFrom: grant.validFrom,
    expiresAt: grant.expiresAt ?? null,
    actionDigest: input.actionDigest,
    controlBasisDigest: input.controlBasisDigest,
  };
};

export const ControlActionAuthorizerLive: Layer.Layer<
  ControlActionAuthorizer,
  never,
  | Clock
  | ControlApprovalStore
  | CommandStore
  | InboxProjectionStore
  | PermissionGrantRepository
  | TransactionPort
  | WorkspaceRepository
> = Layer.effect(
  ControlActionAuthorizer,
  Effect.gen(function* () {
    const clock = yield* Clock;
    const approvals = yield* ControlApprovalStore;
    const commands = yield* CommandStore;
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
        const currentWorkspaceAssignWork =
          input.action._tag === "AssignWork" &&
          (input.action.targetWorkspaceRef === undefined ||
            input.action.targetWorkspaceRef === "current") &&
          (input.action.targetWorkspaceId === undefined ||
            input.action.targetWorkspaceId === input.execution.workspaceId);
        if (
          input.action._tag === "AssignWork" &&
          input.context._tag === "ExecutionOrigin" &&
          input.context.fencingGeneration > 0 &&
          input.logicalActionId !== undefined
        ) {
          const occurrence = `${input.invocation.providerTurnId}:${input.invocation.outputPosition}`;
          for (
            let generation = 0;
            generation < input.context.fencingGeneration;
            generation += 1
          ) {
            const seed =
              generation === 0
                ? occurrence
                : `${occurrence}:generation:${generation}`;
            const priorCommandId =
              `cmd_${newUuid7("assign-work-command", seed)}` as CommandId;
            const prior = yield* tx.transact(
              commands.findResolution(priorCommandId),
            );
            if (Option.isNone(prior)) continue;
            if (
              prior.value.commandId !== priorCommandId ||
              prior.value.projectId !== input.execution.projectId
            ) {
              return { _tag: "RecoveryBlocked" as const };
            }
            if (prior.value.resolution === "Committed") {
              if (currentWorkspaceAssignWork) {
                let receiptWorkspaceId: unknown;
                try {
                  receiptWorkspaceId = JSON.parse(
                    prior.value.resultJson ?? "null",
                  )?.workspaceId;
                } catch {
                  receiptWorkspaceId = undefined;
                }
                if (receiptWorkspaceId !== input.execution.workspaceId) {
                  return { _tag: "RecoveryBlocked" as const };
                }
                const approval = yield* tx.transact(
                  approvals.findById(approvalId),
                );
                if (Option.isSome(approval)) {
                  if (
                    approval.value.state !== "Consumed" ||
                    approval.value.bindingProven !== true ||
                    approval.value.revision !== 2 ||
                    approval.value.consumedBy !== priorCommandId ||
                    approval.value.projectId !== input.execution.projectId ||
                    approval.value.workspaceId !==
                      input.execution.workspaceId ||
                    approval.value.executionId !==
                      input.execution.executionId ||
                    approval.value.stableActionId !== stableActionId ||
                    approval.value.actionDigest !== actionDigest ||
                    approval.value.targetRef !== targetRef ||
                    approval.value.controlBasisDigest !== controlBasisDigest
                  ) {
                    return { _tag: "RecoveryBlocked" as const };
                  }
                  const authority = {
                    _tag: "ActionApproval" as const,
                    approvalId: approval.value.approvalId,
                    approvalRevision: approval.value.revision - 1,
                    projectId: approval.value.projectId,
                    workspaceId: approval.value.workspaceId,
                    executionId: approval.value.executionId,
                    stableActionId: "core.control.assign-work" as const,
                    actionDigest: approval.value.actionDigest,
                    targetRef: approval.value.targetRef,
                    controlBasisDigest: approval.value.controlBasisDigest,
                    expiresAt: approval.value.expiresAt,
                  } satisfies AssignWorkControlAuthorizationEvidence;
                  return {
                    _tag: "Authorized" as const,
                    authorityRef: "receipt-first:assign-work-current-workspace",
                    actionDigest,
                    controlBasisDigest,
                    approvalId,
                    approvalRevision: authority.approvalRevision,
                    assignWorkEvidence: authority,
                    assignWorkCommandReplay: {
                      commandId: priorCommandId,
                      approvalId,
                      approvalRevision: authority.approvalRevision,
                      consumedRevision: approval.value.revision,
                    },
                  };
                }

                const activeGrants = yield* tx.transact(
                  grants.activeGrants(input.execution.projectId),
                );
                const grant = activeGrants.find((candidate) => {
                  const evidence = assignWorkPermissionGrantEvidence({
                    grant: candidate,
                    projectId: input.execution.projectId,
                    targetRef,
                    actionDigest,
                    controlBasisDigest,
                  });
                  return (
                    evidence !== undefined &&
                    permissionGrantMatchesExecution(candidate, {
                      execution: input.execution,
                      principal: input.context.principal,
                      capability: stableActionId,
                      targetRef,
                      now,
                    })
                  );
                });
                const authority =
                  grant === undefined
                    ? undefined
                    : assignWorkPermissionGrantEvidence({
                        grant,
                        projectId: input.execution.projectId,
                        targetRef,
                        actionDigest,
                        controlBasisDigest,
                      });
                if (authority === undefined) {
                  return { _tag: "RecoveryBlocked" as const };
                }
                return {
                  _tag: "Authorized" as const,
                  authorityRef:
                    "receipt-first:assign-work-current-workspace-grant",
                  actionDigest,
                  controlBasisDigest,
                  assignWorkEvidence: authority,
                };
              }
              return {
                _tag: "Authorized" as const,
                authorityRef: "receipt-first:assign-work",
                actionDigest,
                controlBasisDigest,
                assignWorkReplay: true,
              };
            }
          }
        }
        if (
          input.action._tag === "AssignWork" &&
          input.action.targetWorkspaceId !== undefined &&
          input.action.targetWorkspaceId !== input.execution.workspaceId
        ) {
          return {
            _tag: "Denied" as const,
            reason:
              "AssignWork direct-child targets require an opaque targetWorkspaceRef",
          };
        }
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
        const grant = snapshot.activeGrants.find(
          (candidate) =>
            permissionGrantMatchesExecution(candidate, {
              execution: input.execution,
              principal: input.context.principal,
              capability: stableActionId,
              targetRef,
              now,
            }) &&
            (input.action._tag !== "AssignWork" ||
              assignWorkPermissionGrantEvidence({
                grant: candidate,
                projectId: input.execution.projectId,
                targetRef,
                actionDigest,
                controlBasisDigest,
              }) !== undefined),
        );
        if (grant !== undefined) {
          const assignWorkEvidence =
            input.action._tag === "AssignWork"
              ? assignWorkPermissionGrantEvidence({
                  grant,
                  projectId: input.execution.projectId,
                  targetRef,
                  actionDigest,
                  controlBasisDigest,
                })
              : undefined;
          return {
            _tag: "Authorized" as const,
            authorityRef: `grant:${grant.permissionGrantId}`,
            actionDigest,
            controlBasisDigest,
            ...(assignWorkEvidence === undefined ? {} : { assignWorkEvidence }),
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
            if (
              input.action._tag === "AssignWork" &&
              (approval.state !== "Approved" || approval.bindingProven !== true)
            ) {
              return {
                _tag: "Denied" as const,
                reason:
                  "AssignWork approval lacks exact durable binding evidence",
              };
            }
            return {
              _tag: "Authorized" as const,
              authorityRef: `approval:${approval.approvalId}`,
              approvalId: approval.approvalId,
              approvalRevision: approval.revision,
              actionDigest,
              controlBasisDigest,
              ...(input.action._tag === "AssignWork" &&
              approval.state === "Approved" &&
              approval.bindingProven === true
                ? {
                    assignWorkEvidence: {
                      _tag: "ActionApproval" as const,
                      approvalId: approval.approvalId,
                      approvalRevision: approval.revision,
                      projectId: approval.projectId,
                      workspaceId: approval.workspaceId,
                      executionId: approval.executionId,
                      stableActionId: "core.control.assign-work" as const,
                      actionDigest,
                      targetRef,
                      controlBasisDigest,
                      expiresAt: approval.expiresAt,
                    } satisfies AssignWorkControlAuthorizationEvidence,
                  }
                : {}),
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
        const existing = yield* tx.transact(
          approvals.findById(input.approvalId),
        );
        if (Option.isNone(existing)) return false;
        if (input.alreadyConsumedByCommandId !== undefined) {
          return (
            existing.value.state === "Consumed" &&
            existing.value.revision === input.approvalRevision + 1 &&
            existing.value.consumedBy === input.alreadyConsumedByCommandId &&
            existing.value.actionDigest === input.actionDigest &&
            existing.value.controlBasisDigest === input.controlBasisDigest
          );
        }
        if (
          existing.value.state === "Consumed" &&
          existing.value.revision === input.approvalRevision + 1 &&
          existing.value.consumedBy === input.consumedBy &&
          existing.value.actionDigest === input.actionDigest &&
          existing.value.controlBasisDigest === input.controlBasisDigest
        ) {
          return true;
        }
        if (
          existing.value.state !== "Approved" ||
          existing.value.revision !== input.approvalRevision ||
          existing.value.actionDigest !== input.actionDigest ||
          existing.value.controlBasisDigest !== input.controlBasisDigest
        ) {
          return false;
        }
        const now = yield* clock.now();
        const consumed = yield* tx.transact(
          approvals.consumeApproved({
            approvalId: input.approvalId,
            expectedRevision: input.approvalRevision,
            actionDigest: input.actionDigest,
            controlBasisDigest: input.controlBasisDigest,
            consumedAt: now,
            consumedBy: input.consumedBy,
          }),
        );
        return Option.isSome(consumed);
      }).pipe(Effect.orDie);

    return ControlActionAuthorizer.of({ authorize, consumeApproval });
  }),
);
