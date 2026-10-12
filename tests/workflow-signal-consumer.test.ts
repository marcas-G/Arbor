import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  runWorkflowSignalConsumer,
  type WorkflowSignalConsumerDependencies,
} from "../packages/application/src/workflow-signal-consumer.js";
import {
  DependencyId,
  ExecutionId,
  MessageId,
  parse,
  Revision,
  WorkId,
  WorkspaceId,
} from "../packages/domain/src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const dependencyId = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const specialistId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const parentExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const messageId = parse(MessageId)("msg_018f2b3c-4d5e-7abc-8def-0123456789a1");
const deliverMessageId = parse(MessageId)(
  "msg_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

describe("WorkflowSignalConsumer", () => {
  it("turns five durable event kinds into idempotent wake/inbox effects", async () => {
    const wakes: string[] = [];
    const cleared: string[] = [];
    const admitted: string[] = [];
    const deps = {
      tx: {
        transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      },
      waits: {
        findByWork: () =>
          Effect.succeed(
            Option.some({
              workId,
              waitSpec: {
                mode: "Any",
                conditions: [
                  {
                    _tag: "DependencyChanged",
                    dependencyId,
                    observedRevision: 0,
                  },
                  {
                    _tag: "VerificationChanged",
                    workId,
                    targetWorkRevision: 0,
                  },
                ],
              },
            }),
          ),
        listActive: () => Effect.succeed([]),
        clear: (id: WorkId) => Effect.sync(() => void cleared.push(id)),
      },
      works: {
        findById: () =>
          Effect.succeed(
            Option.some({ workspaceId, workId, revision: parse(Revision)(0) }),
          ),
        listByWorkspace: () => Effect.succeed([{ workId }]),
      },
      workspaces: {
        findById: () =>
          Effect.succeed(Option.some({ workspaceId, parentWorkspaceId: null })),
      },
      scheduler: {
        reevaluate: (id: WorkspaceId, reason: { readonly _tag: string }) =>
          Effect.sync(() => {
            wakes.push(`${id}:${reason._tag}`);
            return { _tag: "Idle" as const };
          }),
      },
      dependencies: {
        findById: () =>
          Effect.succeed(
            Option.some({
              dependencyId,
              consumerWorkId: workId,
              revision: 0,
            }),
          ),
      },
      messages: {
        findById: (id: MessageId) =>
          Effect.succeed(
            Option.some({
              messageId: id,
              senderWorkspaceId: workspaceId,
              sentAt: "2026-10-02T00:00:00.000Z",
              message:
                id === deliverMessageId
                  ? {
                      kind: "Deliver",
                      recipientWorkspaceId: parentWorkspaceId,
                      deliverableId: "dlv_018f2b3c-4d5e-7abc-8def-0123456789a1",
                      bodyRef: "blob:y",
                      urgency: "Normal",
                    }
                  : {
                      kind: "DecisionRequest",
                      recipientWorkspaceId: parentWorkspaceId,
                      bodyRef: "blob:x",
                      urgency: "Normal",
                    },
            }),
          ),
      },
      executions: {
        findById: (id: ExecutionId) =>
          Effect.succeed(
            Option.some(
              id === specialistId
                ? {
                    executionId: specialistId,
                    workspaceId,
                    binding: {
                      _tag: "ExecutionBoundAgentBinding",
                      parentExecutionId,
                      mission: "review",
                    },
                    state: {
                      status: "Settled",
                      settlement: {
                        _tag: "Completed",
                        result: { _tag: "CoordinationCompleted" },
                      },
                    },
                  }
                : {
                    executionId: parentExecutionId,
                    workspaceId: parentWorkspaceId,
                    binding: {
                      _tag: "WorkspaceExecution",
                      workspaceId: parentWorkspaceId,
                      focus: { _tag: "Coordination" },
                    },
                    state: { status: "Active", settlement: null },
                  },
            ),
          ),
      },
      inbox: {
        countByKey: () => Effect.succeed(0),
        admitUpsert: (entry: { readonly entryKey: string }) =>
          Effect.sync(() => void admitted.push(entry.entryKey)),
      },
    } as unknown as WorkflowSignalConsumerDependencies;

    const outcomes = await Effect.runPromise(
      runWorkflowSignalConsumer(
        [
          {
            eventId: "evt-dep",
            eventType: "DependencySatisfied",
            occurredAt: "2026-10-02T00:00:00.000Z",
            payload: { dependencyId, satisfiedAtDependencyRevision: 0 },
          },
          {
            eventId: "evt-ver",
            eventType: "VerificationConcluded",
            occurredAt: "2026-10-02T00:00:01.000Z",
            payload: {
              verificationId: "ver_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workId,
              targetWorkRevision: 0,
              verdict: "Fail",
            },
          },
          {
            eventId: "evt-msg",
            eventType: "MessageSent",
            occurredAt: "2026-10-02T00:00:02.000Z",
            payload: { messageId },
          },
          {
            eventId: "evt-deliver",
            eventType: "MessageSent",
            occurredAt: "2026-10-02T00:00:03.000Z",
            payload: {
              messageId: deliverMessageId,
              kind: "Deliver",
              recipient: parentWorkspaceId,
            },
          },
          {
            eventId: "evt-specialist",
            eventType: "ExecutionSettled",
            occurredAt: "2026-10-02T00:00:04.000Z",
            payload: { executionId: specialistId },
          },
        ],
        deps,
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome._tag === "Delivered"),
    ).toHaveLength(5);
    expect(wakes).toEqual(
      expect.arrayContaining([
        `${workspaceId}:DependencySatisfied`,
        `${workspaceId}:VerificationReturned`,
        `${parentWorkspaceId}:InputArrived`,
        `${parentWorkspaceId}:ChildDelivered`,
      ]),
    );
    expect(admitted).toHaveLength(1);
    expect(cleared).toContain(workId);
  });

  it("routes a child PASS result to the exact parent Inbox and wake", async () => {
    const wakes: string[] = [];
    const admitted: Array<{
      recipientWorkspaceId: WorkspaceId;
      entryKey: string;
    }> = [];
    const deps = {
      tx: {
        transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      },
      waits: {
        findByWork: () => Effect.succeed(Option.none()),
        listActive: () => Effect.succeed([]),
        clear: () => Effect.void,
      },
      works: {
        findById: () =>
          Effect.succeed(
            Option.some({ workspaceId, workId, revision: parse(Revision)(0) }),
          ),
        listByWorkspace: () => Effect.succeed([{ workId }]),
      },
      workspaces: {
        findById: () =>
          Effect.succeed(Option.some({ workspaceId, parentWorkspaceId })),
      },
      scheduler: {
        reevaluate: (id: WorkspaceId, reason: { readonly _tag: string }) =>
          Effect.sync(() => {
            wakes.push(`${id}:${reason._tag}`);
            return { _tag: "Idle" as const };
          }),
      },
      dependencies: { findById: () => Effect.succeed(Option.none()) },
      messages: { findById: () => Effect.succeed(Option.none()) },
      executions: { findById: () => Effect.succeed(Option.none()) },
      inbox: {
        countByKey: () => Effect.succeed(0),
        admitUpsert: (entry: {
          readonly recipientWorkspaceId: WorkspaceId;
          readonly entryKey: string;
        }) => Effect.sync(() => void admitted.push(entry)),
      },
    } as unknown as WorkflowSignalConsumerDependencies;

    const outcomes = await Effect.runPromise(
      runWorkflowSignalConsumer(
        [
          {
            eventId: "evt-child-pass",
            eventType: "VerificationConcluded",
            occurredAt: "2026-10-04T00:00:00.000Z",
            payload: {
              verificationId: "ver_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workId,
              targetWorkRevision: 0,
              verdict: "Pass",
            },
          },
        ],
        deps,
      ),
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        _tag: "Delivered",
        kind: "ChildResultReady",
        workspaceId: parentWorkspaceId,
      }),
    ]);
    expect(admitted).toEqual([
      expect.objectContaining({
        recipientWorkspaceId: parentWorkspaceId,
        entryKey: "child-result:ver_018f2b3c-4d5e-7abc-8def-0123456789a1:0",
      }),
    ]);
    expect(wakes).toContain(`${parentWorkspaceId}:InputArrived`);
  });

  it("admits child WorkBlocked once and wakes only when its Inbox wait is already stale", async () => {
    const wakes: string[] = [];
    const inboxRows = new Map<
      string,
      { readonly kind: string; readonly correlationId: string }
    >();
    const blockerId =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const blockedExecution = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const blockerRow = {
      blockerId,
      projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
      workspaceId,
      workId,
      targetWorkRevision: 0,
      failureFingerprint: blockerId,
      state: "Open",
      openCycleId: blockedExecution,
      latestRequestRef: "Please inspect the resource setup.",
      failedActionRefs: [],
      revision: 1,
    };
    let blockerState: "Open" | "Resolved" = "Open";
    const blockedSettlement = {
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
            { _tag: "InboxAdvanced", workspaceId, observedSequence: 2 },
          ],
        },
        request: "Please inspect the resource setup.",
        failedActionRefs: [],
      },
    };
    const execution = {
      executionId: blockedExecution,
      projectId: blockerRow.projectId,
      workspaceId,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        episode: { _tag: "WorkEpisode", workId, targetWorkRevision: 0 },
      },
      state: { status: "Settled", settlement: blockedSettlement },
    };
    const deps = {
      tx: {
        transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      },
      waits: {
        findByWork: () => Effect.succeed(Option.none()),
        listActive: () => Effect.succeed([]),
        clear: () => Effect.void,
      },
      works: {
        findById: () =>
          Effect.succeed(
            Option.some({
              workId,
              workspaceId,
              projectId: blockerRow.projectId,
              revision: 0,
              lifecycle: "Open",
            }),
          ),
        listByWorkspace: () => Effect.succeed([{ workId }]),
      },
      workspaces: {
        findById: (id: WorkspaceId) =>
          Effect.succeed(
            Option.some({
              workspaceId: id,
              parentWorkspaceId: id === workspaceId ? parentWorkspaceId : null,
            }),
          ),
      },
      scheduler: {
        reevaluate: (id: WorkspaceId, reason: { readonly _tag: string }) =>
          Effect.sync(() => {
            wakes.push(`${id}:${reason._tag}`);
            return { _tag: "Idle" as const };
          }),
      },
      dependencies: { findById: () => Effect.succeed(Option.none()) },
      messages: { findById: () => Effect.succeed(Option.none()) },
      executions: { findById: () => Effect.succeed(Option.some(execution)) },
      blockers: {
        findById: () =>
          Effect.succeed(Option.some({ ...blockerRow, state: blockerState })),
      },
      inbox: {
        countByKey: () => Effect.succeed(1),
        currentSequence: () => Effect.succeed(3),
        admitUpsert: (entry: {
          readonly entryKey: string;
          readonly kind: string;
          readonly correlationId?: string;
        }) =>
          Effect.sync(
            () =>
              void inboxRows.set(entry.entryKey, {
                kind: entry.kind,
                correlationId: entry.correlationId ?? "",
              }),
          ),
        listUnconsumed: () =>
          Effect.succeed(
            [...inboxRows].map(([entryKey, value]) => ({ entryKey, ...value })),
          ),
        markConsumed: (_workspaceId: WorkspaceId, entryKey: string) =>
          Effect.sync(() => void inboxRows.delete(entryKey)),
      },
    } as unknown as WorkflowSignalConsumerDependencies;

    const blockedEvent = {
      eventId: "evt-blocked",
      eventType: "ExecutionSettled",
      occurredAt: "2026-10-12T00:00:00.000Z",
      payload: { executionId: blockedExecution },
    };
    const outcomes = await Effect.runPromise(
      runWorkflowSignalConsumer([blockedEvent, blockedEvent], deps),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({
        _tag: "Delivered",
        kind: "WorkBlocked",
        workspaceId: parentWorkspaceId,
      }),
      expect.objectContaining({
        _tag: "Delivered",
        kind: "WorkBlocked",
        workspaceId: parentWorkspaceId,
      }),
    ]);
    expect(inboxRows.size).toBe(1);
    expect(inboxRows.get(blockedExecution)).toEqual({
      kind: "WorkBlocked",
      correlationId: blockerId,
    });
    expect(wakes).toContain(`${parentWorkspaceId}:InputArrived`);
    expect(wakes).toContain(`${workspaceId}:InputArrived`);

    const resolutionEvent = {
      eventId: "evt-blocker-resolved",
      eventType: "WorkBlockerResolved",
      occurredAt: "2026-10-12T00:00:01.000Z",
      payload: { blockerId, workId, workRevision: 0 },
    };
    const staleResolution = await Effect.runPromise(
      runWorkflowSignalConsumer([resolutionEvent], deps),
    );
    expect(staleResolution[0]?._tag).toBe("Ignored");
    expect(inboxRows.size).toBe(1);
    blockerState = "Resolved";
    const resolved = await Effect.runPromise(
      runWorkflowSignalConsumer([resolutionEvent], deps),
    );
    expect(resolved[0]).toMatchObject({
      _tag: "Delivered",
      kind: "WorkBlockerResolved",
      workspaceId: parentWorkspaceId,
    });
    expect(inboxRows.size).toBe(0);
  });
});
