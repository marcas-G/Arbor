import {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ProviderRunInput,
  ProviderRuntimeService,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { secretRef, TransactionScope } from "@arbor/ports";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  runNativeCompaction,
  runSummaryCompaction,
} from "../src/compaction-coordinator.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789f2",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789f2");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f2",
);
const execution = {
  executionId,
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789f2"),
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    focus: { _tag: "Coordination" as const },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
};

const tx = {
  transact: (body: Effect.Effect<unknown, unknown, TransactionScope>) =>
    Effect.provideService(body, TransactionScope, { session: { id: "test" } }),
} as unknown as TransactionPortService;

describe("SCRC Summary Compaction Coordinator", () => {
  it("runs an explicit compaction turn then commits checkpoint + next epoch", async () => {
    let observed: ProviderRunInput | undefined;
    let committed: unknown;
    const sourceSecretRef = secretRef("secret://deployment/model-a");
    const providerRuntime = {
      runTurn: (input: ProviderRunInput) => {
        observed = input;
        return Effect.succeed({
          attemptNo: 0,
          retryDecisions: [],
          events: [
            { _tag: "TextDelta" as const, text: "objective and next move" },
            { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
          ],
        });
      },
    } as ProviderRuntimeService;
    const sessions = {
      commitCompaction: (_sessionId: unknown, input: unknown) =>
        Effect.sync(() => {
          committed = input;
          return { sequence: 4, inserted: true, newEpoch: 1 as never };
        }),
    } as unknown as SessionRepositoryService;

    const result = await Effect.runPromise(
      runSummaryCompaction(
        {
          execution,
          logicalStepNo: 2,
          currentEpoch: parse(ContextEpochNumber)(0),
          modelRef: "model-a",
          bindingFingerprint: "binding-a",
          secretRef: sourceSecretRef,
          inputItems: [{ _tag: "Message", role: "user", text: "long work" }],
          fence: {
            executionId,
            workerId: "worker",
            workerIncarnationId: "inc",
            fencingGeneration: 0 as never,
          },
        },
        { providerRuntime, sessions, tx },
      ),
    );
    expect(observed?.request).toMatchObject({
      requestVersion: 2,
      operationKind: "CompactionSummary",
    });
    expect(observed?.secretRef).toBe(sourceSecretRef);
    expect(committed).toMatchObject({
      expectedEpoch: 0,
      nextEpoch: 1,
      checkpoint: {
        _tag: "CompactionCheckpoint",
        summaryText: "objective and next move",
      },
    });
    expect(result.newEpoch).toBe(1);
  });

  it("does not commit when the compaction turn has no summary", async () => {
    let commits = 0;
    const outcome = await Effect.runPromise(
      Effect.result(
        runSummaryCompaction(
          {
            execution,
            logicalStepNo: 2,
            currentEpoch: parse(ContextEpochNumber)(0),
            modelRef: "model-a",
            bindingFingerprint: "binding-a",
            inputItems: [],
            fence: {
              executionId,
              workerId: "worker",
              workerIncarnationId: "inc",
              fencingGeneration: 0 as never,
            },
          },
          {
            providerRuntime: {
              runTurn: () =>
                Effect.succeed({
                  attemptNo: 0,
                  retryDecisions: [],
                  events: [
                    {
                      _tag: "TurnCompleted" as const,
                      finishReason: "Stop" as const,
                    },
                  ],
                }),
            },
            sessions: {
              commitCompaction: () =>
                Effect.sync(() => {
                  commits += 1;
                  return { sequence: 0, inserted: true, newEpoch: 1 as never };
                }),
            } as unknown as SessionRepositoryService,
            tx,
          },
        ),
      ),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    expect(commits).toBe(0);
  });

  it("binds a provider-native opaque checkpoint to the resolved binding", async () => {
    let committed: unknown;
    let observed: ProviderRunInput | undefined;
    const sourceSecretRef = secretRef("secret://deployment/model-a");
    const result = await Effect.runPromise(
      runNativeCompaction(
        {
          execution,
          logicalStepNo: 3,
          currentEpoch: parse(ContextEpochNumber)(0),
          modelRef: "model-a",
          bindingFingerprint: "binding-a",
          inputItems: [],
          secretRef: sourceSecretRef,
          fence: {
            executionId,
            workerId: "worker",
            workerIncarnationId: "inc",
            fencingGeneration: 0 as never,
          },
        },
        {
          providerRuntime: {
            runTurn: (input) => {
              observed = input;
              return Effect.succeed({
                attemptNo: 0,
                retryDecisions: [],
                events: [
                  { _tag: "ContinuationState" as const, stateRef: "opaque:1" },
                  {
                    _tag: "TurnCompleted" as const,
                    finishReason: "Stop" as const,
                  },
                ],
              });
            },
          },
          sessions: {
            commitCompaction: (_sessionId: unknown, input: unknown) =>
              Effect.sync(() => {
                committed = input;
                return { sequence: 1, inserted: true, newEpoch: 1 as never };
              }),
          } as unknown as SessionRepositoryService,
          tx,
        },
      ),
    );
    expect(result.opaqueItemRef).toBe("opaque:1");
    expect(observed?.secretRef).toBe(sourceSecretRef);
    expect(committed).toMatchObject({
      checkpoint: {
        implementation: "ProviderNative",
        opaqueItemRef: "opaque:1",
        bindingFingerprint: "binding-a",
      },
    });
  });
});
