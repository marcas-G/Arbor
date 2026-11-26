import { afterEach, describe, expect, it } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah19Probe,
  type Ah19ProviderRequest,
  type ApprovedWorkSeed,
  ah19AfterEach,
  ah19Failure,
  approvedRootWorkReply,
  beginAh19PhaseDiagnostics,
  fixtures,
  probes,
  providerRequests,
  readAllWorkTimelineRows,
  readExecutionIdForProviderTurn,
  readRootSeedDiagnosticSnapshot,
  readSnapshot,
  readToolCallOwners,
  readTypedSessionRows,
  recordAh19Phase,
  recordAh19StartupOutput,
  seedRootWorkViaPublicApproval,
  startAtCheckpointBoundary,
  startReportServer,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 ProviderNative binding recovery", () => {
  it("enters ordinary Native compaction from public Work Session history", async () => {
    probes.length = 0;
    providerRequests.length = 0;
    const reportUrl = await startReportServer();
    const seedMarker = `AH19-WORK-HISTORY-${crypto.randomUUID()}`;
    const diagnostic = beginAh19PhaseDiagnostics(
      "enters ordinary Native compaction from public Work Session history",
      seedMarker,
    );
    const workSeed: ApprovedWorkSeed = {
      objective: `Build real Workspace Session history through public Work input. ${seedMarker}`,
      why: "qualify ordinary Native compaction after repeated Work turns",
      constraints: [],
      completionExpectation: "history is projected into the next Agent turn",
      verificationMission: {
        goal: "observe ordinary Work history compaction",
        criteria: [
          {
            criterionId: "history-compaction",
            requirement: "older Session history reaches context planning",
            required: true,
          },
        ],
        riskRequirements: [],
      },
    };
    const childOutput: string[] = [];
    const rootReply = approvedRootWorkReply(seedMarker, workSeed);
    const fixture = await startProductionFixture({
      reply: (call, index) => {
        const tools = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          tools.has("claim_completion") &&
          tools.has("wait") &&
          JSON.stringify(call.messages).includes(workSeed.objective)
        ) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              disposition: "Yielded",
              reason: "retain AH19 ordinary Work history",
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            },
          };
        }
        return rootReply(call, index);
      },
      daemonEnvironment: {
        ARBOR_AH19_REPORT_URL: reportUrl,
        ARBOR_AH19_STARTUP_TRACE: "1",
      },
      onDaemonStdout: (line) => {
        childOutput.push(line);
        recordAh19StartupOutput(line);
        if (line.includes("AH19_CHILD_START"))
          recordAh19Phase("child START", line);
        if (/listening|LISTEN/iu.test(line))
          recordAh19Phase("child LISTEN", line);
        try {
          const event = JSON.parse(line) as Ah19Probe;
          if (event.tag === "AH19_PROBE") probes.push(event);
        } catch {
          // Preserve other daemon output in fixture diagnostics.
        }
      },
    });
    fixtures.push(fixture);
    diagnostic.attach(fixture, childOutput);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH19 ordinary Work history",
    );
    const workId = await seedRootWorkViaPublicApproval(
      fixture,
      client,
      project,
      seedMarker,
      workSeed,
      {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CONTEXT_WINDOW: "16384",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    );
    diagnostic.phase("Work seed public step complete", { workId });
    const ordinaryWorkNative = (request: Ah19ProviderRequest) =>
      request.operationKind === "CompactionNative" &&
      request.hasPublicWorkInput === true;

    for (let index = 0; index < 10; index += 1) {
      const observed = await waitForPublic(
        async () => ({
          native: providerRequests.find(ordinaryWorkNative),
          current: await client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        }),
        (state) =>
          state.native !== undefined ||
          (state.current?.workId === workId && state.current.status === "Open"),
        60_000,
      );
      if (observed.native !== undefined) break;
      diagnostic.phase("Work remains Open; steer public history", {
        turn: index,
        revision: observed.current?.revision,
        providerRequests: providerRequests.length,
      });
      if (observed.current?.workId !== workId) {
        throw new Error(
          "public Work stopped being current during history fixture",
        );
      }
      const before = providerRequests.length;
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: observed.current.revision,
        steer: {
          severity: "Normal",
          guidance: `AH19 public Work history turn ${index}: ${"bounded retained Work history ".repeat(200)}`,
        },
        provenance: { source: "HumanInput" },
      });
      await waitForPublic(
        async () => ({
          requests: providerRequests.slice(before),
          native: providerRequests.find(ordinaryWorkNative),
        }),
        (state) =>
          state.native !== undefined ||
          state.requests.some(
            (request) =>
              request.operationKind === "Inference" &&
              request.hasPublicWorkInput === true,
          ),
        60_000,
      ).catch((error: unknown) => {
        throw ah19Failure(
          `public Work history turn ${index}; snapshot=${JSON.stringify(
            readRootSeedDiagnosticSnapshot(fixture.databaseFile, project),
          )}`,
          error,
        );
      });
      if (providerRequests.some(ordinaryWorkNative)) {
        break;
      }
    }
    const ordinaryNative = providerRequests.find(ordinaryWorkNative);
    diagnostic.phase("Native request observed", {
      providerTurnId: ordinaryNative?.providerTurnId,
      operationKind: ordinaryNative?.operationKind,
    });
    expect(
      providerRequests.some((request) => request.operationKind === "Inference"),
    ).toBe(true);
    expect(ordinaryNative).toBeDefined();
    expect(ordinaryNative?.providerTurnId).toMatch(/_native_compact_0$/u);
    expect(ordinaryNative?.providerTurnId).not.toContain("_overflow_");
    expect(ordinaryNative?.hasPublicWorkInput).toBe(true);
    const ordinaryNativeSessionRows = readTypedSessionRows(
      fixture.databaseFile,
      project.rootSessionId,
    );
    expect(
      ordinaryNativeSessionRows.some((row) =>
        ["ToolCall", "ToolResult", "ControlResult"].includes(row.item_type),
      ),
    ).toBe(true);
    const executionId = readExecutionIdForProviderTurn(
      fixture.databaseFile,
      ordinaryNative?.providerTurnId ?? "",
    );
    expect(
      ordinaryNative?.workActionHistoryCount,
      JSON.stringify({
        ordinaryNative: {
          ...ordinaryNative,
          items: ordinaryNative?.items.map(
            ({ _tag, providerTurnId, callRef, role }) => ({
              _tag,
              providerTurnId,
              callRef,
              role,
            }),
          ),
        },
        providerRequests: providerRequests.map(
          ({
            operationKind,
            providerTurnId,
            workActionHistoryCount,
            hasPublicWorkInput,
            items,
          }) => ({
            operationKind,
            providerTurnId,
            workActionHistoryCount,
            hasPublicWorkInput,
            items: items.map(({ _tag, providerTurnId: itemTurn, callRef }) => ({
              _tag,
              providerTurnId: itemTurn,
              callRef,
            })),
          }),
        ),
        sessionRows: ordinaryNativeSessionRows.map(
          ({
            sequence,
            item_type,
            source_kind,
            source_ref,
            causal_binding_json,
          }) => ({
            sequence,
            item_type,
            source_kind,
            source_ref,
            causal_binding_json,
          }),
        ),
      }),
    ).toBeGreaterThan(0);
    const nativeActionItems =
      ordinaryNative?.items.filter((item) =>
        ["ToolCall", "ToolResult", "ControlResult"].includes(item._tag),
      ) ?? [];
    const nativeCallItems = nativeActionItems.filter(
      (item) => item._tag === "ToolCall",
    );
    expect(nativeCallItems.length).toBeGreaterThan(0);
    const currentCallRefs = new Set(
      nativeCallItems
        .map((item) => item.callRef)
        .filter((callRef): callRef is string => callRef !== undefined),
    );
    const toolCallOwners = readToolCallOwners(
      fixture.databaseFile,
      project.rootSessionId,
      [...currentCallRefs],
    );
    expect(toolCallOwners).toHaveLength(currentCallRefs.size);
    expect(
      toolCallOwners.every(
        (owner) =>
          owner.work_id === workId && owner.episode_binding === "WorkEpisode",
      ),
      JSON.stringify(toolCallOwners),
    ).toBe(true);
    expect(
      nativeActionItems
        .filter((item) => item._tag !== "ToolCall")
        .every(
          (item) =>
            item.callRef !== undefined && currentCallRefs.has(item.callRef),
        ),
    ).toBe(true);
    const snapshot = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(
      snapshot.sessionEntries.some((entry) =>
        entry.payload_json.includes("AH19 public Work history"),
      ),
    ).toBe(true);
    expect(
      snapshot.providerLinks.some((link) => link.role === "OverflowCompaction"),
    ).toBe(false);
    const nativeTurn = snapshot.providerTurns.find(
      (turn) => turn.provider_turn_id === ordinaryNative?.providerTurnId,
    );
    const nativeManifest = JSON.parse(nativeTurn?.manifest_json ?? "{}") as {
      sourceAgentLoopStep?: {
        executionId?: string;
        logicalStepNo?: number;
        repairAttempt?: number;
        providerTurnId?: string;
      };
      inputFrontier?: {
        firstSequence?: number | null;
        lastSequence?: number | null;
      };
    };
    const checkpointSequence = Math.min(
      ...snapshot.checkpoints.map((checkpoint) => checkpoint.sequence),
    );
    const preCheckpointTypedRows = readAllWorkTimelineRows(
      fixture.databaseFile,
      project.rootSessionId,
    ).filter((entry) => entry.sequence < checkpointSequence);
    const firstSequence = nativeManifest.inputFrontier?.firstSequence;
    const lastSequence = nativeManifest.inputFrontier?.lastSequence;
    expect(typeof firstSequence).toBe("number");
    expect(typeof lastSequence).toBe("number");
    expect(Number(firstSequence)).toBeLessThanOrEqual(Number(lastSequence));
    expect(Number(lastSequence)).toBeLessThan(checkpointSequence);
    expect(
      preCheckpointTypedRows.some(
        (entry) => entry.sequence === Number(firstSequence),
      ),
    ).toBe(true);
    expect(
      preCheckpointTypedRows.some(
        (entry) => entry.sequence === Number(lastSequence),
      ),
    ).toBe(true);
    expect(
      preCheckpointTypedRows.filter(
        (entry) =>
          entry.sequence >= Number(firstSequence) &&
          entry.sequence <= Number(lastSequence),
      ).length,
    ).toBeLessThanOrEqual(64);
    const sourceAgentLoopStep = nativeManifest.sourceAgentLoopStep;
    expect(sourceAgentLoopStep?.executionId).toBe(executionId);
    expect(sourceAgentLoopStep?.logicalStepNo).toEqual(expect.any(Number));
    expect(sourceAgentLoopStep?.repairAttempt).toBe(0);
    const sourceStep = snapshot.steps.find(
      (step) =>
        step.logical_step_no === sourceAgentLoopStep?.logicalStepNo &&
        step.repair_attempt === sourceAgentLoopStep.repairAttempt,
    );
    expect(sourceStep).toBeDefined();
    expect(sourceAgentLoopStep?.providerTurnId).toBe(
      sourceStep?.provider_turn_id,
    );

    const replacementInferenceId = ordinaryNative?.providerTurnId.replace(
      "_native_compact_0",
      "",
    );
    const resumedInference = await waitForPublic(
      async () =>
        providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.providerTurnId === replacementInferenceId &&
            request.items.some(
              (item) =>
                item._tag === "CompactionCheckpoint" &&
                item.implementation === "ProviderNative",
            ),
        ),
      (request) => request !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw ah19Failure("Native checkpoint inference after compaction", error);
    });
    expect(resumedInference?.workActionHistoryCount).toBe(0);
    expect(resumedInference?.items).toContainEqual(
      expect.objectContaining({
        _tag: "CompactionCheckpoint",
        implementation: "ProviderNative",
        opaqueItemRef: `ah19-opaque:${ordinaryNative?.providerTurnId}`,
      }),
    );
    const successorState = await waitForPublic(
      async () => ({
        request: providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.providerTurnId === `ptn_${executionId}_1`,
        ),
        snapshot: readSnapshot(fixture.databaseFile, {
          sessionId: project.rootSessionId,
          executionId,
          workId,
        }),
      }),
      (state) =>
        state.request !== undefined ||
        state.snapshot.steps.some(
          (step) =>
            step.logical_step_no === 1 && step.state === "SettlementProposed",
        ),
      45_000,
    ).catch((error: unknown) => {
      throw ah19Failure("successor Inference after Native checkpoint", error);
    });
    expect(successorState.request).toBeDefined();
    expect(
      providerRequests.filter(
        (request) => request.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);
  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "persists one real ProviderNative checkpoint at %s",
    async (boundary) => {
      const scenario = await startAtCheckpointBoundary(boundary);
      const { fixture, project, workId, probe } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(probe.providerTurnId).toBe(nativeTurnId);
      expect(beforeKill.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.providerTurns).toHaveLength(3);
      const nativeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(nativeTurn).toMatchObject({
        execution_id: executionId,
        session_id: project.rootSessionId,
        context_epoch: 0,
        settled_at: expect.any(String),
        finish_reason: "Stop",
        manifest_json: expect.any(String),
      });
      expect(JSON.parse(nativeTurn?.manifest_json ?? "{}")).toMatchObject({
        operationKind: "CompactionNative",
        resolvedModelBindingFingerprint:
          expect.stringMatching(/^p16fp_[0-9a-f]{64}$/u),
        inputFrontier: {
          firstSequence: expect.any(Number),
          lastSequence: expect.any(Number),
        },
        contextRefs: expect.arrayContaining([expect.any(String)]),
      });
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(providerRequests.map((event) => event.operationKind)).toEqual([
        "Inference",
        "Inference",
        "CompactionNative",
      ]);
      expect(beforeKill.steps).toEqual([
        expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
        expect.objectContaining({ logical_step_no: 1, repair_attempt: 0 }),
      ]);
      expect(
        beforeKill.sessionEntries.some((entry) =>
          entry.payload_json.includes("preserve-portable-frontier"),
        ),
      ).toBe(true);

      if (boundary === "AH17AfterCheckpointEpochCommit") {
        const checkpoint = JSON.parse(
          beforeKill.checkpoints[0]?.payload_json ?? "{}",
        ) as Record<string, unknown>;
        expect(checkpoint).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          fromEpoch: 0,
          toEpoch: 1,
          opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
          bindingFingerprint: JSON.parse(nativeTurn?.manifest_json ?? "{}")
            .resolvedModelBindingFingerprint,
        });
      }
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});
