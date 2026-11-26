import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import { parse, WorkRevision } from "@arbor/domain";
import { Effect, Option } from "effect";
import { expect } from "vitest";
import {
  acceptAction,
  acceptanceWorkId,
  acceptInvocation,
  actionHandlerFromRegistry,
  childWorkspaceId,
  runControlHandler,
  verificationId,
} from "./support.js";

export const acceptUsesNewCommandIdAfterFencingRejected =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
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
        const resolution =
          generation === 0
            ? {
                _tag: "TerminalRejected" as const,
                error: { _tag: "FencingRejected" as const },
              }
            : {
                _tag: "Committed" as const,
                result: envelope.payload,
              };
        const receipt = { resolution };
        receipts.set(commandId, receipt);
        return Effect.succeed(receipt);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    const currentOwner = await runControlHandler(
      handler,
      acceptAction,
      1,
      acceptInvocation,
    );
    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "accept-child-result-command",
        `${acceptInvocation.providerTurnId}:${acceptInvocation.outputPosition}`,
      )}`,
    );
  };

export const acceptConvergesPriorCommittedAcceptance =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const acceptanceRows = new Map<string, unknown>();
    const calls: string[] = [];
    let resolved = true;
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: envelope.payload,
          },
        };
        const result = envelope.payload as {
          readonly acceptanceId: string;
          readonly workId: string;
          readonly targetWorkRevision: number;
          readonly verificationId: string;
        };
        acceptanceRows.set(`${result.workId}:${result.targetWorkRevision}`, {
          ...result,
          actor: "worker:ah10",
          acceptedAt: "2026-10-05T00:00:00.000Z",
        });
        receipts.set(commandId, committed);
        resolved = false;
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
      new Map(),
      () =>
        resolved
          ? Option.some({
              childWorkspaceId,
              workId: acceptanceWorkId,
              workRevision: parse(WorkRevision)(0),
              verificationId,
            })
          : Option.none(),
      acceptanceRows,
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    const converged = await runControlHandler(
      handler,
      acceptAction,
      1,
      acceptInvocation,
    );

    expect(converged).toMatchObject({
      _tag: "Accepted",
      outcome: { _tag: "Observation" },
    });
    expect(calls).toHaveLength(1);
  };

export const acceptFailsClosedWithoutCanonicalRow = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  let resolved = true;
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const committed = {
        resolution: {
          _tag: "Committed" as const,
          result: envelope.payload,
        },
      };
      receipts.set(commandId, committed);
      resolved = false;
      return Effect.succeed(committed);
    },
  } as unknown as CommandGatewayService;
  const handler = actionHandlerFromRegistry(
    "AcceptResult",
    gateway,
    receipts,
    new Map(),
    () =>
      resolved
        ? Option.some({
            childWorkspaceId,
            workId: acceptanceWorkId,
            workRevision: parse(WorkRevision)(0),
            verificationId,
          })
        : Option.none(),
    new Map(),
  );

  await runControlHandler(handler, acceptAction, 0, acceptInvocation);
  const takeover = await runControlHandler(
    handler,
    acceptAction,
    1,
    acceptInvocation,
  );

  expect(takeover._tag).toBe("Rejected");
  expect(calls).toHaveLength(1);
};

export const acceptDoesNotRetryOlderRejection = async (): Promise<void> => {
  const receipts = new Map<string, unknown>();
  const calls: string[] = [];
  const gateway = {
    execute: (envelope: GatewayEnvelope<unknown>) => {
      const commandId = String(envelope.commandId);
      calls.push(commandId);
      const rejected = {
        resolution: {
          _tag: "TerminalRejected" as const,
          error: { _tag: "VerificationAcceptanceMismatch" as const },
        },
      };
      receipts.set(commandId, rejected);
      return Effect.succeed(rejected);
    },
  } as unknown as CommandGatewayService;
  const handler = actionHandlerFromRegistry("AcceptResult", gateway, receipts);

  await runControlHandler(handler, acceptAction, 0, acceptInvocation);
  await runControlHandler(handler, acceptAction, 1, acceptInvocation);

  expect(calls).toHaveLength(1);
};
