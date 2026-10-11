import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  Actor,
  CommandId,
  ExecutionId,
  parse,
  Principal,
  ProjectId,
} from "../../../packages/domain/src/index.js";
import { makeStopExecutionHandler } from "../../../packages/execution-runtime/src/commands/stop-execution.js";
import type { ExecutableApprovalRecord } from "../../../packages/ports/src/executable-approval.js";

const actor = parse(Actor)("user:p38-stop-test");
const principal = parse(Principal)("user:p38-stop-test");
const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

describe("EA-DG-01 Stop cancellation boundary", () => {
  it("Stop cancels exact approvals and emits resolved wake facts", async () => {
    let cancelledInput: unknown;
    const approval: ExecutableApprovalRecord = {
      approvalId: "apr_p38_stop",
      routeKind: "Executable",
      projectId,
      workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
      executionId,
      logicalStepNo: 2,
      repairAttempt: 0,
      actionIndex: 1,
      logicalActionId: "lac_p38_stop",
      subject: principal,
      callRef: "call-p38-stop",
      toolInvocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
      toolName: "write_file",
      toolVersion: "2",
      sideEffectSemantics: "Idempotent",
      argumentsJson: '{"path":"a.txt","content":"x"}',
      actionDigest: "digest-p38",
      targetResourceSpaceIds: ["rsp_project"],
      controlBasisDigest: "basis-p38",
      revision: 1,
      requestedAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:15:00.000Z",
      state: "Cancelled",
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      cancelledAt: "2026-10-11T00:01:00.000Z",
      cancelledBy: principal,
      cancellationReason: "StopRequested",
      consumedAt: null,
      consumedBy: null,
    };
    const handler = makeStopExecutionHandler({
      executions: {
        findById: () =>
          Effect.succeed(
            Option.some({
              executionId,
              projectId,
              workspaceId: approval.workspaceId,
              sessionId: "ses_p38_stop" as never,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId: approval.workspaceId,
                focus: { _tag: "Work", workId: "wrk_p38_stop" },
              },
              admittedAt: "2026-10-11T00:00:00.000Z",
              stopRequestedAt: null,
              state: { status: "Active", settlement: null },
            } as never),
          ),
        requestStop: () => Effect.void,
      } as never,
      executableApprovals: {
        cancelForExecution: (input) => {
          cancelledInput = input;
          return Effect.succeed([approval]);
        },
      },
    });

    const result = await Effect.runPromise(
      handler.execute(
        {
          projectId,
          commandId,
          actor,
          issuedAt: "2026-10-11T00:01:00.000Z",
          payload: { executionId },
        } as never,
        { _tag: "System", principal, causationRef: "p38-stop-test" } as never,
      ),
    );

    expect(cancelledInput).toEqual({
      executionId,
      cancelledAt: "2026-10-11T00:01:00.000Z",
      cancelledBy: principal,
      reason: "StopRequested",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        events: expect.arrayContaining([
          {
            eventType: "ExecutableApprovalResolved",
            aggregateRef: approval.approvalId,
            payload: {
              approvalId: approval.approvalId,
              routeKind: "Executable",
              toolInvocationId: approval.toolInvocationId,
              revision: 1,
              resolution: "Cancelled",
              reasonCode: "StopRequested",
            },
          },
        ]),
      },
    });
  });
});
