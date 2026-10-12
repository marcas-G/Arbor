import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  blockedFailureFingerprint,
  workBlockerIdentity,
} from "../packages/application/src/blocked-action-evidence.js";
import type { Execution, WorkBlocker } from "../packages/domain/dist/index.js";
import {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import { makeSettleExecutionHandler } from "../packages/execution-runtime/src/commands/settle-execution.js";
import type {
  InboxProjectionStoreService,
  WorkBlockerStoreService,
  WorkRepositoryService,
  WorkWait,
  WorkWaitStoreService,
} from "../packages/ports/dist/index.js";
import { TransactionScope } from "../packages/ports/dist/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const ref: WorkBlocker["failedActionRefs"][number] = {
  executionId,
  providerTurnId,
  logicalStepNo: 1,
  repairAttempt: 0,
  actionIndex: 0,
  logicalActionId: "la_test",
  callRef: "call_test",
  resultRef: "result_test",
  settlementRef: "settlement_test",
  observationSourceRef: "observation_test",
  terminalDenial: {
    _tag: "P4NoEffectDenied",
    reasonCode: "ResourceAdmissionDenied",
  },
};
const failedActionRefs = [ref] as const;
const verifiedItem = {
  ref,
  actionDefinition: {
    stableId: "builtin.patch",
    version: "1",
    hash: "patch-hash",
  },
  routeKind: "Executable" as const,
  actionKind: "patch",
  inputHash: "input-hash",
  resultStatus: "Denied" as const,
};
const verifiedEvidence = [verifiedItem];
const failureFingerprint = blockedFailureFingerprint(verifiedEvidence);
const blockerId = workBlockerIdentity({
  projectId,
  workId,
  targetWorkRevision: 0 as never,
  failureFingerprint,
}) as WorkBlocker["blockerId"];

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "WorkEpisode",
      workId,
      targetWorkRevision: 0 as never,
    },
  },
  sessionId,
  admittedAt: "2026-10-12T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const blockedSettlement = {
  _tag: "Completed" as const,
  result: {
    _tag: "Blocked" as const,
    workId,
    targetWorkRevision: 0 as never,
    blockerId,
    waitFor: {
      mode: "Any" as const,
      conditions: [
        { _tag: "Manual" as const },
        { _tag: "InboxAdvanced" as const, workspaceId, observedSequence: 0 },
      ],
    },
    request: "The denied action needs a human-approved resource boundary.",
    failedActionRefs,
  },
};

const step = {
  identity: { executionId, logicalStepNo: 1, repairAttempt: 0 },
  providerTurnId,
  manifestId: "manifest_test",
  state: "SettlementProposed",
  nextActionIndex: 1,
  revision: 3,
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const action = {
  identity: step.identity,
  actionIndex: 0,
  logicalActionId: ref.logicalActionId,
  callRef: ref.callRef,
  routeKind: "Executable",
  actionKind: "patch",
  inputHash: "input-hash",
  state: "TerminalRejected",
  resultRef: ref.resultRef,
  settlementRef: ref.settlementRef,
  observationSourceRef: ref.observationSourceRef,
  disposition: {
    _tag: "HandlerRejected",
    status: "Denied",
    terminalDenial: ref.terminalDenial,
  },
  revision: 1,
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const pinnedManifest = {
  executionId,
  providerTurnId,
  logicalStepNo: 1,
  repairAttempt: 0,
  toolRoutes: [
    {
      name: "patch",
      route: "Executable",
      stableId: "builtin.patch",
      version: "1",
      hash: "patch-hash",
    },
  ],
};

const makeDependencies = (sequenceValues: ReadonlyArray<number>) => {
  const blockers: WorkBlocker[] = [];
  const waits: WorkWait[] = [];
  const settled: unknown[] = [];
  let reads = 0;
  const dependencies = {
    executions: {
      findById: () => Effect.succeed(Option.some(execution)),
      settle: (_id: ExecutionId, settlement: unknown) => {
        settled.push(settlement);
        return Effect.void;
      },
    },
    workWaits: {
      upsert: (wait: WorkWait) => {
        waits.push(wait);
        return Effect.void;
      },
    } as Pick<WorkWaitStoreService, "upsert">,
    blockers: {
      openOrUpdate: (blocker: WorkBlocker) => {
        blockers.push(blocker);
        return Effect.succeed(blocker);
      },
    } as Pick<WorkBlockerStoreService, "openOrUpdate">,
    works: {
      findById: () =>
        Effect.succeed(
          Option.some({
            workId,
            projectId,
            workspaceId,
            revision: 0,
            lifecycle: "Open",
          } as never),
        ),
    } as Pick<WorkRepositoryService, "findById">,
    inbox: {
      currentSequence: () => {
        const value =
          sequenceValues[Math.min(reads, sequenceValues.length - 1)] ?? 0;
        reads += 1;
        return Effect.succeed(value);
      },
    } as Pick<InboxProjectionStoreService, "currentSequence">,
    blockedEvidence: {
      loopSteps: {
        find: () => Effect.succeed(Option.some(step as never)),
        listActions: () => Effect.succeed([action as never]),
      },
      providerTurns: {
        findManifestByTurn: () =>
          Effect.succeed({
            manifestId: "manifest_test",
            manifestJson: JSON.stringify(pinnedManifest),
            portableRequestJson: "{}",
          }),
      },
    },
  };
  return { dependencies, blockers, waits, settled, sequenceReads: () => reads };
};

describe("P2 Completed(Blocked)", () => {
  it("atomically records canonical blocker + explicit Manual/InboxAdvanced WorkWait", async () => {
    const state = makeDependencies([0, 0]);
    const handler = makeSettleExecutionHandler(state.dependencies as never);
    const effect = handler.execute(
      {
        commandType: "SettleExecution",
        commandId: "cmd_test" as never,
        projectId,
        actor: "user:test" as never,
        issuedAt: "2026-10-12T00:01:00.000Z",
        payload: { executionId, settlement: blockedSettlement },
      } as never,
      {} as never,
    );
    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "blocked-settlement-test" },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    expect(state.blockers).toHaveLength(1);
    expect(state.blockers[0]).toMatchObject({
      blockerId,
      failureFingerprint,
      state: "Open",
      workId,
      targetWorkRevision: 0,
      latestRequestRef: blockedSettlement.result.request,
    });
    expect(state.waits).toHaveLength(1);
    expect(state.waits[0]?.waitSpec).toEqual(blockedSettlement.result.waitFor);
    expect(state.settled).toEqual([blockedSettlement]);
    expect(state.sequenceReads()).toBe(2);
  });

  it("rejects a fabricated ref from a different Execution before settlement", async () => {
    const state = makeDependencies([0, 0]);
    const foreignRef = {
      ...ref,
      executionId: parse(ExecutionId)(
        "exe_118f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
    };
    const refs = [foreignRef] as const;
    const fingerprint = blockedFailureFingerprint([
      { ...verifiedItem, ref: foreignRef },
    ]);
    const fakeId = workBlockerIdentity({
      projectId,
      workId,
      targetWorkRevision: 0 as never,
      failureFingerprint: fingerprint,
    }) as WorkBlocker["blockerId"];
    const handler = makeSettleExecutionHandler(state.dependencies as never);
    const effect = handler.execute(
      {
        commandType: "SettleExecution",
        commandId: "cmd_test_foreign" as never,
        projectId,
        actor: "user:test" as never,
        issuedAt: "2026-10-12T00:01:00.000Z",
        payload: {
          executionId,
          settlement: {
            ...blockedSettlement,
            result: {
              ...blockedSettlement.result,
              blockerId: fakeId,
              failedActionRefs: refs,
            },
          },
        },
      } as never,
      {} as never,
    );
    await expect(
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(TransactionScope, {
            session: { id: "blocked-settlement-invalid-test" },
          }),
        ),
      ),
    ).rejects.toThrow("Blocked evidence must reference this Execution");
    expect(state.blockers).toHaveLength(0);
    expect(state.waits).toHaveLength(0);
    expect(state.settled).toHaveLength(0);
  });
});
