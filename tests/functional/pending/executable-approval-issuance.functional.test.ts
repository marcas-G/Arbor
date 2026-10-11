import type { ExecutionId } from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../../../apps/single-workspace/src/executable-tool-handler.js";

describe("EA-DG-01 Executable approval issuance boundary", () => {
  it("routes P4 ApprovalRequired through a durable same-action pause", async () => {
    let receivedApprovalId: string | null = "not-called";
    const handler = makeExecutableToolHandler(
      {
        invoke: (intent) => {
          receivedApprovalId = intent.approvalId;
          return Effect.succeed({
            _tag: "Denied" as const,
            reasonCode: "ApprovalRequired" as const,
            reason: "approval required",
          });
        },
      },
      { now: () => Effect.succeed("2026-10-11T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "write_file", version: "2", hash: "tool" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );

    const outcome = await Effect.runPromise(
      handler.handle({
        invocation: {
          providerTurnId: "ptn_ea_test" as never,
          outputPosition: 0,
          callRef: "provider-call-ea-test",
          toolName: "write_file",
          argumentsJson: '{"path":"a.txt","content":"x"}',
        },
        execution: {
          executionId: "exe_ea_test" as ExecutionId,
          projectId: "prj_ea_test" as never,
          workspaceId: "ws_ea_test" as never,
          sessionId: "ses_ea_test" as never,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId: "ws_ea_test" as never,
            focus: { _tag: "Work" },
          },
          admittedAt: "2026-10-11T00:00:00.000Z",
          stopRequestedAt: null,
          state: { status: "Active", settlement: null },
        } as never,
        context: {
          _tag: "ExecutionOrigin",
          principal: "worker:ea-test" as never,
          executionId: "exe_ea_test" as never,
          workerId: "worker-ea-test",
          workerIncarnationId: "incarnation-ea-test",
          fencingGeneration: 0 as never,
        } as never,
        controlBasis: {} as never,
      }),
    );

    // Expected RED at the P36 checkpoint: the production handler constructs
    // approvalId:null and converts P4 ApprovalRequired into a terminal
    // Observation instead of an ApprovalRequired handoff.
    expect(receivedApprovalId).toBe("apr_runtime_issued");
    expect((outcome as { readonly _tag: string })._tag).toBe(
      "ApprovalRequired",
    );
  });
});
