import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import type { ClockService } from "@arbor/ports";
import { Effect } from "effect";
import { expect } from "vitest";
import { produceDeliverableHandler } from "../../src/control-actions.js";
import {
  commandHandlerRegistry,
  execution,
  generationContext,
  invocation,
  receiptLookup,
  transaction,
} from "./support.js";

export const produceNewCommandIdAfterFenceRejection =
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
                result: {
                  deliverableId: (
                    envelope.payload as { readonly deliverableId: string }
                  ).deliverableId,
                  sourceWorkId: (
                    envelope.payload as { readonly sourceWorkId: string }
                  ).sourceWorkId,
                  sourceWorkRevision: (
                    envelope.payload as {
                      readonly observedSourceWorkRevision: number;
                    }
                  ).observedSourceWorkRevision,
                  kind: (envelope.payload as { readonly kind: string }).kind,
                  artifactRoles: [],
                },
              };
        const rejected = {
          resolution: {
            ...resolution,
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = produceDeliverableHandler({
      gateway,
      commandHandlerRegistry,
      tx: transaction,
      commandReceipts: receiptLookup(receipts),
      clock: {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      } as ClockService,
    });
    const produceAction = {
      _tag: "ProduceDeliverable" as const,
      kind: "Report",
      artifacts: [],
    };
    const run = (generation: number) =>
      Effect.runPromise(
        Effect.match(
          handler.handle({
            action: produceAction,
            invocation,
            execution,
            context: generationContext(generation),
          } as AgentActionHandlerInput),
          {
            onFailure: (cause) => ({ _tag: "Rejected" as const, cause }),
            onSuccess: (outcome) => ({ _tag: "Accepted" as const, outcome }),
          },
        ),
      );

    expect((await run(0))._tag).toBe("Rejected");
    expect((await run(1))._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
  };

export const produceConvergesOlderCommittedReceipt =
  async (): Promise<void> => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly deliverableId: string;
          readonly sourceWorkId: string;
          readonly observedSourceWorkRevision: number;
          readonly kind: string;
        };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              deliverableId: payload.deliverableId,
              sourceWorkId: payload.sourceWorkId,
              sourceWorkRevision: payload.observedSourceWorkRevision,
              kind: payload.kind,
              artifactRoles: [],
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = produceDeliverableHandler({
      gateway,
      commandHandlerRegistry,
      tx: transaction,
      commandReceipts: receiptLookup(receipts),
      clock: {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      } as ClockService,
    });
    const produceAction = {
      _tag: "ProduceDeliverable" as const,
      kind: "Report",
      artifacts: [],
    };
    const run = (generation: number) =>
      Effect.runPromise(
        Effect.match(
          handler.handle({
            action: produceAction,
            invocation,
            execution,
            context: generationContext(generation),
          } as AgentActionHandlerInput),
          {
            onFailure: (cause) => ({ _tag: "Rejected" as const, cause }),
            onSuccess: (outcome) => ({ _tag: "Accepted" as const, outcome }),
          },
        ),
      );

    expect(await run(0)).toMatchObject({ _tag: "Accepted" });
    expect(await run(1)).toMatchObject({ _tag: "Accepted" });
    expect(calls).toHaveLength(1);
  };
