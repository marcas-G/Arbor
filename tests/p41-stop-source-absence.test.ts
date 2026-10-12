import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CommandGateway } from "../packages/application/src/index.js";
import type {
  DecisionId,
  ExecutionId,
  Principal,
  ProjectId,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import { runRecovery } from "../packages/execution-runtime/src/recovery.js";
import {
  AgentLoopStepStore,
  Clock,
  DecisionRequestStore,
  DomainEventJournal,
  ExecutionRepository,
  IdGenerator,
  LeaseService,
  ProviderTurnStore,
  ReconciliationSource,
  RecoveryAttentionFactStore,
  TransactionPort,
  TransactionScope,
} from "../packages/ports/src/index.js";

const executionId = "exe_p41_source_absent" as ExecutionId;
const projectId = "prj_p41_source_absent" as ProjectId;
const workspaceId = "ws_authoritative" as WorkspaceId;
const decisionId = "dec_p41_source_absent" as DecisionId;
const principal = "recovery:p41-source-absent-test" as Principal;

const runStoppedRecovery = async (input: {
  readonly episode:
    | {
        readonly _tag: "WorkEpisode";
        readonly workId: never;
        readonly targetWorkRevision: never;
      }
    | {
        readonly _tag: "DecisionEpisode";
        readonly decisionId: DecisionId;
        readonly decisionKind: "SelectCurrentWork";
        readonly requestRevision: number;
      };
  readonly includePendingSelection: boolean;
  readonly requestWorkspaceId: WorkspaceId;
  readonly providerManifestId: string;
}) => {
  const stepIdentity = {
    executionId,
    logicalStepNo: 0,
    repairAttempt: 0,
  };
  const step = {
    identity: stepIdentity,
    providerTurnId: "ptn_p41_source_absent" as never,
    manifestId: "manifest_step",
    state: "ActionsInProgress" as const,
    nextActionIndex: 0,
    revision: 3,
    updatedAt: "t1",
  };
  const action = {
    identity: stepIdentity,
    actionIndex: 0,
    logicalActionId: "lac_p41_source_absent" as never,
    callRef: "call_selection",
    routeKind: "Control" as const,
    actionKind: "select_current_work",
    inputHash: "selection-input",
    state: "Pending" as const,
    revision: 0,
    updatedAt: "t1",
  };
  const execution = {
    executionId,
    projectId,
    workspaceId,
    binding: {
      _tag: "WorkspaceExecution" as const,
      workspaceId,
      episode: input.episode,
    },
    sessionId: "ses_p41_source_absent" as SessionId,
    admittedAt: "t0",
    stopRequestedAt: "t2",
    state: { status: "Active" as const, settlement: null },
  };
  const settlements: unknown[] = [];
  const p41StoreTouches = { reads: 0, writes: 0 };
  const tx = {
    transact: (body: Effect.Effect<unknown, unknown, TransactionScope>) =>
      Effect.provideService(body, TransactionScope, {
        session: { id: "test-session" },
      }),
  };
  const app = Layer.mergeAll(
    Layer.succeed(TransactionPort, tx as never),
    Layer.succeed(ExecutionRepository, {
      findUnsettledExecutions: () => Effect.succeed([execution]),
    } as never),
    Layer.succeed(LeaseService, {
      invalidateExpired: () => Effect.succeed(0),
    } as never),
    Layer.succeed(ReconciliationSource, {
      pending: () => Effect.succeed([]),
    } as never),
    Layer.succeed(RecoveryAttentionFactStore, {
      isSubmittedDecisionBindingAvailable: () => Effect.succeed(false),
      listSubmittedDecisionBindingFailures: () => {
        p41StoreTouches.reads += 1;
        return Effect.die(
          new Error("P41 facts must not be read when unavailable"),
        );
      },
      recordSubmittedDecisionBindingFailure: () => {
        p41StoreTouches.writes += 1;
        return Effect.die(
          new Error("P41 facts must not be written when unavailable"),
        );
      },
    } as never),
    Layer.succeed(AgentLoopStepStore, {
      findCurrent: () =>
        Effect.succeed(
          input.includePendingSelection ? Option.some(step) : Option.none(),
        ),
      listActions: () => Effect.succeed([action]),
    } as never),
    Layer.succeed(DecisionRequestStore, {
      findById: () =>
        Effect.succeed(
          Option.some({
            decisionId,
            workspaceId: input.requestWorkspaceId,
            candidateWorkIds: ["wrk_selected" as never],
            workspaceRevision: 10,
            state: {
              _tag: "Submitted" as const,
              selectedWorkId: "wrk_selected" as never,
            },
            revision: 1,
            createdAt: "t0",
            updatedAt: "t1",
          }),
        ),
    } as never),
    Layer.succeed(ProviderTurnStore, {
      findSettledResult: () =>
        Effect.succeed({
          _tag: "SettledSuccess",
          manifestId: input.providerManifestId,
        }),
    } as never),
    Layer.succeed(CommandGateway, {
      execute: (envelope: { readonly payload: unknown }) => {
        settlements.push(envelope.payload);
        return Effect.succeed({} as never);
      },
    } as never),
    Layer.succeed(Clock, { now: () => Effect.succeed("t3") }),
    Layer.succeed(IdGenerator, {
      generate: (kind: string) => Effect.succeed(`${kind}_p41` as never),
    }),
    Layer.succeed(DomainEventJournal, {
      readAfter: () => Effect.succeed([]),
    } as never),
  );

  const result = await Effect.runPromise(
    Effect.provide(runRecovery(principal), app),
  );
  return { result, settlements, p41StoreTouches, execution };
};

describe("P41 Stop recovery when the fact source is unavailable", () => {
  it("still settles an ordinary Work Stop", async () => {
    const { result, settlements } = await runStoppedRecovery({
      episode: {
        _tag: "WorkEpisode",
        workId: "wrk_stopped" as never,
        targetWorkRevision: 0 as never,
      },
      includePendingSelection: false,
      requestWorkspaceId: workspaceId,
      providerManifestId: "manifest_step",
    });

    expect(settlements).toHaveLength(1);
    expect(result.settled).toEqual([executionId]);
    expect(result.escalated).toEqual([]);
  });

  it("still settles a Decision Stop when the exact submitted binding matches", async () => {
    const { result, settlements } = await runStoppedRecovery({
      episode: {
        _tag: "DecisionEpisode",
        decisionId,
        decisionKind: "SelectCurrentWork",
        requestRevision: 0,
      },
      includePendingSelection: true,
      requestWorkspaceId: workspaceId,
      providerManifestId: "manifest_step",
    });

    expect(settlements).toHaveLength(1);
    expect(result.settled).toEqual([executionId]);
    expect(result.escalated).toEqual([]);
  });

  it.each([
    {
      reason: "foreign submitted Workspace",
      requestWorkspaceId: "ws_foreign" as WorkspaceId,
      providerManifestId: "manifest_step",
    },
    {
      reason: "mismatched submitted manifest",
      requestWorkspaceId: workspaceId,
      providerManifestId: "manifest_foreign",
    },
  ])(
    "keeps a mismatching stopped DecisionEpisode active without 0041 storage: $reason",
    async (input) => {
      const { result, settlements, p41StoreTouches, execution } =
        await runStoppedRecovery({
          episode: {
            _tag: "DecisionEpisode",
            decisionId,
            decisionKind: "SelectCurrentWork",
            requestRevision: 0,
          },
          includePendingSelection: true,
          requestWorkspaceId: input.requestWorkspaceId,
          providerManifestId: input.providerManifestId,
        });

      expect(settlements).toHaveLength(0);
      expect(result.settled).toEqual([]);
      expect(result.escalated).toEqual([executionId]);
      expect(execution.state).toEqual({ status: "Active", settlement: null });
      expect(p41StoreTouches).toEqual({ reads: 0, writes: 0 });
    },
  );
});
