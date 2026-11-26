import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  decisionAction,
  decisionExecution,
  decisionInvocation,
  decisionWorkId,
  legacySelectCommandId,
  makeDecisionHarnessState,
  makeSelectCurrentWorkHandler,
  runControlHandler,
  workspaceId,
} from "./support.js";

export const selectUsesNewCommandIdRetainingLegacyId =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const state = makeDecisionHarnessState();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        if (generation === 0) {
          const rejected = {
            resolution: {
              _tag: "TerminalRejected" as const,
              error: { _tag: "FencingRejected" as const },
            },
          };
          receipts.set(commandId, rejected);
          return Effect.succeed(rejected);
        }
        const result = {
          workspaceId,
          workId: decisionWorkId,
          revision: state.workspaceRevision + 1,
        };
        state.currentWorkId = decisionWorkId;
        state.workspaceRevision = result.revision;
        const committed = {
          resolution: { _tag: "Committed" as const, result },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

    expect(
      await runControlHandler(
        handler,
        decisionAction,
        0,
        decisionInvocation,
        decisionExecution,
      ),
    ).toMatchObject({ _tag: "Rejected" });
    const currentOwner = await runControlHandler(
      handler,
      decisionAction,
      1,
      decisionInvocation,
      decisionExecution,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).toBe(legacySelectCommandId);
    expect(calls[1]?.commandId).not.toBe(calls[0]?.commandId);
    expect(state.currentWorkId).toBe(decisionWorkId);
    expect(state.submitCalls).toBe(1);
  };

export const selectConvergesBeforeDecisionSubmit = async (): Promise<void> => {
  const receipts = new Map<string, unknown>([
    [
      String(legacySelectCommandId),
      {
        resolution: {
          _tag: "Committed" as const,
          result: {
            workspaceId,
            workId: decisionWorkId,
            revision: 6,
          },
        },
      },
    ],
  ]);
  const state = makeDecisionHarnessState();
  state.currentWorkId = decisionWorkId;
  state.workspaceRevision = 6;
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      calls.push(String(envelope.commandId));
      return Effect.succeed(receipts.get(String(envelope.commandId)));
    },
  } as unknown as CommandGatewayService;
  const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

  const converged = await runControlHandler(
    handler,
    decisionAction,
    1,
    decisionInvocation,
    decisionExecution,
  );

  expect(converged._tag).toBe("Accepted");
  expect(calls).toHaveLength(0);
  expect(state.submitCalls).toBe(1);
  expect(state.request.state).toEqual({
    _tag: "Submitted",
    selectedWorkId: decisionWorkId,
  });
};

export const selectConvergesAfterDecisionSubmit = async (): Promise<void> => {
  const receipts = new Map<string, unknown>([
    [
      String(legacySelectCommandId),
      {
        resolution: {
          _tag: "Committed" as const,
          result: {
            workspaceId,
            workId: decisionWorkId,
            revision: 6,
          },
        },
      },
    ],
  ]);
  const state = makeDecisionHarnessState({
    _tag: "Submitted",
    selectedWorkId: decisionWorkId,
  });
  state.currentWorkId = decisionWorkId;
  state.workspaceRevision = 6;
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      calls.push(String(envelope.commandId));
      return Effect.succeed(receipts.get(String(envelope.commandId)));
    },
  } as unknown as CommandGatewayService;
  const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

  const converged = await runControlHandler(
    handler,
    decisionAction,
    1,
    decisionInvocation,
    decisionExecution,
  );

  expect(converged._tag).toBe("Accepted");
  expect(calls).toHaveLength(0);
  expect(state.submitCalls).toBe(0);
};

export const selectDoesNotResendOlderRejection = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const state = makeDecisionHarnessState();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const rejected = {
        resolution: {
          _tag: "TerminalRejected" as const,
          error: { _tag: "RevisionConflict" as const },
        },
      };
      receipts.set(commandId, rejected);
      return Effect.succeed(rejected);
    },
  } as unknown as CommandGatewayService;
  const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

  await runControlHandler(
    handler,
    decisionAction,
    0,
    decisionInvocation,
    decisionExecution,
  );
  const replay = await runControlHandler(
    handler,
    decisionAction,
    1,
    decisionInvocation,
    decisionExecution,
  );

  expect(replay._tag).toBe("Rejected");
  expect(calls).toEqual([String(legacySelectCommandId)]);
};
