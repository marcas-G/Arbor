import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { runAttentionPollOnce } from "../src/attention-poll-loop.js";

const projectId = "prj_attention_poll" as never;
const fact = {
  attentionFactId: "att_attention_poll",
  eventId: "evt_attention_poll",
  projectId,
  executionId: "exe_attention_poll",
  targetWorkspaceId: "ws_attention_poll",
  logicalActionId: "act_attention_poll",
  messageId: "msg_attention_poll",
  failureCode: "LegacyMessageMissingEvent",
  firstDetectedAt: "2026-10-11T00:00:00.000Z",
} as const;
const candidate = {
  eventIdRaw: fact.eventId,
  projectIdRaw: projectId,
  sequenceRaw: 1,
  eventTypeRaw: "DeliverReplayEscalated",
  eventVersionRaw: 1,
  occurredAtRaw: fact.firstDetectedAt,
  aggregateRefRaw: fact.targetWorkspaceId,
  actorRaw: "system:recovery",
  causedByCommandIdRaw: null,
  causedByEventIdRaw: null,
  correlationRefRaw: fact.logicalActionId,
  payloadJsonRaw: JSON.stringify({
    attentionFactId: fact.attentionFactId,
    executionId: fact.executionId,
    targetWorkspaceId: fact.targetWorkspaceId,
    logicalActionId: fact.logicalActionId,
    messageId: fact.messageId,
    failureCode: fact.failureCode,
  }),
};
const decodedEvent = {
  eventId: fact.eventId,
  projectId,
  sequence: 1,
  eventType: "DeliverReplayEscalated",
  eventVersion: 1,
  occurredAt: fact.firstDetectedAt,
  aggregateRef: fact.targetWorkspaceId,
  actor: "system:recovery",
  correlationRef: fact.logicalActionId,
  payload: JSON.parse(candidate.payloadJsonRaw),
} as never;
const claim = {
  projectId,
  leaseOwner: "poll-daemon-1",
  leaseGeneration: 3,
  attemptSequence: 8,
  leaseExpiresAt: "2026-10-11T00:00:30.000Z",
};
const policy = {
  leaseOwner: claim.leaseOwner,
  leaseTtlMs: 30_000,
  eventBatchSize: 50,
  queueBatchSize: 64,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffExponentCap: 6,
};

const makeDeps = (
  trace: Array<string>,
  overrides: Record<string, unknown> = {},
) => {
  const markerIds = new Set<string>();
  const tx = {
    transact: (body: Effect.Effect<unknown, unknown, TransactionScope>) =>
      Effect.suspend(() => {
        trace.push("transaction");
        return Effect.provideService(body, TransactionScope, {
          session: { id: "test" },
        });
      }),
  };
  const deps = {
    tx,
    clock: { now: () => Effect.succeed("2026-10-11T00:00:01.000Z") },
    pollStore: {
      tryClaim: () => Effect.succeed({ _tag: "Claimed", claim }),
      isCurrentClaim: () => Effect.succeed(true),
      completeSuccess: () => {
        trace.push("complete-success");
        return Effect.succeed(true);
      },
      recordFailure: (_claim: unknown, code: string) => {
        trace.push(`record-failure:${code}`);
        return Effect.succeed(true);
      },
    },
    journal: {
      readAfterRaw: () => {
        trace.push("read-raw");
        return Effect.succeed([candidate]);
      },
      decodeRaw: () => {
        trace.push("decode-raw");
        return Effect.succeed({ _tag: "Decoded", event: decodedEvent });
      },
    },
    offsets: {
      read: () =>
        Effect.sync(() => {
          trace.push("read-offset");
          return 0;
        }),
      advance: (_consumerId: string, _projectId: unknown, sequence: number) => {
        trace.push(`advance:${sequence}`);
        return Effect.void;
      },
    },
    deadLetters: {
      quarantine: () => {
        trace.push("dead-letter");
        return Effect.void;
      },
    },
    recoveryFacts: {
      findDeliverReplayFailureByEventId: () => {
        trace.push("lookup-fact");
        return Effect.succeed(Option.some(fact));
      },
      listPendingDeliverReplayAttention: () => {
        trace.push("list-pending");
        return Effect.succeed([fact]);
      },
      acknowledgePendingDeliverReplayAttention: () => {
        trace.push("ack-queue");
        return markerIds.has(fact.attentionFactId)
          ? Effect.void
          : Effect.die("ACK attempted before marker");
      },
    },
    attentionRows: {
      putDeliverReplayFailure: () => {
        trace.push("put-marker");
        markerIds.add(fact.attentionFactId);
        return Effect.void;
      },
    },
    projectionForProject: () => ({
      apply: (events: ReadonlyArray<unknown>) => {
        trace.push(`apply:${events.length}`);
        return Effect.void;
      },
    }),
  };
  return { ...deps, ...overrides } as never;
};

describe("P37 P10 Attention poll coordinator", () => {
  it("uses raw event identity first and commits projection, queue ACK, offset and claim together", async () => {
    const trace: Array<string> = [];
    await Effect.runPromise(
      runAttentionPollOnce("p10-rebuild:attention", policy, makeDeps(trace)),
    );

    expect(trace.indexOf("read-raw")).toBeLessThan(
      trace.indexOf("lookup-fact"),
    );
    expect(trace.indexOf("lookup-fact")).toBeLessThan(
      trace.indexOf("decode-raw"),
    );
    expect(trace.indexOf("put-marker")).toBeLessThan(
      trace.indexOf("ack-queue"),
    );
    expect(trace.indexOf("ack-queue")).toBeLessThan(trace.indexOf("advance:1"));
    expect(trace.indexOf("advance:1")).toBeLessThan(
      trace.indexOf("complete-success"),
    );
    expect(trace.filter((entry) => entry === "transaction")).toHaveLength(2);
  });

  it("emits the Deliver Attention post-commit qualification boundary after marker, ACK, offset and claim settlement", async () => {
    const trace: Array<string> = [];
    await Effect.runPromise(
      runAttentionPollOnce(
        "p10-rebuild:attention",
        policy,
        makeDeps(trace, {
          qualificationProbe: (event: {
            readonly boundary: string;
            readonly projectId: unknown;
            readonly attentionFactId: string;
          }) => {
            trace.push(
              `probe:${event.boundary}:${event.projectId}:${event.attentionFactId}`,
            );
            return Promise.resolve();
          },
        }),
      ),
    );

    const committed = trace.indexOf("complete-success");
    const probe = trace.findIndex((entry) => entry.startsWith("probe:"));
    expect(trace.indexOf("put-marker")).toBeLessThan(probe);
    expect(trace.indexOf("ack-queue")).toBeLessThan(probe);
    expect(trace.indexOf("advance:1")).toBeLessThan(probe);
    expect(committed).toBeLessThan(probe);
    expect(trace[probe]).toBe(
      `probe:P10AfterDeliverAttentionConsumerCommit:${projectId}:${fact.attentionFactId}`,
    );
  });

  it("fails closed on an exact Deliver type without its P9 fact before decoding or advancing", async () => {
    const trace: Array<string> = [];
    const deps = makeDeps(trace, {
      recoveryFacts: {
        findDeliverReplayFailureByEventId: () => {
          trace.push("lookup-fact");
          return Effect.succeed(Option.none());
        },
        listPendingDeliverReplayAttention: () => Effect.succeed([]),
        acknowledgePendingDeliverReplayAttention: () => Effect.void,
      },
      journal: {
        readAfterRaw: () => {
          trace.push("read-raw");
          return Effect.succeed([{ ...candidate, payloadJsonRaw: "not-json" }]);
        },
        decodeRaw: () => {
          trace.push("decode-raw");
          return Effect.die(
            "Deliver payload must not be decoded before P9 lookup",
          );
        },
      },
    });

    await Effect.runPromise(
      runAttentionPollOnce("p10-rebuild:attention", policy, deps),
    );
    expect(trace).toContain("record-failure:MissingP9Fact");
    expect(trace).not.toContain("decode-raw");
    expect(trace).not.toContain("advance:1");
    expect(trace).not.toContain("complete-success");
  });
});
