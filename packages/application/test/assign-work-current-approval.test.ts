import type {
  CommandSubmissionContext,
  Execution,
  Workspace,
} from "@arbor/domain";
import {
  type AssignWorkApprovalCommandEvidence,
  type ControlApprovalRecord,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AssignWorkPayload,
  makeAssignWorkHandler,
} from "../src/commands/assign-work.js";

const projectId = "prj_current_assign" as never;
const workspaceId = "ws_current_assign" as never;
const executionId = "exe_current_assign" as never;
const workId = "wrk_current_assign" as never;
const commandId = "cmd_current_assign" as never;
const approvalId = "cap_current_assign";
const action = {
  _tag: "AssignWork" as const,
  objective: "one exact current Workspace Work",
  why: "complete the approved root request",
  constraints: ["keep the exact action payload"],
  completionExpectation: "one Work is admitted",
  verificationMission: {
    goal: "verify the new Work",
    criteria: [
      {
        criterionId: "work-created",
        requirement: "one current Workspace Work exists",
        required: true,
      },
    ],
    riskRequirements: [],
  },
  reason: "root request",
};
const actionDigest = sha256Hex(
  JSON.stringify({ stableActionId: "core.control.assign-work", action }),
);
const expiresAt = "2026-10-12T12:00:00.000Z";
const requestedAt = "2026-10-12T10:00:00.000Z";
const approvedAt = "2026-10-12T10:01:00.000Z";

describe("current-Workspace AssignWork approval Command boundary", () => {
  it("consumes the exact Approved row by CommandId in the Work transaction", async () => {
    const authority: Extract<
      AssignWorkApprovalCommandEvidence["authority"],
      { readonly _tag: "ActionApproval" }
    > = {
      _tag: "ActionApproval",
      approvalId,
      approvalRevision: 1,
      projectId,
      workspaceId,
      executionId,
      stableActionId: "core.control.assign-work",
      actionDigest,
      targetRef: workspaceId,
      controlBasisDigest: "basis-current-assign",
      expiresAt,
    };
    const evidence: AssignWorkApprovalCommandEvidence = {
      commandId,
      projectId,
      executionId,
      providerTurnId: "ptn_current_assign" as never,
      logicalActionId: "lac_current_assign",
      callRef: "call_current_assign",
      workspaceId,
      authority,
      action,
    };
    const approval: ControlApprovalRecord = {
      approvalId,
      projectId,
      workspaceId,
      executionId,
      stableActionId: "core.control.assign-work",
      actionDigest,
      argumentsJson: "{}",
      targetRef: workspaceId,
      controlBasisDigest: authority.controlBasisDigest,
      state: "Approved",
      revision: 1,
      requestedAt,
      expiresAt,
      decidedAt: approvedAt,
      decidedBy: "user:approver",
      decisionReason: null,
      consumedAt: null,
      bindingProven: true,
      consumedBy: null,
    };
    const workspace = {
      workspaceId,
      projectId,
      parentWorkspaceId: null,
      currentWorkId: null,
      lifecycle: "Active",
      revision: 0,
    } as unknown as Workspace;
    const execution = {
      executionId,
      projectId,
      workspaceId,
      binding: {
        _tag: "ConversationResponseEpisode",
        humanMessageId: "hmsg_current_assign",
      },
      sessionId: "ses_current_assign",
      admittedAt: requestedAt,
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    } as unknown as Execution;
    const consumed: Array<{
      readonly consumedBy: string;
      readonly consumedAt: string;
    }> = [];
    const created: unknown[] = [];
    const payload: AssignWorkPayload = {
      workId,
      workspaceId,
      expectedWorkspaceRevision: 0 as never,
      objective: action.objective,
      why: action.why,
      constraints: action.constraints,
      completionExpectation: action.completionExpectation,
      verificationMission: action.verificationMission,
      provenance: { predecessorWorkId: null, reason: action.reason },
      revision: 0 as never,
    };
    const handler = makeAssignWorkHandler({
      clock: { now: () => Effect.succeed("2026-10-12T10:02:00.000Z") } as never,
      projects: { findById: () => Effect.succeed(Option.none()) } as never,
      workspaces: {
        findById: () => Effect.succeed(Option.some(workspace)),
      } as never,
      works: {
        create: (work: unknown) =>
          Effect.sync(() => {
            created.push(work);
          }),
      } as never,
      executions: {
        findById: () => Effect.succeed(Option.some(execution)),
      } as never,
      approvals: {
        findById: () => Effect.succeed(Option.some(approval)),
        consumeApproved: (input: {
          readonly consumedBy: string;
          readonly consumedAt: string;
        }) => {
          consumed.push(input);
          return Effect.succeed(
            Option.some({
              ...approval,
              state: "Consumed",
              revision: 2,
              consumedBy: input.consumedBy,
              consumedAt: input.consumedAt,
            }),
          );
        },
      } as never,
    });
    const context: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal: "agent:root" as never,
      executionId,
      fencingGeneration: 0 as never,
    };
    const result = await Effect.runPromise(
      Effect.provideService(
        handler.execute(
          {
            commandType: "AssignWork",
            commandId,
            projectId,
            actor: "agent:root" as never,
            issuedAt: approvedAt,
            payload,
            assignWorkApprovalEvidence: evidence,
          },
          context,
        ),
        TransactionScope,
        { session: { id: "test-current-assign" } },
      ),
    );

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      consumedBy: commandId,
      consumedAt: "2026-10-12T10:02:00.000Z",
      expectedRevision: 1,
      approvalId,
      actionDigest,
      controlBasisDigest: authority.controlBasisDigest,
    });
    expect(result.ok && result.value.events[0]).toMatchObject({
      eventType: "WorkAssigned",
      causedByCommandId: commandId,
      aggregateRef: workspaceId,
    });
  });
});
