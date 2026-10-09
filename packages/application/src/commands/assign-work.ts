import {
  assignWork,
  type Revision,
  type VerificationMission,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  AssignWorkTargetBindingRepositoryService,
  ClockService,
  ControlApprovalStoreService,
  ExecutionRepositoryService,
  PendingDomainEvent,
  PermissionGrantRepositoryService,
  ProjectRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface AssignWorkPayload {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkspaceRevision: Revision;
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: VerificationMission;
  readonly provenance: {
    readonly predecessorWorkId: WorkId | null;
    readonly reason: string;
  };
  readonly revision: WorkRevision;
}

export interface AssignWorkResult {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly revision: WorkRevision;
}

export interface AssignWorkDependencies {
  readonly clock?: Pick<ClockService, "now">;
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly executions?: Pick<ExecutionRepositoryService, "findById">;
  readonly bindings?: Pick<AssignWorkTargetBindingRepositoryService, "insert">;
  readonly grants?: Pick<PermissionGrantRepositoryService, "findById">;
  readonly approvals?: Pick<
    ControlApprovalStoreService,
    "findById" | "consumeApproved"
  >;
}

export const makeAssignWorkHandler = (
  dependencies: AssignWorkDependencies,
): CommandHandler<AssignWorkPayload, AssignWorkResult> => ({
  commandType: "AssignWork",
  schemaVersion: "1",
  authority: {
    tag: "AssignWorkAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "AssignWorkAuthority" &&
      authority.targetWorkspaceId === payload.workspaceId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const evidence = envelope.assignWorkEvidence;
      const workspace = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (Option.isNone(workspace)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: payload.workspaceId,
        });
      }
      const currentWorkspace = workspace.value;
      if (currentWorkspace.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "workspace belongs to another project",
        });
      }

      const project = yield* dependencies.projects.findById(envelope.projectId);
      if (Option.isSome(project) && project.value.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Project",
          lifecycle: project.value.lifecycle,
        });
      }
      if (currentWorkspace.lifecycle !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Workspace",
          lifecycle: currentWorkspace.lifecycle,
        });
      }
      if (currentWorkspace.revision !== payload.expectedWorkspaceRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedWorkspaceRevision,
          actual: currentWorkspace.revision,
        });
      }

      let binding: import("@arbor/ports").AssignWorkTargetBinding | undefined;
      if (evidence !== undefined) {
        const rejected = (reason: string) =>
          commandErr({ _tag: "AuthorityDenied" as const, reason });
        if (
          context._tag !== "ExecutionOrigin" ||
          dependencies.executions === undefined ||
          dependencies.bindings === undefined ||
          dependencies.grants === undefined ||
          dependencies.approvals === undefined ||
          evidence.commandId !== envelope.commandId ||
          evidence.projectId !== envelope.projectId ||
          evidence.executionId !== context.executionId ||
          evidence.target.targetWorkspaceId !== payload.workspaceId ||
          evidence.action._tag !== "AssignWork" ||
          evidence.action.targetWorkspaceRef !== evidence.targetWorkspaceRef ||
          evidence.action.objective !== payload.objective ||
          evidence.action.why !== payload.why ||
          JSON.stringify(evidence.action.constraints) !==
            JSON.stringify(payload.constraints) ||
          evidence.action.completionExpectation !==
            payload.completionExpectation ||
          JSON.stringify(evidence.action.verificationMission) !==
            JSON.stringify(payload.verificationMission) ||
          evidence.action.reason !== payload.provenance.reason ||
          evidence.parentWorkId !== payload.provenance.predecessorWorkId ||
          payload.provenance.predecessorWorkId === null
        ) {
          return rejected(
            "AssignWork trusted target evidence is incomplete or mismatched",
          );
        }
        const targetResolution = evidence.target;
        const execution = yield* dependencies.executions.findById(
          evidence.executionId,
        );
        const parentResult = yield* dependencies.workspaces.findById(
          evidence.parentWorkspaceId,
        );
        const parentWorkId = payload.provenance.predecessorWorkId;
        if (
          Option.isNone(parentResult) ||
          Option.isNone(execution) ||
          execution.value.projectId !== envelope.projectId ||
          execution.value.workspaceId !== evidence.parentWorkspaceId ||
          parentResult.value.lifecycle !== "Active" ||
          parentResult.value.projectId !== envelope.projectId ||
          parentResult.value.currentWorkId !== parentWorkId ||
          parentWorkId === null ||
          payload.workspaceId !== targetResolution.targetWorkspaceId ||
          currentWorkspace.parentWorkspaceId !== evidence.parentWorkspaceId ||
          targetResolution.projectId !== envelope.projectId ||
          targetResolution.refEncodingVersion !== 1 ||
          targetResolution.targetWorkspaceRevision !==
            payload.expectedWorkspaceRevision
        ) {
          return rejected(
            "AssignWork target resolution no longer matches current Parent placement",
          );
        }
        const parentWorkResult =
          yield* dependencies.works.findById(parentWorkId);
        if (
          Option.isNone(parentWorkResult) ||
          parentWorkResult.value.projectId !== envelope.projectId ||
          parentWorkResult.value.workspaceId !== evidence.parentWorkspaceId
        ) {
          return rejected("AssignWork Parent Work binding is unavailable");
        }
        const authority = evidence.authority;
        if (dependencies.clock === undefined) {
          return rejected(
            "AssignWork commit-time Clock service is unavailable",
          );
        }
        let authorityCheckedAt: string;
        if (
          authority.actionDigest !==
          sha256Hex(
            JSON.stringify({
              stableActionId: "core.control.assign-work",
              action: evidence.action,
            }),
          )
        ) {
          return rejected(
            "AssignWork action digest does not match its trusted payload",
          );
        }
        if (authority._tag === "PermissionGrant") {
          const grant = yield* dependencies.grants.findById(
            authority.permissionGrantId,
          );
          // The handler runs inside the Gateway transaction. Sample only after
          // the authority read so repository latency cannot cross expiry.
          authorityCheckedAt = yield* dependencies.clock.now();
          const grantMatches =
            Option.isSome(grant) &&
            grant.value.state === "Active" &&
            grant.value.revision === authority.permissionGrantRevision &&
            authority.projectId === envelope.projectId &&
            authority.targetRef === evidence.targetWorkspaceRef &&
            authority.capability === "core.control.assign-work" &&
            grant.value.capability === authority.capability &&
            grant.value.target === authority.targetRef &&
            grant.value.validFrom === authority.validFrom &&
            (grant.value.expiresAt ?? null) === authority.expiresAt &&
            Date.parse(authority.validFrom) <= Date.parse(authorityCheckedAt) &&
            (authority.expiresAt === null ||
              Date.parse(authorityCheckedAt) <
                Date.parse(authority.expiresAt)) &&
            ((authority.subjectKind === "WorkspaceAgent" &&
              grant.value.subject?._tag === "WorkspaceAgent" &&
              grant.value.subject.workspaceId === authority.subjectRef &&
              authority.subjectRef === evidence.parentWorkspaceId) ||
              (authority.subjectKind === "Execution" &&
                grant.value.subject?._tag === "Execution" &&
                grant.value.subject.executionId === authority.subjectRef &&
                authority.subjectRef === evidence.executionId));
          if (!grantMatches)
            return rejected(
              "AssignWork PermissionGrant changed before Command commit",
            );
        } else {
          const approval = yield* dependencies.approvals.findById(
            authority.approvalId,
          );
          authorityCheckedAt = yield* dependencies.clock.now();
          if (
            Option.isNone(approval) ||
            approval.value.state !== "Approved" ||
            approval.value.bindingProven !== true ||
            approval.value.revision !== authority.approvalRevision ||
            approval.value.projectId !== authority.projectId ||
            approval.value.workspaceId !== authority.workspaceId ||
            approval.value.executionId !== authority.executionId ||
            authority.projectId !== envelope.projectId ||
            authority.workspaceId !== evidence.parentWorkspaceId ||
            authority.executionId !== evidence.executionId ||
            approval.value.stableActionId !== authority.stableActionId ||
            authority.stableActionId !== "core.control.assign-work" ||
            approval.value.actionDigest !== authority.actionDigest ||
            approval.value.targetRef !== evidence.targetWorkspaceRef ||
            authority.targetRef !== evidence.targetWorkspaceRef ||
            approval.value.controlBasisDigest !==
              authority.controlBasisDigest ||
            approval.value.expiresAt !== authority.expiresAt ||
            Date.parse(authorityCheckedAt) >= Date.parse(authority.expiresAt)
          ) {
            return rejected(
              "AssignWork ActionApproval changed before Command commit",
            );
          }
        }
        binding = {
          schemaVersion: 1,
          commandId: envelope.commandId,
          projectId: envelope.projectId,
          executionId: evidence.executionId,
          providerTurnId: evidence.providerTurnId,
          logicalActionId: evidence.logicalActionId,
          callRef: evidence.callRef,
          parentWorkspaceId: evidence.parentWorkspaceId,
          parentWorkId,
          parentWorkRevisionAtCommand: Number(parentWorkResult.value.revision),
          targetWorkspaceRef: evidence.targetWorkspaceRef,
          targetRefEncodingVersion: targetResolution.refEncodingVersion,
          parentWorkspaceRevisionAtCommand: Number(parentResult.value.revision),
          targetWorkspaceRevisionAtResolution:
            targetResolution.targetWorkspaceRevision,
          targetWorkspaceId: payload.workspaceId,
          targetLifecycleAtCommit: "Active",
          workId: payload.workId,
          predecessorWorkId: parentWorkId,
          workProvenanceJson: JSON.stringify(payload.provenance),
          authority,
          authorityCheckedAt,
        };
      }

      const assigned = assignWork({
        workId: payload.workId,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        objective: payload.objective,
        why: payload.why,
        constraints: payload.constraints,
        completionExpectation: payload.completionExpectation,
        verificationMission: payload.verificationMission,
        provenance: payload.provenance,
        revision: payload.revision,
        authorized: true,
        workspaceAcceptsWork: true,
      });
      if (!assigned.ok) {
        return commandErr(assigned.error);
      }
      if (binding?.authority._tag === "ActionApproval") {
        const approvals = dependencies.approvals;
        if (approvals === undefined) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "AssignWork ActionApproval store is unavailable",
          });
        }
        const consumed = yield* approvals.consumeApproved({
          approvalId: binding.authority.approvalId,
          expectedRevision: binding.authority.approvalRevision,
          actionDigest: binding.authority.actionDigest,
          controlBasisDigest: binding.authority.controlBasisDigest,
          consumedAt: binding.authorityCheckedAt,
          consumedBy: envelope.commandId,
        });
        if (consumed === undefined || Option.isNone(consumed)) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "AssignWork ActionApproval was no longer consumable",
          });
        }
      }
      yield* dependencies.works.create(assigned.value);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkAssigned",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workId: payload.workId,
            workspaceId: payload.workspaceId,
            projectId: envelope.projectId,
            objective: payload.objective,
          },
        },
      ];

      return commandOk({
        result: {
          workId: payload.workId,
          workspaceId: payload.workspaceId,
          lifecycle: "Open" as const,
          revision: payload.revision,
        },
        events,
        ...(binding === undefined
          ? {}
          : dependencies.bindings === undefined
            ? {}
            : { afterReceipt: dependencies.bindings.insert(binding) }),
      });
    }),
});
