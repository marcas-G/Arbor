import type {
  DomainEvent,
  ProjectId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  pollOnce,
  workflowSignalAtomicConsumerHandler,
} from "../src/consumer-loop.js";
import { applyBlockedWorkEpisodeAtomically } from "../src/workflow-signal-consumer.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as ProjectId;
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkspaceId;
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkId;
const event = {
  eventId: "evt_blocked",
  projectId,
  sequence: 1,
  eventType: "ExecutionSettled",
  eventVersion: 1,
  occurredAt: "2026-10-12T00:00:00.000Z",
  aggregateRef: "exe_blocked",
  actor: "runtime:test",
  causedByCommandId: null,
  causedByEventId: null,
  correlationRef: null,
  payload: {
    executionId: "exe_blocked",
    settlement: {
      _tag: "Completed",
      result: {
        _tag: "Blocked",
        workId,
        targetWorkRevision: 0,
        blockerId: "a".repeat(64),
        waitFor: {
          mode: "Any",
          conditions: [
            { _tag: "Manual" },
            { _tag: "InboxAdvanced", workspaceId, observedSequence: 0 },
          ],
        },
        request: "need a resource boundary update",
        failedActionRefs: [{ executionId: "exe_blocked" }],
      },
    },
  },
} as unknown as DomainEvent<unknown>;

describe("P6 WorkBlocked atomic consumer apply", () => {
  it("uses the sequenced Parent Inbox API and releases only advanced bound waits", async () => {
    const parentWorkspaceId =
      "ws_118f2b3c-4d5e-7abc-8def-0123456789a1" as WorkspaceId;
    const parentWorkId = "wrk_118f2b3c-4d5e-7abc-8def-0123456789a1" as WorkId;
    const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1";
    const blockerId = "a".repeat(64);
    const blocked = {
      _tag: "Completed",
      result: {
        _tag: "Blocked",
        workId,
        targetWorkRevision: 0,
        blockerId,
        waitFor: {
          mode: "Any",
          conditions: [
            { _tag: "Manual" },
            { _tag: "InboxAdvanced", workspaceId, observedSequence: 1 },
          ],
        },
        request: "need a resource boundary update",
        failedActionRefs: [{ executionId }],
      },
    };
    const execution = {
      executionId,
      projectId,
      workspaceId,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        episode: { _tag: "WorkEpisode", workId, targetWorkRevision: 0 },
      },
      state: { status: "Settled", settlement: blocked },
    };
    const works = [
      { workId, workspaceId, projectId, lifecycle: "Open", revision: 0 },
      {
        workId: parentWorkId,
        workspaceId: parentWorkspaceId,
        projectId,
        lifecycle: "Open",
        revision: 0,
      },
    ];
    const waits = new Map([
      [
        workId,
        {
          workId,
          waitSpec: {
            mode: "Any",
            conditions: blocked.result.waitFor.conditions,
          },
          registeredAt: "t0",
          updatedAt: "t0",
        },
      ],
      [
        parentWorkId,
        {
          workId: parentWorkId,
          waitSpec: {
            mode: "Any",
            conditions: [
              { _tag: "Manual" },
              {
                _tag: "InboxAdvanced",
                workspaceId: parentWorkspaceId,
                observedSequence: 0,
              },
            ],
          },
          registeredAt: "t0",
          updatedAt: "t0",
        },
      ],
    ]);
    const admitted: Array<Record<string, unknown>> = [];
    const cleared: WorkId[] = [];
    const reeval: WorkspaceId[] = [];
    let parentSequence = 0;
    const deps = {
      tx: { transact: (effect: Effect.Effect<unknown>) => effect },
      waits: {
        findByWork: (id: WorkId) =>
          Effect.succeed(
            waits.has(id) ? Option.some(waits.get(id) as never) : Option.none(),
          ),
        clear: (id: WorkId) => {
          waits.delete(id);
          cleared.push(id);
          return Effect.void;
        },
        listActive: () => Effect.succeed([...waits.values()] as never),
      },
      works: {
        findById: (id: WorkId) => {
          const found = works.find((candidate) => candidate.workId === id);
          return Effect.succeed(
            found === undefined ? Option.none() : Option.some(found as never),
          );
        },
        listByWorkspace: (id: WorkspaceId) =>
          Effect.succeed(
            works.filter((candidate) => candidate.workspaceId === id) as never,
          ),
      },
      workspaces: {
        findById: (id: WorkspaceId) =>
          Effect.succeed(
            Option.some({
              workspaceId: id,
              projectId,
              parentWorkspaceId: id === workspaceId ? parentWorkspaceId : null,
            } as never),
          ),
      },
      scheduler: {
        reevaluate: (id: WorkspaceId) => {
          reeval.push(id);
          return Effect.succeed({ _tag: "Idle" as const });
        },
      },
      dependencies: { findById: () => Effect.succeed(Option.none()) },
      messages: { findById: () => Effect.succeed(Option.none()) },
      executions: {
        findById: () => Effect.succeed(Option.some(execution as never)),
      },
      inbox: {
        admitUpsert: () => Effect.void,
        admitUpsertSequenced: (entry: Record<string, unknown>) => {
          admitted.push(entry);
          parentSequence += 1;
          return Effect.void;
        },
        currentSequence: (id: WorkspaceId) =>
          Effect.succeed(id === workspaceId ? 2 : parentSequence),
        listUnconsumed: () => Effect.succeed([]),
        findByKey: () => Effect.succeed(Option.none()),
        markConsumed: () => Effect.void,
        countByKey: () => Effect.succeed(0),
      },
      blockers: {
        findById: () =>
          Effect.succeed(
            Option.some({
              blockerId,
              projectId,
              workspaceId,
              workId,
              targetWorkRevision: 0,
              state: "Open",
              openCycleId: executionId,
            } as never),
          ),
      },
    };
    const result = await Effect.runPromise(
      applyBlockedWorkEpisodeAtomically(
        {
          eventId: "evt_blocked",
          eventType: "ExecutionSettled",
          occurredAt: "2026-10-12T00:00:00.000Z",
          payload: { executionId, settlement: blocked },
        },
        deps as never,
      ).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "blocked-parent-atomic" },
        }),
      ),
    );
    expect(result).toMatchObject({
      record: `Delivered:WorkBlocked:${parentWorkspaceId}`,
    });
    expect(admitted).toMatchObject([
      {
        entryKey: executionId,
        kind: "WorkBlocked",
        correlationId: blockerId,
      },
    ]);
    expect(cleared).toEqual([workId, parentWorkId]);
    if (result.afterCommit === undefined)
      throw new Error("missing post-commit wake");
    await Effect.runPromise(result.afterCommit);
    expect(reeval).toEqual([parentWorkspaceId, workspaceId]);
  });

  it("commits Parent Inbox apply and consumer offset in one transaction", async () => {
    let activeTransaction = 0;
    let transactionNo = 0;
    let inboxTransaction = -1;
    let offsetTransaction = -1;
    let inboxApplied = 0;
    let offset = 0;
    const handler = workflowSignalAtomicConsumerHandler({
      applyBlockedWorkEpisodeAtomically: () =>
        Effect.sync(() => {
          inboxTransaction = activeTransaction;
          inboxApplied += 1;
          return { record: "WorkBlocked:parent" };
        }),
    });
    const result = await Effect.runPromise(
      pollOnce("workflow-signals", projectId, 10, {
        tx: {
          transact: (
            body: Effect.Effect<
              unknown,
              unknown,
              import("@arbor/ports").TransactionScope
            >,
          ) =>
            Effect.gen(function* () {
              const current = ++transactionNo;
              activeTransaction = current;
              const value = yield* body;
              activeTransaction = 0;
              return value;
            }),
        } as never,
        journal: { readAfter: () => Effect.succeed([event]) } as never,
        offsets: {
          read: () => Effect.succeed(offset),
          advance: (
            _consumerId: string,
            _projectId: string,
            sequence: number,
          ) =>
            Effect.sync(() => {
              offsetTransaction = activeTransaction;
              offset = sequence;
            }),
        } as never,
        deadLetters: { quarantine: () => Effect.void } as never,
        projection: { apply: () => Effect.void } as never,
        handlers: () =>
          Effect.die("atomic WorkBlocked must bypass normal handler"),
        atomicHandler: handler,
      }),
    );
    expect(result).toMatchObject({
      fromSequence: 0,
      lastSequence: 1,
      applied: 1,
    });
    expect(inboxApplied).toBe(1);
    expect(offset).toBe(1);
    expect(inboxTransaction).toBe(offsetTransaction);
    expect(offsetTransaction).not.toBe(0);
  });
});
