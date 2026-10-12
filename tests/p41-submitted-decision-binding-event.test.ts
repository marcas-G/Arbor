import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { recordSubmittedDecisionBindingFailure } from "../packages/execution-runtime/src/submitted-decision-binding-failure.js";
import {
  DomainEventJournal,
  IdGenerator,
  type PendingDomainEvent,
  type RecoveryAttentionFactStoreService,
  TransactionScope,
} from "../packages/ports/src/index.js";

describe("P41 Submitted Decision binding event and immutable fact", () => {
  it("appends one exact event and reuses its P9 fact across retries", async () => {
    const facts = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    const factsStore: RecoveryAttentionFactStoreService = {
      findSubmittedDecisionBindingFailure: (attentionFactId: string) =>
        Effect.succeed(
          facts.has(attentionFactId)
            ? Option.some(facts.get(attentionFactId) as never)
            : Option.none(),
        ),
      recordSubmittedDecisionBindingFailure: (fact: {
        readonly attentionFactId: string;
        readonly eventId: string;
      }) => {
        facts.set(String(fact.attentionFactId), fact as never);
        return Effect.succeed(fact as never);
      },
    } as never;
    const layer = Layer.mergeAll(
      Layer.succeed(DomainEventJournal, {
        appendReturningIds: (drafts: ReadonlyArray<PendingDomainEvent>) => {
          events.push(
            ...(drafts as unknown as ReadonlyArray<Record<string, unknown>>),
          );
          return Effect.succeed([
            "evt_01900000-0000-7000-8000-000000000001",
          ] as never);
        },
      } as never),
      Layer.succeed(IdGenerator, {
        generate: () =>
          Effect.succeed("evt_01900000-0000-7000-8000-000000000001" as never),
      }),
    );
    const input = {
      projectId: "prj_01900000-0000-7000-8000-000000000001" as never,
      executionId: "exe_01900000-0000-7000-8000-000000000001" as never,
      workspaceId: "ws_01900000-0000-7000-8000-000000000001" as never,
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: "ptn_01900000-0000-7000-8000-000000000001" as never,
      logicalActionId: "lac_p41_selection",
      failureCode: "DecisionRequestWorkspaceMismatch" as const,
      firstDetectedAt: "2026-10-12T01:00:00.000Z",
      causedByCommandId: null,
    };
    const run = (firstDetectedAt: string) =>
      Effect.runPromise(
        Effect.provideService(
          Effect.provide(
            recordSubmittedDecisionBindingFailure(factsStore, {
              ...input,
              firstDetectedAt,
            }),
            layer,
          ),
          TransactionScope,
          { session: { id: "p41-test" } },
        ),
      );

    const first = await run(input.firstDetectedAt);
    const retry = await run("2026-10-12T01:01:00.000Z");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      projectId: input.projectId,
      eventType: "SubmittedDecisionBindingEscalated",
      eventVersion: 1,
      occurredAt: input.firstDetectedAt,
      aggregateRef: input.workspaceId,
      correlationRef: input.logicalActionId,
      payload: {
        attentionFactId: first?.attentionFactId,
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        logicalStepNo: input.logicalStepNo,
        repairAttempt: input.repairAttempt,
        providerTurnId: input.providerTurnId,
        logicalActionId: input.logicalActionId,
        failureCode: input.failureCode,
      },
    });
    expect(first).toMatchObject({
      attentionFactId: expect.stringMatching(/^att_[0-9a-f]{64}$/u),
      eventId: "evt_01900000-0000-7000-8000-000000000001",
      firstDetectedAt: input.firstDetectedAt,
    });
    expect(retry).toEqual(first);
  });
});
