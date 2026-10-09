import type {
  CommandSubmissionContext,
  Execution,
  PermissionGrant,
  Work,
  Workspace,
} from "@arbor/domain";
import {
  type AssignWorkCommandEvidence,
  type AssignWorkControlAuthorizationEvidence,
  type ControlApprovalRecord,
  type ProjectRepositoryService,
  sha256Hex,
  TransactionScope,
  type WorkRepositoryService,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AssignWorkPayload,
  makeAssignWorkHandler,
} from "../src/commands/assign-work.js";

const NOW = "2026-10-09T12:00:00.000Z";
const PROJECT = "prj_target_binding" as never;
const PARENT = "ws_target_parent" as never;
const TARGET = "ws_target_child" as never;
const PARENT_WORK = "wrk_target_parent" as never;
const WORK = "wrk_target_child" as never;
const EXECUTION = "exe_target_parent" as never;
const COMMAND = "cmd_target_binding" as never;
const REF = `wref_${"a".repeat(64)}`;
const MISSION = {
  goal: "verify",
  criteria: [{ criterionId: "result", requirement: "result", required: true }],
  riskRequirements: [],
};
const ACTION = {
  _tag: "AssignWork" as const,
  targetWorkspaceRef: REF,
  objective: "child objective",
  why: "child owns it",
  constraints: ["exact target"],
  completionExpectation: "one result",
  verificationMission: MISSION,
  reason: "bounded delegation",
};
const ACTION_DIGEST = sha256Hex(
  JSON.stringify({
    stableActionId: "core.control.assign-work",
    action: ACTION,
  }),
);
const BASIS_DIGEST = sha256Hex("basis");

const executeAssign = async (input: {
  readonly authority: AssignWorkControlAuthorizationEvidence;
  readonly commitTime?: string;
  readonly advanceClockDuringRead?: string;
  readonly targetLifecycle?: "Active" | "Retired";
  readonly grant?: PermissionGrant;
  readonly approval?: ControlApprovalRecord;
}) => {
  let workCreates = 0;
  let approvalConsumedBy: string | undefined;
  let approvalConsumedAt: string | undefined;
  let clockValue = input.commitTime ?? NOW;
  const parentWork = {
    workId: PARENT_WORK,
    projectId: PROJECT,
    workspaceId: PARENT,
    objective: "parent",
    why: "parent",
    constraints: [],
    completionExpectation: "parent",
    verificationMission: MISSION,
    provenance: { predecessorWorkId: null, reason: "root" },
    lifecycle: "Open",
    revision: 0,
  } as unknown as Work;
  const parent = {
    workspaceId: PARENT,
    projectId: PROJECT,
    parentWorkspaceId: null,
    currentWorkId: PARENT_WORK,
    lifecycle: "Active",
    revision: 4,
  } as unknown as Workspace;
  const child = {
    workspaceId: TARGET,
    projectId: PROJECT,
    parentWorkspaceId: PARENT,
    currentWorkId: null,
    lifecycle: input.targetLifecycle ?? "Active",
    revision: 3,
  } as unknown as Workspace;
  const workspaces = {
    findById: (id: string) =>
      Effect.succeed(Option.some(id === TARGET ? child : parent)),
  } as unknown as WorkspaceRepositoryService;
  const works = {
    findById: () => Effect.succeed(Option.some(parentWork)),
    create: () =>
      Effect.sync(() => {
        workCreates += 1;
      }),
  } as unknown as WorkRepositoryService;
  const projects = {
    findById: () => Effect.succeed(Option.none()),
  } as unknown as ProjectRepositoryService;
  const handler = makeAssignWorkHandler({
    clock: {
      now: () => Effect.sync(() => clockValue),
    } as never,
    projects,
    workspaces,
    works,
    executions: {
      findById: () =>
        Effect.succeed(
          Option.some({
            executionId: EXECUTION,
            projectId: PROJECT,
            workspaceId: PARENT,
            binding: {
              _tag: "WorkspaceExecution",
              episode: {
                _tag: "WorkEpisode",
                workId: PARENT_WORK,
                targetWorkRevision: 0,
              },
            },
            sessionId: "ses_parent",
            admittedAt: NOW,
            stopRequestedAt: null,
            state: { status: "Active", settlement: null },
          } as unknown as Execution),
        ),
    },
    bindings: { insert: () => Effect.void },
    grants: {
      findById: () =>
        Effect.sync(() => {
          if (input.advanceClockDuringRead !== undefined) {
            clockValue = input.advanceClockDuringRead;
          }
          return input.grant === undefined
            ? Option.none()
            : Option.some(input.grant);
        }),
    },
    approvals: {
      findById: () =>
        Effect.sync(() => {
          if (input.advanceClockDuringRead !== undefined) {
            clockValue = input.advanceClockDuringRead;
          }
          return input.approval === undefined
            ? Option.none()
            : Option.some(input.approval);
        }),
      consumeApproved: (consume) => {
        approvalConsumedBy = consume.consumedBy;
        approvalConsumedAt = consume.consumedAt;
        return Effect.succeed(
          Option.some({
            ...input.approval,
            state: "Consumed",
            revision: consume.expectedRevision + 1,
            consumedBy: consume.consumedBy,
          } as ControlApprovalRecord),
        );
      },
    },
  });
  const payload: AssignWorkPayload = {
    workId: WORK,
    workspaceId: TARGET,
    expectedWorkspaceRevision: 3 as never,
    objective: ACTION.objective,
    why: ACTION.why,
    constraints: ACTION.constraints,
    completionExpectation: ACTION.completionExpectation,
    verificationMission: MISSION,
    provenance: { predecessorWorkId: PARENT_WORK, reason: ACTION.reason },
    revision: 0 as never,
  };
  const evidence: AssignWorkCommandEvidence = {
    commandId: COMMAND,
    projectId: PROJECT,
    executionId: EXECUTION,
    providerTurnId: "ptn_target_turn" as never,
    logicalActionId: "lac_target_binding",
    callRef: "call_target_binding",
    parentWorkspaceId: PARENT,
    parentWorkId: PARENT_WORK,
    targetWorkspaceRef: REF,
    target: {
      _tag: "ResolvedChildPlacementRef",
      projectId: PROJECT,
      targetWorkspaceId: TARGET,
      targetWorkspaceRevision: 3,
      refEncodingVersion: 1,
    },
    authority: input.authority,
    action: ACTION,
  };
  const context: CommandSubmissionContext = {
    _tag: "ExecutionOrigin",
    principal: "agent:parent" as never,
    executionId: EXECUTION,
    fencingGeneration: 0 as never,
  };
  const result = await Effect.runPromise(
    Effect.provideService(
      handler.execute(
        {
          commandType: "AssignWork",
          commandId: COMMAND,
          projectId: PROJECT,
          actor: "agent:parent" as never,
          issuedAt: NOW,
          payload,
          assignWorkEvidence: evidence,
        },
        context,
      ),
      TransactionScope,
      { session: { id: "test" } },
    ),
  );
  return { result, workCreates, approvalConsumedBy, approvalConsumedAt };
};

const grantEvidence = (
  expiresAt: string,
): AssignWorkControlAuthorizationEvidence => ({
  _tag: "PermissionGrant",
  permissionGrantId: "pgr_target_binding" as never,
  permissionGrantRevision: 0,
  projectId: PROJECT,
  subjectKind: "WorkspaceAgent",
  subjectRef: PARENT,
  capability: "core.control.assign-work",
  targetRef: REF,
  validFrom: "2026-10-09T11:00:00.000Z",
  expiresAt,
  actionDigest: ACTION_DIGEST,
  controlBasisDigest: BASIS_DIGEST,
});

describe("DID v1.33 AssignWork target-bound Command revalidation", () => {
  it("uses the post-read commit-time sample for ActionApproval consumption", async () => {
    const expiresAt = "2026-10-09T13:00:00.000Z";
    const consumedAt = "2026-10-09T12:30:00.000Z";
    const authority: AssignWorkControlAuthorizationEvidence = {
      _tag: "ActionApproval",
      approvalId: "cap_target_binding",
      approvalRevision: 1,
      projectId: PROJECT,
      workspaceId: PARENT,
      executionId: EXECUTION,
      stableActionId: "core.control.assign-work",
      actionDigest: ACTION_DIGEST,
      targetRef: REF,
      controlBasisDigest: BASIS_DIGEST,
      expiresAt,
    };
    const committed = await executeAssign({
      authority,
      commitTime: NOW,
      advanceClockDuringRead: consumedAt,
      approval: {
        approvalId: authority.approvalId,
        projectId: PROJECT,
        workspaceId: PARENT,
        executionId: EXECUTION,
        stableActionId: authority.stableActionId,
        actionDigest: ACTION_DIGEST,
        argumentsJson: "{}",
        targetRef: REF,
        controlBasisDigest: BASIS_DIGEST,
        state: "Approved",
        revision: 1,
        requestedAt: "2026-10-09T11:00:00.000Z",
        expiresAt,
        decidedAt: "2026-10-09T11:30:00.000Z",
        decidedBy: "user:approver",
        decisionReason: null,
        consumedAt: null,
        consumedBy: null,
        bindingProven: true,
      } as ControlApprovalRecord,
    });
    expect(committed.result.ok).toBe(true);
    expect(committed.approvalConsumedAt).toBe(consumedAt);
    expect(committed.approvalConsumedBy).toBe(COMMAND);
  });

  it.each([
    { _tag: "PermissionGrant" as const, expiresAt: "2026-10-09T12:00:01.000Z" },
    { _tag: "ActionApproval" as const, expiresAt: "2026-10-09T12:00:01.000Z" },
  ])(
    "rejects $._tag that expires while its authority row is read",
    async ({ _tag, expiresAt }) => {
      const authority: AssignWorkControlAuthorizationEvidence =
        _tag === "PermissionGrant"
          ? grantEvidence(expiresAt)
          : {
              _tag: "ActionApproval",
              approvalId: "cap_target_binding",
              approvalRevision: 1,
              projectId: PROJECT,
              workspaceId: PARENT,
              executionId: EXECUTION,
              stableActionId: "core.control.assign-work",
              actionDigest: ACTION_DIGEST,
              targetRef: REF,
              controlBasisDigest: BASIS_DIGEST,
              expiresAt,
            };
      const result = await executeAssign({
        authority,
        commitTime: NOW,
        advanceClockDuringRead: expiresAt,
        ...(_tag === "PermissionGrant"
          ? {
              grant: {
                permissionGrantId: "pgr_target_binding" as never,
                scope: "project",
                issuer: "user:local" as never,
                lifetime: "test",
                subject: { _tag: "WorkspaceAgent", workspaceId: PARENT },
                capability: "core.control.assign-work",
                target: REF,
                validFrom: "2026-10-09T11:00:00.000Z",
                expiresAt,
                revision: 0,
                state: "Active",
              } as PermissionGrant,
            }
          : {
              approval: {
                approvalId: "cap_target_binding",
                projectId: PROJECT,
                workspaceId: PARENT,
                executionId: EXECUTION,
                stableActionId: "core.control.assign-work",
                actionDigest: ACTION_DIGEST,
                argumentsJson: "{}",
                targetRef: REF,
                controlBasisDigest: BASIS_DIGEST,
                state: "Approved",
                revision: 1,
                requestedAt: "2026-10-09T11:00:00.000Z",
                expiresAt,
                decidedAt: "2026-10-09T11:30:00.000Z",
                decidedBy: "user:approver",
                decisionReason: null,
                consumedAt: null,
                consumedBy: null,
                bindingProven: true,
              } as ControlApprovalRecord,
            }),
      });
      expect(result.result).toMatchObject({
        ok: false,
        error: { _tag: "AuthorityDenied" },
      });
      expect(result.workCreates).toBe(0);
      expect(result.approvalConsumedBy).toBeUndefined();
    },
  );

  it("rejects an expired Grant and a target retired before commit before Work mutation", async () => {
    const expiredAt = "2026-10-09T11:59:59.000Z";
    const expired = await executeAssign({
      authority: grantEvidence(expiredAt),
      grant: {
        permissionGrantId: "pgr_target_binding" as never,
        scope: "project",
        issuer: "user:local" as never,
        lifetime: "test",
        subject: { _tag: "WorkspaceAgent", workspaceId: PARENT },
        capability: "core.control.assign-work",
        target: REF,
        validFrom: "2026-10-09T11:00:00.000Z",
        expiresAt: expiredAt,
        revision: 0,
        state: "Active",
      } as PermissionGrant,
    });
    expect(expired.result).toMatchObject({
      ok: false,
      error: { _tag: "AuthorityDenied" },
    });
    expect(expired.workCreates).toBe(0);

    const revokedEvidence = grantEvidence("2026-10-09T13:00:00.000Z");
    const revoked = await executeAssign({
      authority: revokedEvidence,
      grant: {
        permissionGrantId: "pgr_target_binding" as never,
        scope: "project",
        issuer: "user:local" as never,
        lifetime: "test",
        subject: { _tag: "WorkspaceAgent", workspaceId: PARENT },
        capability: "core.control.assign-work",
        target: REF,
        validFrom: "2026-10-09T11:00:00.000Z",
        expiresAt: "2026-10-09T13:00:00.000Z",
        revision: 0,
        state: "Revoked",
      } as PermissionGrant,
    });
    expect(revoked.result).toMatchObject({
      ok: false,
      error: { _tag: "AuthorityDenied" },
    });
    expect(revoked.workCreates).toBe(0);

    const liveEvidence = grantEvidence("2026-10-09T13:00:00.000Z");
    const retired = await executeAssign({
      authority: liveEvidence,
      grant: {
        permissionGrantId: "pgr_target_binding" as never,
        scope: "project",
        issuer: "user:local" as never,
        lifetime: "test",
        subject: { _tag: "WorkspaceAgent", workspaceId: PARENT },
        capability: "core.control.assign-work",
        target: REF,
        validFrom: "2026-10-09T11:00:00.000Z",
        expiresAt: liveEvidence.expiresAt,
        revision: 0,
        state: "Active",
      } as PermissionGrant,
      targetLifecycle: "Retired",
    });
    expect(retired.result).toMatchObject({
      ok: false,
      error: { _tag: "TerminalLifecycleMutation", entity: "Workspace" },
    });
    expect(retired.workCreates).toBe(0);
  });

  it("rejects a stale ActionApproval revision without consuming or creating Work", async () => {
    const expiresAt = "2026-10-09T13:00:00.000Z";
    const authority: AssignWorkControlAuthorizationEvidence = {
      _tag: "ActionApproval",
      approvalId: "cap_target_binding",
      approvalRevision: 1,
      projectId: PROJECT,
      workspaceId: PARENT,
      executionId: EXECUTION,
      stableActionId: "core.control.assign-work",
      actionDigest: ACTION_DIGEST,
      targetRef: REF,
      controlBasisDigest: BASIS_DIGEST,
      expiresAt,
    };
    const stale = await executeAssign({
      authority,
      approval: {
        approvalId: authority.approvalId,
        projectId: PROJECT,
        workspaceId: PARENT,
        executionId: EXECUTION,
        stableActionId: authority.stableActionId,
        actionDigest: ACTION_DIGEST,
        argumentsJson: "{}",
        targetRef: REF,
        controlBasisDigest: BASIS_DIGEST,
        state: "Approved",
        revision: 2,
        requestedAt: "2026-10-09T11:00:00.000Z",
        expiresAt,
        decidedAt: "2026-10-09T11:30:00.000Z",
        decidedBy: "user:approver",
        decisionReason: null,
        consumedAt: null,
        consumedBy: null,
        bindingProven: true,
      },
    });
    expect(stale.result).toMatchObject({
      ok: false,
      error: { _tag: "AuthorityDenied" },
    });
    expect(stale.approvalConsumedBy).toBeUndefined();
    expect(stale.workCreates).toBe(0);
  });
});
