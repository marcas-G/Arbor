import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { runAttentionPollOnce } from "../src/attention-poll-loop.js";

const projectId = "prj_sandbox_poll" as never;
const now = "2026-10-19T10:00:00.000Z";
const claim = {
  projectId,
  attentionFactId: "att_sandbox_poll",
  workspaceId: "ws_sandbox_poll" as never,
  claimId: "claim-1",
  claimExpiresAt: "2026-10-19T10:00:30.000Z",
  attemptCount: 1,
  enqueuedAt: now,
};
const pollClaim = {
  projectId,
  leaseOwner: "attention-worker",
  leaseGeneration: 1,
  attemptSequence: 1,
  leaseExpiresAt: "2026-10-19T10:00:30.000Z",
};

describe("P50 sandbox unavailable Attention queue polling", () => {
  it("claims separately, consumes in the poll transaction, and commits the dispatcher lease", async () => {
    const trace: Array<string> = [];
    const tx = {
      transact: (body: Effect.Effect<unknown, unknown, TransactionScope>) =>
        Effect.suspend(() => {
          trace.push("transaction-start");
          const result = Effect.provideService(body, TransactionScope, {
            session: { id: "sandbox-poll-test" },
          });
          return Effect.ensuring(
            result,
            Effect.sync(() => trace.push("transaction-end")),
          );
        }),
    };
    const result = await Effect.runPromise(
      runAttentionPollOnce(
        "p10-rebuild:attention",
        {
          leaseOwner: "attention-worker",
          leaseTtlMs: 30_000,
          eventBatchSize: 20,
          queueBatchSize: 8,
          baseBackoffMs: 1_000,
          maxBackoffMs: 30_000,
          backoffExponentCap: 4,
        },
        {
          tx,
          clock: { now: () => Effect.succeed(now) },
          journal: {
            readAfterRaw: () => Effect.succeed([]),
            decodeRaw: () =>
              Effect.succeed({ _tag: "Poison", reason: "MalformedEnvelope" }),
          },
          offsets: {
            read: () => Effect.succeed(0),
            advance: () => Effect.void,
          },
          deadLetters: { quarantine: () => Effect.void },
          projectionForProject: () => ({ apply: () => Effect.void }),
          pollStore: {
            tryClaim: () =>
              Effect.succeed({ _tag: "Claimed", claim: pollClaim }),
            isCurrentClaim: () => Effect.succeed(true),
            completeSuccess: () => {
              trace.push("dispatcher-complete");
              return Effect.succeed(true);
            },
            recordFailure: () => Effect.succeed(true),
          },
          recoveryFacts: {
            findDeliverReplayFailureByEventId: () =>
              Effect.succeed(Option.none()),
            listPendingDeliverReplayAttention: () => Effect.succeed([]),
            acknowledgePendingDeliverReplayAttention: () => Effect.void,
          },
          attentionRows: { putDeliverReplayFailure: () => Effect.void },
          sandboxUnavailableQueue: {
            claimBatch: () => {
              trace.push("sandbox-claim");
              return Effect.succeed([claim]);
            },
            consume: ({
              claim: consumed,
            }: {
              readonly claim: typeof claim;
            }) => {
              trace.push(`sandbox-consume:${consumed.claimId}`);
              return Effect.succeed(undefined);
            },
            rearm: () => Effect.void,
          },
        },
      ),
    );

    expect(result).toMatchObject({ applied: 0, quarantined: 0 });
    expect(trace.filter((item) => item === "transaction-start")).toHaveLength(
      3,
    );
    expect(trace.indexOf("sandbox-claim")).toBeGreaterThan(-1);
    expect(trace.indexOf("sandbox-consume:claim-1")).toBeGreaterThan(
      trace.indexOf("sandbox-claim"),
    );
    expect(trace.indexOf("sandbox-consume:claim-1")).toBeLessThan(
      trace.indexOf("dispatcher-complete"),
    );
  });
});
