import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeSingleWorkspaceControlActionHandlers } from "../apps/single-workspace/src/control-actions.js";
import type { CommandGatewayService } from "../packages/application/src/index.js";
import {
  DeliverableId,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const senderWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const deliverableId = parse(DeliverableId)(
  "del_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const recipientWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const sourceWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789b2";
const principal = parse(Principal)("user:governor");

describe("Deliver control Gateway route", () => {
  it("uses DeliverMessage/1, keeps MessageId stable, and scopes CommandId to generation", async () => {
    const calls: Array<{
      readonly commandType: string;
      readonly commandId: string;
      readonly payload: Record<string, unknown>;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (
        envelope: {
          readonly commandType: string;
          readonly commandId: string;
          readonly payload: Record<string, unknown>;
        },
        context: { readonly fencingGeneration?: number },
      ) => {
        calls.push({
          commandType: envelope.commandType,
          commandId: envelope.commandId,
          payload: envelope.payload,
          generation: context.fencingGeneration ?? -1,
        });
        return Effect.succeed({
          commandId: envelope.commandId,
          projectId,
          semanticRequestFingerprint: "a".repeat(64),
          schemaVersion: "1",
          fingerprintAlgorithmVersion: 1,
          resolution: {
            _tag: "Committed",
            result: {
              messageId: envelope.payload.messageId,
              deliverableId: envelope.payload.deliverableId,
              senderWorkspaceId: envelope.payload.senderWorkspaceId,
              recipientWorkspaceId,
              admitted: true,
            },
          },
          createdAt: "t",
          settledAt: "t",
        });
      },
    } as unknown as CommandGatewayService;
    const handler = makeSingleWorkspaceControlActionHandlers({
      gateway,
      blobs: {} as never,
      deliverables: {
        findById: () =>
          Effect.succeed(Option.some({ deliverableId, sourceWorkId })),
      },
      works: {
        findById: () =>
          Effect.succeed(
            Option.some({
              workId: sourceWorkId,
              projectId,
              workspaceId: senderWorkspaceId,
            }),
          ),
      },
      workspaces: {
        findById: () =>
          Effect.succeed(
            Option.some({
              workspaceId: senderWorkspaceId,
              projectId,
              parentWorkspaceId: recipientWorkspaceId,
            }),
          ),
      },
      messages: { findById: () => Effect.succeed(Option.none()) },
      inbox: {
        admitUpsert: () => Effect.void,
        findByKey: () => Effect.succeed(Option.none()),
      },
      journal: { readAfter: () => Effect.succeed([]) },
      commandHandlerRegistry: {
        lookup: () =>
          Option.some({ commandType: "DeliverMessage", schemaVersion: "1" }),
      },
      commandReceipts: {
        findResolution: () => Effect.succeed(Option.none()),
        hasRetryableAttempt: () => Effect.succeed(false),
      },
      replayAttention: {
        findDeliverReplayFailure: () => Effect.succeed(Option.none()),
      },
      clock: { now: () => Effect.succeed("t") },
      tx: {
        transact: (effect: Effect.Effect<unknown, unknown, never>) => effect,
      },
      ids: {} as never,
      proposals: {} as never,
    } as never).find((candidate) => candidate.action === "Deliver");
    if (handler === undefined) {
      throw new Error("production control action registry omitted Deliver");
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        for (const generation of [0, 1]) {
          yield* handler.handle({
            action: {
              _tag: "Deliver",
              deliverableId,
              summary: "bounded delivery summary",
            },
            invocation: {
              providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
              outputPosition: 0,
            },
            execution: {
              executionId,
              projectId,
              workspaceId: senderWorkspaceId,
            },
            logicalActionId: "act_018f2b3c-4d5e-7abc-8def-0123456789e2",
            context: {
              _tag: "ExecutionOrigin",
              principal,
              executionId,
              fencingGeneration: parse(LeaseGeneration)(generation),
            },
          } as never);
        }
      }),
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.commandType)).toEqual([
      "DeliverMessage",
      "DeliverMessage",
    ]);
    expect(calls[0]?.payload.messageId).toBe(calls[1]?.payload.messageId);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
  });
});
