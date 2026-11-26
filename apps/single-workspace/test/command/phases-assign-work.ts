import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import { CommandId, parse, WorkId, WorkspaceId } from "@arbor/domain";
import type { ClockService, WorkspaceRepositoryService } from "@arbor/ports";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import { assignWorkHandler } from "../../src/control-actions.js";
import {
  action,
  childWorkspaceId,
  invocation,
  makeHandler,
  projectId,
  runControlHandler,
  runHandler,
  transaction,
  workspaceId,
} from "./support.js";

export const rejectsModelAuthoredChildWorkspaceId = async (): Promise<void> => {
  const child = childWorkspaceId;
  const gatewayCalls: Array<GatewayEnvelope<unknown>> = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      gatewayCalls.push(envelope);
      const payload = envelope.payload as {
        readonly workId: string;
        readonly workspaceId: string;
      };
      return Effect.succeed({
        commandId: envelope.commandId,
        resolution: {
          _tag: "Committed" as const,
          result: {
            workId: parse(WorkId)(payload.workId),
            workspaceId: parse(WorkspaceId)(payload.workspaceId),
          },
        },
      });
    },
  } as unknown as CommandGatewayService;
  const handler = assignWorkHandler({
    gateway,
    workspaces: {
      findById: (id: WorkspaceId) =>
        Effect.succeed(
          Option.some({
            workspaceId: id,
            projectId,
            parentWorkspaceId: id === child ? workspaceId : null,
            lifecycle: "Active",
            revision: 3,
          } as never),
        ),
    } as unknown as WorkspaceRepositoryService,
    clock: {
      now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
    } as ClockService,
    tx: transaction,
  });
  const result = await runControlHandler(
    handler,
    { ...action, targetWorkspaceId: child },
    0,
    {
      ...invocation,
      providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b5" as never,
    },
  );
  expect(result._tag).toBe("Rejected");
  expect(gatewayCalls).toHaveLength(0);
  const currentWorkspaceResult = await runControlHandler(
    handler,
    { ...action, targetWorkspaceId: workspaceId },
    0,
    {
      ...invocation,
      providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b6" as never,
    },
  );
  expect(currentWorkspaceResult._tag).toBe("Accepted");
  expect(gatewayCalls).toHaveLength(1);
};

export const usesNewCommandIdAfterFencingRejected = async (): Promise<void> => {
  const receipts = new Map<
    string,
    {
      readonly commandId: CommandId;
      readonly resolution: {
        readonly _tag: string;
        readonly error?: unknown;
      };
    }
  >();
  const calls: Array<{
    readonly commandId: string;
    readonly generation: number;
    readonly workId: string;
  }> = [];
  let committedWorkEffects = 0;

  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
      const commandId = String(envelope.commandId);
      const generation = Number(
        (context as { readonly fencingGeneration: number }).fencingGeneration,
      );
      const payload = envelope.payload as { readonly workId: string };
      calls.push({ commandId, generation, workId: payload.workId });
      const prior = receipts.get(commandId);
      if (prior !== undefined) return Effect.succeed(prior);

      if (generation === 0) {
        const rejected = {
          commandId: envelope.commandId,
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "FencingRejected" as const },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      }

      committedWorkEffects += 1;
      const committed = {
        commandId: envelope.commandId,
        resolution: {
          _tag: "Committed" as const,
          result: {
            workId: parse(WorkId)(payload.workId),
            workspaceId,
            lifecycle: "Open",
            revision: 0,
          },
        },
      };
      receipts.set(commandId, committed);
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;

  const handler = makeHandler(gateway, receipts);

  const oldOwner = await runHandler(handler, 0);
  expect(oldOwner._tag).toBe("Rejected");
  expect(receipts.size).toBe(1);
  expect([...receipts.values()][0]?.resolution).toMatchObject({
    _tag: "TerminalRejected",
    error: { _tag: "FencingRejected" },
  });

  const currentOwner = await runHandler(handler, 1);

  expect(currentOwner).toMatchObject({ _tag: "Accepted" });
  expect(calls.map((call) => call.generation)).toEqual([0, 1]);
  expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
  expect(calls[0]?.workId).toBe(calls[1]?.workId);
  expect(receipts.size).toBe(2);
  expect(committedWorkEffects).toBe(1);
};

export const convergesPriorCommittedReceipt = async (): Promise<void> => {
  const receipts = new Map<
    string,
    {
      readonly commandId: CommandId;
      readonly resolution: {
        readonly _tag: string;
        readonly result: {
          readonly workId: WorkId;
          readonly workspaceId: WorkspaceId;
        };
      };
    }
  >();
  const calls: Array<{
    readonly commandId: string;
    readonly generation: number;
  }> = [];
  let committedWorkEffects = 0;
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
      const commandId = String(envelope.commandId);
      const generation = Number(
        (context as { readonly fencingGeneration: number }).fencingGeneration,
      );
      calls.push({ commandId, generation });
      const prior = receipts.get(commandId);
      if (prior !== undefined) return Effect.succeed(prior);
      committedWorkEffects += 1;
      const payload = envelope.payload as { readonly workId: WorkId };
      const committed = {
        commandId: envelope.commandId,
        resolution: {
          _tag: "Committed" as const,
          result: {
            workId: payload.workId,
            workspaceId,
            lifecycle: "Open",
            revision: 0,
          },
        },
      };
      receipts.set(commandId, committed);
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;
  const handler = makeHandler(gateway, receipts);

  expect(await runHandler(handler, 0)).toMatchObject({ _tag: "Accepted" });
  // The old owner crashed after the canonical Command committed but before
  // the AgentLoop action disposition was persisted; the action is Pending.
  expect(await runHandler(handler, 1)).toMatchObject({ _tag: "Accepted" });
  expect(calls.map((call) => call.generation)).toEqual([0]);
  expect(receipts.size).toBe(1);
  expect(committedWorkEffects).toBe(1);
};

export const failsClosedOnForeignWorkspaceReceipt = async (): Promise<void> => {
  const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
  const priorCommandId = parse(CommandId)(
    `cmd_${newUuid7("assign-work-command", occurrence)}`,
  );
  const workId = parse(WorkId)(`wrk_${newUuid7("assign-work", occurrence)}`);
  const wrongWorkspaceId = parse(WorkspaceId)(
    "ws_018f2b3c-4d5e-7abc-8def-0123456789a9",
  );
  const receipts = new Map<string, unknown>([
    [
      String(priorCommandId),
      {
        resolution: {
          _tag: "Committed",
          result: { workId, workspaceId: wrongWorkspaceId },
        },
      },
    ],
  ]);
  let gatewayCalls = 0;
  const gateway = {
    execute: () => {
      gatewayCalls += 1;
      return Effect.die("receipt mismatch must not submit another command");
    },
  } as unknown as CommandGatewayService;

  const result = await runHandler(makeHandler(gateway, receipts), 1);

  expect(result).toMatchObject({
    _tag: "Rejected",
    cause: { _tag: "AgentActionOperationalFailure" },
  });
  expect(gatewayCalls).toBe(0);
};

export const ignoresOlderDomainRejection = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const rejected = {
        resolution: {
          _tag: "TerminalRejected" as const,
          error: { _tag: "WorkspaceNotFound" as const },
        },
      };
      receipts.set(commandId, rejected);
      return Effect.succeed(rejected);
    },
  } as unknown as CommandGatewayService;
  const handler = makeHandler(gateway, receipts);

  expect(await runHandler(handler, 0)).toMatchObject({ _tag: "Rejected" });
  expect(await runHandler(handler, 1)).toMatchObject({ _tag: "Rejected" });
  expect(calls).toHaveLength(1);
};
