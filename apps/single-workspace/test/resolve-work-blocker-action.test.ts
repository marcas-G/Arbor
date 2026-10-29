import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { resolveWorkBlockerHandler } from "../src/resolve-work-blocker-action.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const deniedTurn = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const successTurn = parse(ProviderTurnId)(
  "ptn_118f2b3c-4d5e-7abc-8def-0123456789a1",
);
const blockerId = "a".repeat(64) as never;

const deniedStep: AgentLoopStepRecord = {
  identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
  providerTurnId: deniedTurn,
  manifestId: "manifest_denied",
  state: "NextStepReady",
  nextActionIndex: 1,
  revision: 2,
  updatedAt: "t0",
};
const currentStep: AgentLoopStepRecord = {
  identity: { executionId, logicalStepNo: 1, repairAttempt: 0 },
  predecessor: deniedStep.identity,
  providerTurnId: successTurn,
  manifestId: "manifest_success",
  state: "ActionsInProgress",
  nextActionIndex: 2,
  revision: 3,
  updatedAt: "t1",
};
const deniedAction: AgentLoopStepActionRecord = {
  identity: deniedStep.identity,
  actionIndex: 0,
  logicalActionId: "lac_denied",
  callRef: "call_denied",
  routeKind: "Executable",
  actionKind: "patch",
  inputHash: "same-input",
  state: "TerminalRejected",
  resultRef: "result_denied",
  settlementRef: "settlement_denied",
  disposition: {
    _tag: "HandlerRejected",
    status: "Denied",
    terminalDenial: { _tag: "HandlerRejected", routeKind: "Executable" },
  },
  observationSourceRef: "observation_denied",
  revision: 1,
  updatedAt: "t0",
};
const successAction: AgentLoopStepActionRecord = {
  identity: currentStep.identity,
  actionIndex: 0,
  logicalActionId: "lac_success",
  callRef: "call_success",
  routeKind: "Executable",
  actionKind: "patch",
  inputHash: "same-input",
  state: "Applied",
  resultRef: "result_success",
  disposition: { _tag: "Applied", status: "Succeeded" },
  observationSourceRef: "observation_success",
  revision: 1,
  updatedAt: "t1",
};
const currentAction: AgentLoopStepActionRecord = {
  identity: currentStep.identity,
  actionIndex: 1,
  logicalActionId: "lac_resolve",
  callRef: "call_resolve",
  routeKind: "Control",
  actionKind: "resolve_work_blocker",
  inputHash: "resolve-input",
  state: "Pending",
  revision: 0,
  updatedAt: "t1",
};
const blocker = {
  blockerId,
  projectId,
  workspaceId,
  workId,
  targetWorkRevision: 0,
  failureFingerprint: "b".repeat(64) as never,
  state: "Open" as const,
  openCycleId: executionId,
  latestRequestRef: "human approval needed",
  failedActionRefs: [
    {
      executionId,
      providerTurnId: deniedTurn,
      logicalStepNo: 0,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: deniedAction.logicalActionId,
      callRef: deniedAction.callRef,
      resultRef: deniedAction.resultRef,
      settlementRef: deniedAction.settlementRef,
      observationSourceRef: deniedAction.observationSourceRef,
      terminalDenial: {
        _tag: "HandlerRejected" as const,
        routeKind: "Executable" as const,
      },
    },
  ],
  revision: 0,
};

const makeState = () => {
  const resolved: unknown[] = [];
  const events: unknown[] = [];
  const sessionWrites: unknown[] = [];
  const actionTransitions: unknown[] = [];
  const stepTransitions: unknown[] = [];
  const stepByKey = new Map([
    ["0:0", deniedStep],
    ["1:0", currentStep],
  ]);
  const actionsByKey = new Map([
    ["0:0", [deniedAction]],
    ["1:0", [successAction, currentAction]],
  ]);
  const dependencies = {
    tx: { transact: (effect: Effect.Effect<unknown>) => effect },
    blockers: {
      findById: () => Effect.succeed(Option.some(blocker)),
      resolve: (input: unknown) => {
        resolved.push(input);
        return Effect.void;
      },
    },
    works: {
      findById: () =>
        Effect.succeed(
          Option.some({
            workId,
            projectId,
            workspaceId,
            lifecycle: "Open",
            revision: 0,
          } as never),
        ),
    },
    loopSteps: {
      find: (identity: AgentLoopStepRecord["identity"]) =>
        Effect.succeed(
          stepByKey.has(`${identity.logicalStepNo}:${identity.repairAttempt}`)
            ? Option.some(
                stepByKey.get(
                  `${identity.logicalStepNo}:${identity.repairAttempt}`,
                ) as AgentLoopStepRecord,
              )
            : Option.none(),
        ),
      listActions: (identity: AgentLoopStepRecord["identity"]) =>
        Effect.succeed(
          actionsByKey.get(
            `${identity.logicalStepNo}:${identity.repairAttempt}`,
          ) ?? [],
        ),
      transitionAction: (input: unknown) => {
        actionTransitions.push(input);
        return Effect.succeed({ ...currentAction, state: "Applied" } as never);
      },
      transition: (input: {
        readonly input?: unknown;
        readonly next?: AgentLoopStepRecord;
      }) => {
        stepTransitions.push(input);
        return Effect.succeed(input.next ?? currentStep);
      },
    },
    providerTurns: {
      findManifestByTurn: (providerTurnId: ProviderTurnId) =>
        Effect.succeed({
          manifestId:
            providerTurnId === successTurn
              ? "manifest_success"
              : "manifest_denied",
          manifestJson: JSON.stringify({
            executionId,
            providerTurnId,
            logicalStepNo: providerTurnId === successTurn ? 1 : 0,
            repairAttempt: 0,
            toolRoutes: [
              {
                name: "patch",
                route: "Executable",
                stableId: "tool.patch",
                version: "1",
                hash: "hash",
              },
            ],
          }),
          portableRequestJson: "{}",
        }),
    },
    sessionWrites: {
      appendItemIdempotent: (input: unknown) => {
        sessionWrites.push(input);
        return Effect.succeed({ sequence: 7, inserted: true });
      },
    },
    journal: {
      append: (drafts: ReadonlyArray<unknown>) => {
        events.push(...drafts);
        return Effect.void;
      },
    },
    clock: { now: () => Effect.succeed("2026-10-12T00:00:00.000Z") },
    ids: { generate: () => Effect.succeed("evt_test") },
  };
  return {
    dependencies,
    resolved,
    events,
    sessionWrites,
    actionTransitions,
    stepTransitions,
  };
};

const input: AgentActionHandlerInput = {
  action: {
    _tag: "ResolveWorkBlocker",
    resolutions: [{ blockerId, successfulActionRefs: ["lac_success"] }],
  },
  invocation: {
    providerTurnId: successTurn,
    outputPosition: 0,
    callRef: "call_resolve",
    toolName: "resolve_work_blocker",
    argumentsJson: "{}",
  },
  execution: {
    executionId,
    projectId,
    workspaceId,
    binding: {
      _tag: "WorkspaceExecution",
      workspaceId,
      episode: { _tag: "WorkEpisode", workId, targetWorkRevision: 0 },
    },
    sessionId,
    admittedAt: "t0",
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  } as never,
  context: {} as never,
  logicalActionId: "lac_resolve",
  actionContext: {
    identity: currentStep.identity,
    actionIndex: 1,
    providerTurnId: successTurn,
    callRef: "call_resolve",
    contextEpoch: 0 as never,
  },
  loopStepFence: {
    executionId,
    workerId: "worker:test",
    workerIncarnationId: "inc:test",
    fencingGeneration: 0 as never,
  },
};

describe("resolve_work_blocker action", () => {
  it("commits exact blocker resolution, WorkBlockerResolved and sourced P9/Session result together", async () => {
    const state = makeState();
    const handler = resolveWorkBlockerHandler(state.dependencies as never);
    const result = await Effect.runPromise(
      handler.handle(input).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "resolve-blocker-test" },
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Observation",
      durableActionCommit: {
        loopStep: { state: "ActionsInProgress", nextActionIndex: 2 },
      },
    });
    expect(state.resolved).toMatchObject([
      {
        blockerId,
        workId,
        targetWorkRevision: 0,
        successfulActionRefs: ["lac_success"],
      },
    ]);
    expect(state.events).toMatchObject([
      {
        eventType: "WorkBlockerResolved",
        payload: { blockerId, workId, workRevision: 0 },
      },
    ]);
    expect(state.sessionWrites).toHaveLength(1);
    expect(state.actionTransitions).toHaveLength(1);
    expect(state.stepTransitions).toHaveLength(1);
  });

  it("rejects a success with a mismatched input and makes no changes", async () => {
    const state = makeState();
    const actionMap = state.dependencies.loopSteps as {
      listActions: (
        identity: AgentLoopStepRecord["identity"],
      ) => Effect.Effect<ReadonlyArray<AgentLoopStepActionRecord>>;
    };
    const original = actionMap.listActions;
    actionMap.listActions = (identity) =>
      identity.logicalStepNo === 1
        ? Effect.succeed([
            { ...successAction, inputHash: "different-input" },
            currentAction,
          ])
        : original(identity);
    const handler = resolveWorkBlockerHandler(state.dependencies as never);
    const failure = await Effect.runPromise(
      Effect.flip(
        handler.handle(input).pipe(
          Effect.provideService(TransactionScope, {
            session: { id: "resolve-blocker-invalid-test" },
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "AgentActionRejected" });
    expect(state.resolved).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(state.sessionWrites).toHaveLength(0);
  });
});
