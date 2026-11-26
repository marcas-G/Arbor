import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runCompaction } from "../../../../packages/agent-runtime/src/compaction-coordinator.js";
import {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../../../packages/domain/src/index.js";
import {
  type ProviderRunInput,
  type ProviderRuntimeService,
  TransactionScope,
} from "../../../../packages/ports/dist/index.js";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19Failure,
  childEntry,
  expireLeaseAfterOldDaemonExit,
  prepareActualWorkFrontier,
  prepareFilteredRowScenario,
  probes,
  providerRequests,
  readExecutionIdForProviderTurn,
  readSnapshot,
  readTypedSessionRows,
  readWorkFrontierThroughSessionRepository,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 ProviderNative binding recovery", () => {
  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "keeps a filtered HumanConversation row uncovered across compaction %s and restart",
    async (boundary) => {
      const {
        nativeGate,
        fixture,
        client,
        project,
        workId,
        filterEntryKey,
        filterText,
        filterSequence,
        finalGuidance,
        compactionDaemonEnvironment,
        currentWork,
        typedRowsNow,
        nativeRequest,
      } = await prepareFilteredRowScenario(boundary);
      if (nativeRequest === undefined) {
        throw new Error("filtered-row Native compaction request is missing");
      }
      expect(nativeRequest.bindingVariant).toBe("A");
      const heldNativeRequest = await nativeGate.waitUntilEntered();
      expect(heldNativeRequest.providerTurnId).toBe(
        nativeRequest.providerTurnId,
      );
      const nativeExecutionId = readExecutionIdForProviderTurn(
        fixture.databaseFile,
        nativeRequest.providerTurnId,
      );
      const preCheckpoint = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId: nativeExecutionId,
        workId,
      });
      expect(preCheckpoint.checkpoints).toEqual([]);
      const nativeTurn = preCheckpoint.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeRequest.providerTurnId,
      );
      const nativeManifest = JSON.parse(nativeTurn?.manifest_json ?? "{}") as {
        inputFrontier?: {
          firstSequence: number | null;
          lastSequence: number | null;
        };
        contextRefs?: ReadonlyArray<string>;
        instructionFragments?: ReadonlyArray<{
          identity: string;
          revision: number;
          source: string;
        }>;
        controlBasis?: { authorizationDigest?: string };
        resolvedModelBindingFingerprint?: string;
      };
      expect(nativeManifest.inputFrontier?.firstSequence).toEqual(
        expect.any(Number),
      );
      expect(nativeManifest.contextRefs).not.toContain(
        `session:InboxEntry:${filterEntryKey}`,
      );
      expect(nativeManifest.instructionFragments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ identity: `work-objective:${workId}` }),
          expect.objectContaining({ identity: `work-constraints:${workId}` }),
          expect.objectContaining({
            identity: `completion-expectation:${workId}`,
          }),
          expect.objectContaining({
            identity: `verification-mission:${workId}`,
          }),
          expect.objectContaining({
            identity: `responsibility:${project.rootWorkspaceId}`,
          }),
          expect.objectContaining({
            identity: `resource-boundary:${project.rootWorkspaceId}`,
          }),
        ]),
      );
      expect(nativeManifest.controlBasis?.authorizationDigest).toMatch(/.+/u);
      const nativeRequestJson = JSON.parse(
        nativeTurn?.portable_request_json ?? "{}",
      ) as {
        inputItems?: ReadonlyArray<{
          _tag?: string;
          role?: string;
          text?: string;
        }>;
      };
      expect(JSON.stringify(nativeRequestJson.inputItems)).not.toContain(
        filterText,
      );
      expect(JSON.stringify(nativeRequestJson.inputItems)).not.toContain(
        filterEntryKey,
      );
      expect(
        nativeRequestJson.inputItems?.filter(
          (item) =>
            item._tag === "Message" &&
            item.role === "user" &&
            item.text?.includes(finalGuidance),
        ),
      ).toHaveLength(1);
      const rowsAtNativeRequest = readTypedSessionRows(
        fixture.databaseFile,
        project.rootSessionId,
      );
      expect(
        rowsAtNativeRequest.find((row) => row.sequence === filterSequence),
      ).toMatchObject({
        item_type: "UserMessage",
        source_ref: filterEntryKey,
      });
      expect(
        rowsAtNativeRequest.find((row) => row.sequence === filterSequence)
          ?.payload_json,
      ).toContain(filterText);
      const consideredRows = rowsAtNativeRequest.filter(
        (row) =>
          nativeManifest.inputFrontier?.firstSequence !== null &&
          nativeManifest.inputFrontier?.firstSequence !== undefined &&
          nativeManifest.inputFrontier?.lastSequence !== null &&
          nativeManifest.inputFrontier?.lastSequence !== undefined &&
          row.sequence >= nativeManifest.inputFrontier.firstSequence &&
          row.sequence <= nativeManifest.inputFrontier.lastSequence,
      );
      expect(consideredRows.length).toBeGreaterThan(0);
      expect(consideredRows.length).toBeLessThanOrEqual(64);
      const filteredRowOffset = consideredRows.findIndex(
        (row) => row.sequence === filterSequence,
      );
      expect(
        filteredRowOffset,
        JSON.stringify({
          filterSequence,
          firstSequence: nativeManifest.inputFrontier?.firstSequence,
          lastSequence: nativeManifest.inputFrontier?.lastSequence,
          totalRows: rowsAtNativeRequest.length,
          rowsAfterFilter: rowsAtNativeRequest.filter(
            (row) => row.sequence > filterSequence,
          ).length,
        }),
      ).toBeGreaterThanOrEqual(0);
      expect(filteredRowOffset).toBeLessThanOrEqual(4);

      nativeGate.release();
      const boundaryProbe = await waitForPublic(
        async () => probes.find((probe) => probe.boundary === boundary),
        (probe) => probe !== undefined,
        60_000,
      );
      expect(boundaryProbe?.providerTurnId).toBe(nativeRequest.providerTurnId);
      const atBoundary = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId: nativeExecutionId,
        workId,
      });
      const providerTurnIdsAtBoundary = atBoundary.providerTurns.map(
        (turn) => turn.provider_turn_id,
      );
      const settledActionsAtBoundary = atBoundary.actions
        .filter((action) => action.state === "Applied")
        .map((action) => ({
          logical_step_no: action.logical_step_no,
          repair_attempt: action.repair_attempt,
          action_index: action.action_index,
          logical_action_id: action.logical_action_id,
          call_ref: action.call_ref,
          action_kind: action.action_kind,
          state: action.state,
          revision: action.revision,
          observation_source_ref: action.observation_source_ref,
        }));
      expect(atBoundary.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(atBoundary.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      if (boundary === "AH17AfterCheckpointEpochCommit") {
        const checkpoint = JSON.parse(
          atBoundary.checkpoints[0]?.payload_json ?? "{}",
        ) as Record<string, unknown>;
        expect(checkpoint).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          fromEpoch: 0,
          toEpoch: 1,
        });
        expect(JSON.stringify(checkpoint)).not.toContain(filterText);
        expect(JSON.stringify(checkpoint)).not.toContain(filterEntryKey);
      }
      expect(
        readTypedSessionRows(fixture.databaseFile, project.rootSessionId),
      ).toContainEqual(
        expect.objectContaining({
          sequence: filterSequence,
          item_type: "UserMessage",
          source_ref: filterEntryKey,
        }),
      );

      const nativeRequestCount = providerRequests.filter(
        (request) => request.providerTurnId === nativeRequest.providerTurnId,
      ).length;
      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        nativeExecutionId,
        workId,
      );
      const recoveryDaemonEnvironment = {
        ...compactionDaemonEnvironment,
        ARBOR_AH19_BOUNDARY: "none",
        ...(boundary === "AH17AfterCheckpointEpochCommit"
          ? { ARBOR_AH19_BINDING_VARIANT: "B" }
          : {}),
      };
      await fixture.restart({
        entry: childEntry,
        daemonEnvironment: recoveryDaemonEnvironment,
      });
      const expectedAddedProviderTurns =
        boundary === "AH17AfterCheckpointEpochCommit" ? 2 : 1;
      const recovered = await waitForPublic(
        async () =>
          readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId: nativeExecutionId,
            workId,
          }),
        (snapshot) =>
          snapshot.session !== undefined &&
          snapshot.session.context_epoch >= 1 &&
          snapshot.checkpoints.length >= 1 &&
          snapshot.workWait !== undefined &&
          snapshot.providerTurns.filter(
            (turn) =>
              !providerTurnIdsAtBoundary.includes(turn.provider_turn_id),
          ).length >= expectedAddedProviderTurns,
        75_000,
      );
      expect(
        recovered.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeRequest.providerTurnId,
        ),
      ).toHaveLength(1);
      for (const providerTurnId of providerTurnIdsAtBoundary) {
        expect(
          recovered.providerTurns.filter(
            (turn) => turn.provider_turn_id === providerTurnId,
          ),
        ).toHaveLength(1);
      }
      for (const settledAction of settledActionsAtBoundary) {
        expect(
          recovered.actions.filter(
            (action) =>
              action.logical_action_id === settledAction.logical_action_id,
          ),
        ).toEqual([settledAction]);
      }
      const providerTurnsAddedAfterBoundary = recovered.providerTurns.filter(
        (turn) => !providerTurnIdsAtBoundary.includes(turn.provider_turn_id),
      );
      const addedSummaryTurns = providerTurnsAddedAfterBoundary.filter(
        (turn) => {
          const manifest = JSON.parse(turn.manifest_json ?? "{}") as {
            operationKind?: string;
          };
          return manifest.operationKind === "CompactionSummary";
        },
      );
      expect(providerTurnsAddedAfterBoundary).toHaveLength(
        expectedAddedProviderTurns,
      );
      expect(addedSummaryTurns).toHaveLength(
        boundary === "AH17AfterCheckpointEpochCommit" ? 1 : 0,
      );
      const boundaryEpoch = atBoundary.session?.context_epoch;
      expect(boundaryEpoch).toBeDefined();
      for (const addedTurn of providerTurnsAddedAfterBoundary) {
        const manifest = JSON.parse(addedTurn.manifest_json ?? "{}") as {
          operationKind?: string;
        };
        expect(["CompactionSummary", "Inference"]).toContain(
          manifest.operationKind,
        );
      }
      for (const summaryTurn of addedSummaryTurns) {
        expect(summaryTurn.context_epoch).toBe(boundaryEpoch);
        const summaryManifest = JSON.parse(
          summaryTurn.manifest_json ?? "{}",
        ) as {
          operationKind?: string;
          inputFrontier?: typeof nativeManifest.inputFrontier;
          contextRefs?: ReadonlyArray<string>;
          resolvedModelBindingFingerprint?: string;
          sourceAgentLoopStep?: { providerTurnId?: string };
        };
        expect(summaryManifest.operationKind).toBe("CompactionSummary");
        expect(summaryManifest.inputFrontier).toEqual(
          nativeManifest.inputFrontier,
        );
        expect(summaryManifest.resolvedModelBindingFingerprint).not.toBe(
          nativeManifest.resolvedModelBindingFingerprint,
        );
        expect(
          summaryManifest.sourceAgentLoopStep?.providerTurnId,
        ).toBeTruthy();
        expect(atBoundary.steps.map((step) => step.provider_turn_id)).toContain(
          summaryManifest.sourceAgentLoopStep?.providerTurnId,
        );
        const summaryCheckpoint = recovered.checkpoints.find(
          (checkpoint) =>
            checkpoint.source_ref === summaryTurn.provider_turn_id,
        );
        expect(summaryCheckpoint).toBeDefined();
        expect(
          JSON.parse(summaryCheckpoint?.payload_json ?? "{}"),
        ).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "Summary",
          fromEpoch: boundaryEpoch,
          toEpoch: Number(boundaryEpoch) + 1,
        });
        expect(summaryManifest.contextRefs).not.toContain(
          `session:InboxEntry:${filterEntryKey}`,
        );
        expect(summaryTurn.portable_request_json).not.toContain(filterText);
        expect(summaryTurn.portable_request_json).not.toContain(filterEntryKey);
        const summaryRequest = JSON.parse(
          summaryTurn.portable_request_json ?? "{}",
        ) as { inputItems?: ReadonlyArray<{ _tag?: string }> };
        expect(summaryRequest.inputItems?.length).toBeGreaterThan(1);
        expect(
          providerRequests.filter(
            (request) =>
              request.providerTurnId === summaryTurn.provider_turn_id,
          ),
        ).toHaveLength(1);
        const summaryProviderRequest = providerRequests.find(
          (request) => request.providerTurnId === summaryTurn.provider_turn_id,
        );
        expect(summaryProviderRequest?.bindingVariant).toBe(
          boundary === "AH17AfterCheckpointEpochCommit" ? "B" : "A",
        );
      }
      const addedInferenceTurns = providerTurnsAddedAfterBoundary.filter(
        (turn) => {
          const manifest = JSON.parse(turn.manifest_json ?? "{}") as {
            operationKind?: string;
          };
          return manifest.operationKind === "Inference";
        },
      );
      expect(addedInferenceTurns).toHaveLength(1);
      const actionIdsAtBoundary = new Set(
        atBoundary.actions.map((action) => action.logical_action_id),
      );
      for (const action of recovered.actions) {
        if (actionIdsAtBoundary.has(action.logical_action_id)) continue;
        const owner = recovered.steps.find(
          (step) =>
            step.logical_step_no === action.logical_step_no &&
            step.repair_attempt === action.repair_attempt,
        );
        expect(owner).toBeDefined();
        expect(providerTurnIdsAtBoundary).not.toContain(
          owner?.provider_turn_id,
        );
        expect(
          addedInferenceTurns.map((turn) => turn.provider_turn_id),
        ).toContain(owner?.provider_turn_id);
      }
      const recoveredNativeTurn = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeRequest.providerTurnId,
      );
      const recoveredNativeManifest = JSON.parse(
        recoveredNativeTurn?.manifest_json ?? "{}",
      ) as {
        inputFrontier?: {
          firstSequence: number | null;
          lastSequence: number | null;
        };
        contextRefs?: ReadonlyArray<string>;
      };
      expect(recoveredNativeManifest.inputFrontier).toEqual(
        nativeManifest.inputFrontier,
      );
      expect(recoveredNativeManifest.contextRefs).not.toContain(
        `session:InboxEntry:${filterEntryKey}`,
      );
      expect(recoveredNativeTurn?.portable_request_json).not.toContain(
        filterText,
      );
      expect(recoveredNativeTurn?.portable_request_json).not.toContain(
        filterEntryKey,
      );
      for (const checkpoint of recovered.checkpoints) {
        expect(checkpoint.payload_json).not.toContain(filterText);
        expect(checkpoint.payload_json).not.toContain(filterEntryKey);
      }
      expect(
        providerRequests.filter(
          (request) => request.providerTurnId === nativeRequest.providerTurnId,
        ),
      ).toHaveLength(nativeRequestCount);
      expect(
        readTypedSessionRows(fixture.databaseFile, project.rootSessionId),
      ).toContainEqual(
        expect.objectContaining({
          sequence: filterSequence,
          item_type: "UserMessage",
          source_ref: filterEntryKey,
        }),
      );
      if (boundary === "AH17AfterCheckpointEpochCommit") {
        const latestRecoveryCheckpoint = recovered.checkpoints.at(-1);
        if (latestRecoveryCheckpoint === undefined) {
          throw new Error("post-checkpoint Work summary checkpoint is absent");
        }
        const tailCheckpointSequence = latestRecoveryCheckpoint.sequence;
        let postCheckpointTailCount = typedRowsNow().filter(
          (row) => row.sequence > tailCheckpointSequence,
        ).length;
        for (
          let index = 0;
          postCheckpointTailCount < 71 && index < 24;
          index += 1
        ) {
          const before: Awaited<ReturnType<typeof currentWork>> =
            await waitForPublic(
              currentWork,
              (work) =>
                work?.workId === workId &&
                work.status === "Open" &&
                work.activeExecution === undefined,
              60_000,
            );
          if (before === null || before.workId !== workId) {
            throw new Error(
              "Work stopped being idle during post-checkpoint tail",
            );
          }
          const rowsBefore = typedRowsNow().length;
          const requestsBefore = providerRequests.length;
          await client.command(project.projectId, "SteerWork", {
            workId,
            workspaceId: project.rootWorkspaceId,
            expectedWorkRevision: before.revision,
            steer: {
              severity: "Normal",
              guidance: `AH19 post-checkpoint small typed tail ${index} ${"t".repeat(300)}`,
            },
            provenance: { source: "HumanInput" },
          });
          await waitForPublic(
            async () => ({
              work: await currentWork(),
              rows: typedRowsNow().length,
              requests: providerRequests.length,
            }),
            (state) =>
              state.work?.revision === before.revision + 1 &&
              state.work?.activeExecution === undefined &&
              state.rows > rowsBefore &&
              state.requests > requestsBefore,
            60_000,
          ).catch((error: unknown) => {
            throw ah19Failure("post-checkpoint tail steer", error);
          });
          postCheckpointTailCount = typedRowsNow().filter(
            (row) => row.sequence > tailCheckpointSequence,
          ).length;
          expect(postCheckpointTailCount).toBeLessThanOrEqual(71);
        }
        expect(postCheckpointTailCount).toBe(71);

        const p2Frontier = await readWorkFrontierThroughSessionRepository(
          fixture.databaseFile,
          project.rootSessionId,
        );
        expect(p2Frontier).toHaveLength(72);
        expect(p2Frontier[0]).toMatchObject({
          sequence: tailCheckpointSequence,
          payload: { _tag: "CompactionCheckpoint" },
        });
        const p2TailSequences = p2Frontier
          .slice(1)
          .map((entry) => entry.sequence);
        expect(p2TailSequences).toHaveLength(71);
        expect(p2TailSequences).toEqual(
          typedRowsNow()
            .filter((row) => row.sequence > tailCheckpointSequence)
            .map((row) => row.sequence),
        );

        const latestInference = providerRequests
          .filter((request) => request.operationKind === "Inference")
          .at(-1);
        if (latestInference === undefined) {
          throw new Error("post-checkpoint tail has no Work Inference request");
        }
        const latestExecutionId = readExecutionIdForProviderTurn(
          fixture.databaseFile,
          latestInference.providerTurnId,
        );
        const latestSnapshot = readSnapshot(fixture.databaseFile, {
          sessionId: project.rootSessionId,
          executionId: latestExecutionId,
          workId,
        });
        const latestTurn = latestSnapshot.providerTurns.find(
          (turn) => turn.provider_turn_id === latestInference.providerTurnId,
        );
        const latestManifest = JSON.parse(
          latestTurn?.manifest_json ?? "{}",
        ) as {
          resolvedModelBindingFingerprint?: string;
          controlBasis?: {
            projectPolicyRevision: number;
            workspacePolicyRevision: number;
            responsibilityRevision: number;
            resourceBoundaryRevision: number;
            workId?: string;
            workRevision?: number;
            authorizationDigest: string;
            environmentRevision: string;
          };
        };
        expect(latestManifest.resolvedModelBindingFingerprint).toMatch(
          /^p16fp_[0-9a-f]{64}$/u,
        );
        expect(latestManifest.controlBasis?.workId).toBe(workId);

        const actualWorkFrontier = await prepareActualWorkFrontier({
          executionId: latestExecutionId,
          sessionId: project.rootSessionId,
          workspaceId: project.rootWorkspaceId,
          workId,
          workRevision: latestManifest.controlBasis?.workRevision ?? 0,
          contextEpoch: latestSnapshot.session?.context_epoch ?? 0,
          bindingFingerprint:
            latestManifest.resolvedModelBindingFingerprint ?? "",
          controlBasis: latestManifest.controlBasis as NonNullable<
            typeof latestManifest.controlBasis
          >,
          entries: p2Frontier,
        });
        expect(actualWorkFrontier.projection.frontier).toEqual({
          firstSequence: tailCheckpointSequence,
          lastSequence: p2Frontier.at(-1)?.sequence,
        });
        expect(actualWorkFrontier.result).toMatchObject({
          _tag: "NeedsCompaction",
          reason: "BudgetPressure",
        });

        let observedCompaction: ProviderRunInput | undefined;
        let committedCheckpoint: unknown;
        const providerRuntime = {
          runTurn: (request: ProviderRunInput) => {
            observedCompaction = request;
            return Effect.succeed({
              attemptNo: 0,
              retryDecisions: [],
              events: [
                {
                  _tag: "ContinuationState" as const,
                  stateRef: "ah19-production-layer-tail-checkpoint",
                },
                {
                  _tag: "TurnCompleted" as const,
                  finishReason: "Stop" as const,
                },
              ],
            });
          },
        } as ProviderRuntimeService;
        const transaction = {
          transact: <A, E, R>(
            body: Effect.Effect<A, E, R | TransactionScope>,
          ) =>
            Effect.provideService(body, TransactionScope, {
              session: { id: "ah19-work-frontier-integration" },
            }),
        } as never;
        const sessionWriter = {
          commitCompaction: (_sessionId: unknown, commit: unknown) =>
            Effect.sync(() => {
              committedCheckpoint = commit;
              return {
                sequence: (p2Frontier.at(-1)?.sequence ?? 0) + 1,
                inserted: true,
                newEpoch: parse(ContextEpochNumber)(
                  (latestSnapshot.session?.context_epoch ?? 0) + 1,
                ),
              };
            }),
        } as never;
        const execution = {
          executionId: parse(ExecutionId)(latestExecutionId),
          projectId: parse(ProjectId)(project.projectId),
          workspaceId: parse(WorkspaceId)(project.rootWorkspaceId),
          binding: {
            _tag: "WorkspaceExecution" as const,
            workspaceId: parse(WorkspaceId)(project.rootWorkspaceId),
            focus: { _tag: "Coordination" as const },
          },
          sessionId: parse(SessionId)(project.rootSessionId),
          admittedAt: "ah19-work-frontier-integration",
          stopRequestedAt: null,
          state: { status: "Active" as const, settlement: null },
        };
        const compacted = await Effect.runPromise(
          runCompaction(
            {
              execution: execution as never,
              logicalStepNo: 0,
              currentEpoch: parse(ContextEpochNumber)(
                latestSnapshot.session?.context_epoch ?? 0,
              ),
              modelRef: "model-ah19-native-test",
              bindingFingerprint:
                latestManifest.resolvedModelBindingFingerprint ?? "",
              inputFrontier: actualWorkFrontier.projection.frontier,
              contextRefs: actualWorkFrontier.projection.contextRefs,
              inputItems: actualWorkFrontier.projection.inputItems,
              fence: {
                executionId: parse(ExecutionId)(latestExecutionId),
                workerId: "ah19-work-frontier-integration",
                workerIncarnationId: "ah19-work-frontier-integration",
                fencingGeneration: 0 as never,
              },
              nativeSupported: true,
            },
            {
              providerRuntime,
              sessions: sessionWriter,
              tx: transaction,
            },
          ),
        );
        expect(compacted.newEpoch).toBe(
          (latestSnapshot.session?.context_epoch ?? 0) + 1,
        );
        expect(observedCompaction?.request).toMatchObject({
          operationKind: "CompactionNative",
          inputItems: actualWorkFrontier.projection.inputItems,
        });
        expect(
          JSON.parse(observedCompaction?.manifestJson ?? "{}"),
        ).toMatchObject({
          inputFrontier: actualWorkFrontier.projection.frontier,
          contextRefs: actualWorkFrontier.projection.contextRefs,
        });
        expect(committedCheckpoint).toMatchObject({
          checkpoint: {
            _tag: "CompactionCheckpoint",
            implementation: "ProviderNative",
          },
          expectedEpoch: latestSnapshot.session?.context_epoch,
          nextEpoch: (latestSnapshot.session?.context_epoch ?? 0) + 1,
        });
        expect(
          readTypedSessionRows(
            fixture.databaseFile,
            project.rootSessionId,
          ).filter((row) => row.sequence > tailCheckpointSequence),
        ).toHaveLength(71);
      }
      expect(fixture.daemonErrors).toEqual([]);
    },
    360_000,
  );
});
