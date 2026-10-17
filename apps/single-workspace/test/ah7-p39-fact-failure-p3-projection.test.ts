import { TransactionScope } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { executeAgentLoopActions } from "../../../packages/agent-runtime/src/agent-loop-actions.js";
import { makeExecutableToolHandler } from "../src/executable-tool-handler.js";

describe("AH7 P39 fact-store failure at the P3 executable boundary", () => {
  it("projects SettlementJournal uncertainty as ReconciliationPending, never success", async () => {
    const executionId = "exe_ah7_p39_fact_failure";
    const workspaceId = "ws_ah7_p39_fact_failure";
    const sessionId = "ses_ah7_p39_fact_failure";
    const providerTurnId = "ptn_ah7_p39_fact_failure";
    const callRef = "call_ah7_p39_fact_failure";
    const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789a4";
    const toolResultRows: Array<Record<string, unknown>> = [];
    const actions: Array<Record<string, unknown>> = [];
    let step = {
      identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId,
      state: "ActionsInProgress" as const,
      nextActionIndex: 0,
      revision: 0,
      updatedAt: "2026-10-17T00:00:00.000Z",
    };

    const handler = makeExecutableToolHandler(
      {
        invoke: () =>
          Effect.fail({
            _tag: "ToolRuntimeOperationalFailure",
            stage: "SettlementJournal",
            effectDisposition: "OutcomeUncertain",
            invocationRef: invocationId,
            cause: {
              _tag: "PersistenceUnavailable",
              repository: "ToolReconciliationFactStore",
              operation: "record",
              sourceTag: "InjectedP39FactWriteFailure",
            },
          }),
      },
      { now: () => Effect.succeed("2026-10-17T00:00:01.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "shell", version: "3", hash: "shell-v3" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const loopSteps = {
      listActions: () => Effect.succeed(actions),
      createAction: (action: Record<string, unknown>) =>
        Effect.sync(() => {
          actions.push(action);
          return action;
        }),
      transitionAction: (input: {
        readonly actionIndex: number;
        readonly next: Record<string, unknown>;
      }) =>
        Effect.sync(() => {
          actions[input.actionIndex] = input.next;
          return input.next;
        }),
      transition: (input: { readonly next: typeof step }) =>
        Effect.sync(() => {
          step = input.next;
          return step;
        }),
    };
    const sessions = {
      supportsTypedTimeline: () => Effect.succeed(true),
      appendItemIdempotent: (_id: string, input: { readonly item: unknown }) =>
        Effect.sync(() => {
          toolResultRows.push(input.item as Record<string, unknown>);
        }),
    };

    const result = await Effect.runPromise(
      executeAgentLoopActions({
        input: {
          execution: {
            executionId,
            sessionId,
            workspaceId,
            projectId: "prj_ah7_p39_fact_failure",
            binding: {
              _tag: "WorkspaceExecution",
              workspaceId,
              focus: { _tag: "Coordination" },
            },
          } as never,
          context: {
            _tag: "ExecutionOrigin",
            principal: "worker:ah7-test",
            workerId: "worker:ah7-test",
            workerIncarnationId: "incarnation:ah7-test",
            fencingGeneration: 0,
          } as never,
        },
        preparedTurn: {
          manifest: { providerTurnId, contextEpoch: 0, controlBasis: {} },
          toolRoutes: [{ name: "shell", route: "Executable" }],
        } as never,
        decodedOutput: {
          text: "",
          finishReason: "ToolCalls",
          toolInvocations: [
            {
              providerTurnId,
              outputPosition: 0,
              callRef,
              toolName: "shell",
              argumentsJson: "{}",
            },
          ],
        } as never,
        turn: 0,
        currentLoopStep: step as never,
        loopSteps: loopSteps as never,
        loopStepFence: {
          executionId,
          workerId: "worker:ah7-test",
          workerIncarnationId: "incarnation:ah7-test",
          fencingGeneration: 0,
        } as never,
        tx: {
          transact: (body: Effect.Effect<unknown, unknown, never>) =>
            Effect.provideService(body, TransactionScope, {
              session: { id: "ah7-p39-fact-failure" },
            }),
        } as never,
        sessions: sessions as never,
        controlRegistry: {
          classify: () => "NotControl",
          definitions: () => [],
          decode: () => Effect.die("unused"),
          handle: () => Effect.die("unused"),
        } as never,
        executableInvocationHandler: handler as never,
        currentControlBasis: () => Effect.succeed({} as never),
        admit: () => Effect.succeed("Continue"),
        failure: (cause: unknown) => cause as never,
        now: () => Effect.succeed("2026-10-17T00:00:02.000Z"),
      } as never),
    );

    expect(result).toEqual({
      _tag: "Settle",
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: [invocationId],
        },
      },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      state: "ReconciliationPending",
      disposition: {
        _tag: "ExecutionSettlement:OutcomeUnknown",
        status: "OutcomeUnknown",
      },
    });
    expect(actions[0]).not.toMatchObject({
      state: "Applied",
    });
    expect(actions[0]).not.toMatchObject({
      state: "TerminalRejected",
    });
    expect(toolResultRows).toHaveLength(1);
    expect(toolResultRows[0]).toMatchObject({
      _tag: "ToolResult",
      callRef,
      status: "OutcomeUnknown",
      outputText: "Control action settled the execution (OutcomeUnknown)",
      artifactRefs: [],
    });
    expect(toolResultRows[0]).not.toMatchObject({ status: "Succeeded" });
    expect(toolResultRows[0]).not.toMatchObject({ status: "Failed" });
    expect(step.nextActionIndex).toBe(1);
  });
});
