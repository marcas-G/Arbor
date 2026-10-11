import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  newUuid7,
} from "@arbor/application";
import { type MessageId, messageEntryKey } from "@arbor/domain";
import {
  type DeliverReplayAttentionFact,
  type RecordDeliverReplayFailureInput,
  type RecoveryAttentionFactStoreService,
  sha256Hex,
} from "@arbor/ports";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { deliverMessageGatewayHandler } from "../src/control-actions.js";

const providerTurnId = "ptn_deliver-recovery-test";
const outputPosition = 0;
const logicalActionId = "la_deliver-recovery-test";
const occurrence = `${providerTurnId}:${outputPosition}`;
const messageId = `msg_${newUuid7("deliver-message", occurrence)}` as MessageId;
const executionId = "exe_deliver-recovery-test";
const projectId = "prj_deliver-recovery-test";
const senderWorkspaceId = "ws_deliver-child";
const recipientWorkspaceId = "ws_deliver-parent";
const deliverableId = "del_deliver-recovery-test";
const summary = "The child result is ready.";

const input = (generation: number): AgentActionHandlerInput =>
  ({
    action: { _tag: "Deliver", deliverableId, summary },
    invocation: {
      providerTurnId,
      outputPosition,
      callRef: "call_deliver-recovery-test",
      toolName: "deliver",
      argumentsJson: "{}",
    },
    execution: {
      executionId,
      projectId,
      workspaceId: senderWorkspaceId,
      sessionId: "ses_deliver-recovery-test",
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId: senderWorkspaceId,
        episode: {
          _tag: "WorkEpisode",
          workId: "wrk_deliver-recovery-test",
          targetWorkRevision: 0,
        },
      },
      admittedAt: "2026-10-11T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    },
    context: {
      _tag: "ExecutionOrigin",
      principal: "agent:deliver-test",
      executionId,
      fencingGeneration: generation,
    },
    logicalActionId,
  }) as AgentActionHandlerInput;

const legacyCommandId = `cmd_${newUuid7("deliver-command", occurrence)}`;
const sentAt = "2026-10-11T00:00:01.000Z";
const legacyMessage = {
  messageId,
  senderWorkspaceId,
  sentAt,
  message: {
    kind: "Deliver",
    recipientWorkspaceId,
    deliverableId,
    bodyRef: summary,
    urgency: "Normal",
  },
};
const legacyEvent = {
  eventId: "evt_deliver-legacy" as never,
  projectId: projectId as never,
  sequence: 1 as never,
  eventType: "MessageSent" as const,
  eventVersion: 1,
  occurredAt: sentAt,
  aggregateRef: messageId,
  actor: "agent:deliver-test" as never,
  causedByCommandId: legacyCommandId as never,
  payload: {
    messageId,
    kind: "Deliver",
    sender: senderWorkspaceId,
    recipient: recipientWorkspaceId,
    deliverableId,
    correlationId: null,
    causationId: null,
  },
};
const legacyInbox = {
  recipientWorkspaceId,
  entryKey: messageEntryKey(messageId),
  kind: "Message",
  summary: `Deliver ${deliverableId} from ${senderWorkspaceId}`,
  admittedAt: sentAt,
};

const baseDependencies = (options: {
  readonly priorFact?: DeliverReplayAttentionFact;
  readonly existingEffect?: boolean;
}) => {
  let gatewayCalls = 0;
  let failureWrites = 0;
  let effectReads = 0;
  const failureCodes: Array<string> = [];
  const factLookups: Array<string> = [];
  const replayAttention = {
    findDeliverReplayFailure: (attentionFactId: string) => {
      factLookups.push(attentionFactId);
      return Effect.succeed(
        options.priorFact === undefined
          ? Option.none()
          : Option.some(options.priorFact),
      );
    },
    recordDeliverReplayFailure: (fact: RecordDeliverReplayFailureInput) => {
      failureWrites += 1;
      failureCodes.push(fact.failureCode);
      return Effect.succeed({
        attentionFactId: "att_deliver-replay-test",
        eventId: "evt_deliver-replay-test",
        projectId: fact.projectId,
        executionId: fact.executionId,
        targetWorkspaceId: fact.targetWorkspaceId,
        logicalActionId: fact.logicalActionId,
        messageId: fact.messageId,
        failureCode: fact.failureCode,
        firstDetectedAt: fact.firstDetectedAt,
      });
    },
  } as unknown as Pick<
    RecoveryAttentionFactStoreService,
    "findDeliverReplayFailure" | "recordDeliverReplayFailure"
  >;
  const dependencies = {
    gateway: {
      execute: () => {
        gatewayCalls += 1;
        return Effect.die(new Error("unexpected Gateway execution"));
      },
    } as unknown as CommandGatewayService,
    commandHandlerRegistry: {
      lookup: () =>
        Option.some({ commandType: "DeliverMessage", schemaVersion: "1" }),
    } as unknown as CommandHandlerRegistryService,
    commandReceipts: {
      findResolution: () => Effect.succeed(Option.none()),
      hasRetryableAttempt: () => Effect.succeed(false),
    },
    deliverables: {
      findById: () =>
        Effect.succeed(
          Option.some({
            deliverableId,
            sourceWorkId: "wrk_deliver-recovery-test",
          }),
        ),
    },
    works: {
      findById: () =>
        Effect.succeed(
          Option.some({
            workId: "wrk_deliver-recovery-test",
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
    messages: {
      findById: () => {
        effectReads += 1;
        return Effect.succeed(
          options.existingEffect ? Option.some(legacyMessage) : Option.none(),
        );
      },
    },
    inbox: {
      admitUpsert: () => Effect.void,
      findByKey: () =>
        Effect.succeed(
          options.existingEffect ? Option.some(legacyInbox) : Option.none(),
        ),
    },
    journal: {
      readAfter: () =>
        Effect.succeed(options.existingEffect ? [legacyEvent] : []),
    },
    replayAttention,
    clock: { now: () => Effect.succeed("2026-10-11T00:00:02.000Z") },
    tx: {
      transact: (effect: Effect.Effect<unknown, unknown, never>) => effect,
    },
    ids: {},
  };
  return {
    dependencies,
    counts: () => ({
      gatewayCalls,
      failureWrites,
      failureCodes,
      factLookups,
      effectReads,
    }),
  };
};

describe("P37 Deliver receipt recovery", () => {
  it("does not adopt gen0 direct-write evidence from a later lease generation", async () => {
    const fixture = baseDependencies({ existingEffect: true });
    const handler = deliverMessageGatewayHandler(fixture.dependencies as never);
    const exit = await Effect.runPromiseExit(handler.handle(input(1)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("AgentActionRecoveryBlocked");
      }
    }
    expect(fixture.counts()).toMatchObject({
      gatewayCalls: 0,
      failureWrites: 1,
      failureCodes: ["PriorReceiptEffectConflict"],
    });
  });

  it("stays blocked by an existing failure fact before re-reading drifted effects", async () => {
    const fact: DeliverReplayAttentionFact = {
      attentionFactId: `att_${sha256Hex(
        JSON.stringify({ version: 1, executionId, logicalActionId, messageId }),
      )}`,
      eventId: "evt_original",
      projectId: projectId as never,
      executionId: executionId as never,
      targetWorkspaceId: senderWorkspaceId as never,
      logicalActionId,
      messageId,
      failureCode: "PriorReceiptEffectConflict",
      firstDetectedAt: "2026-10-11T00:00:02.000Z",
    };
    const fixture = baseDependencies({
      priorFact: fact,
      existingEffect: false,
    });
    const handler = deliverMessageGatewayHandler(fixture.dependencies as never);
    const exit = await Effect.runPromiseExit(handler.handle(input(1)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("AgentActionRecoveryBlocked");
      }
    }
    expect(fixture.counts()).toMatchObject({
      gatewayCalls: 0,
      failureWrites: 0,
      effectReads: 0,
    });
    expect(fixture.counts().factLookups).toEqual([fact.attentionFactId]);
  });
});
