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
});
