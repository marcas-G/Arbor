import { expect } from "vitest";
import { startProductionFixture } from "../../../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../../../support/public-client.js";
import {
  type Ah19Probe,
  type Ah19ProviderRequest,
  activePhaseDiagnostic,
  beginAh19PhaseDiagnostics,
  childEntry,
  fixtures,
  parseAh19HandshakeState,
  persistAh19StartupRecord,
  probes,
  providerRequests,
  recordAh19Phase,
  recordAh19StartupOutput,
  startReportServer,
} from "./diagnostics.js";
import {
  ah19WorkSeed,
  approvedRootWorkReply,
  holdFirstWorkProviderRequest,
  type RootSeedDiagnostics,
  type RootSeedProviderDecision,
  seedRootWorkViaPublicApproval,
} from "./seed.js";
import {
  readConversationHistoryEvidence,
  readExecutionIdForProviderTurn,
  readSnapshot,
} from "./snapshot.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export const startAtCheckpointBoundary = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit"
    | "AH19BeforeConversationCheckpointOwnerCommit"
    | "AH19AfterConversationCheckpointOwnerCommit"
    | "AH12BeforeSuccessCommit"
    | "AH11AfterStepEffectsCommit",
  extraDaemonEnvironment: Readonly<Record<string, string>> = {},
  episode: "Work" | "ConversationResponse" = "Work",
  traceStartup = true,
) => {
  if (activePhaseDiagnostic === undefined) {
    beginAh19PhaseDiagnostics(
      `AH19 checkpoint-boundary startup ${boundary}`,
      boundary,
    );
  }
  probes.length = 0;
  providerRequests.length = 0;
  const reportUrl = await startReportServer();
  const workMarker = `AH19-CHECKPOINT-${crypto.randomUUID()}`;
  const workSeed = ah19WorkSeed(
    "Qualify a deployment-bound ProviderNative checkpoint.",
    workMarker,
    "exercise AH19 Native binding qualification",
    ["never reuse opaque continuation across deployments"],
  );
  const heldWorkRequest =
    episode === "Work" ? holdFirstWorkProviderRequest(workSeed) : undefined;
  const childOutput: string[] = [];
  const fixture = await startProductionFixture({
    reply:
      episode === "Work"
        ? approvedRootWorkReply(workMarker, workSeed)
        : () => ({ _tag: "HttpError", status: 500 }),
    ...(heldWorkRequest === undefined
      ? {}
      : { beforeResponse: heldWorkRequest.beforeResponse }),
    daemonEnvironment: {
      ARBOR_AH19_REPORT_URL: reportUrl,
      ...(traceStartup ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
    },
    onDaemonStdout: (line) => {
      childOutput.push(line);
      recordAh19StartupOutput(line);
      if (line.includes("AH19_CHILD_START")) recordAh19Phase("child START");
      if (/listening|LISTEN/iu.test(line)) recordAh19Phase("child LISTEN");
      try {
        const event = JSON.parse(line) as Ah19Probe;
        if (event.tag === "AH19_PROBE") probes.push(event);
      } catch {
        // Preserve other daemon output in fixture diagnostics.
      }
    },
  }).catch((error: unknown) => {
    const observedChildPhases = childOutput.flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return typeof event.tag === "string" &&
          (event.tag.startsWith("FUNCTIONAL_DAEMON_") ||
            event.tag === "AH19_STARTUP_PHASE")
          ? [event.tag]
          : [];
      } catch {
        return [];
      }
    });
    persistAh19StartupRecord({
      kind: "startup-failure",
      boundary: "fixture-startup",
      process: parseAh19HandshakeState(error) ?? null,
      persistedState: "fresh cloned schema; public project setup not reached",
    });
    throw new Error(
      `AH19 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; childPhases=${observedChildPhases.join("|")}`,
    );
  });
  if (activePhaseDiagnostic !== undefined) {
    activePhaseDiagnostic.fixture = fixture;
    activePhaseDiagnostic.childOutput = childOutput;
  }
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH19 ProviderNative binding ${boundary}`,
  );
  const ah19DaemonEnvironment = {
    ARBOR_AH19_BOUNDARY: boundary,
    ARBOR_AH19_BINDING_VARIANT: "A",
    ARBOR_AH19_REPORT_URL: reportUrl,
    ...(traceStartup ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
    ...(episode === "ConversationResponse"
      ? { ARBOR_AH19_TERMINAL_CONVERSATION: "1" }
      : {}),
    ...extraDaemonEnvironment,
  };
  let workId: string;
  let conversationSeedBody: string | undefined;
  let conversationCurrentBody: string | undefined;
  if (episode === "Work") {
    workId = await seedRootWorkViaPublicApproval(
      fixture,
      client,
      project,
      workMarker,
      workSeed,
      ah19DaemonEnvironment,
      heldWorkRequest,
    );
  } else {
    workId = functionalId("wrk");
    conversationSeedBody = `AH19 answered history source ${crypto.randomUUID()}`;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
        ...(traceStartup ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
        ARBOR_AH19_CONVERSATION_SEED: "1",
      },
    });
    await submitHumanMessage(client, project, conversationSeedBody);
    const answeredSeed = await waitForPublic(
      async () =>
        readConversationHistoryEvidence(fixture.databaseFile, {
          rootWorkspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
        }),
      (evidence) => {
        const seed = evidence.messages.find(
          (message) => message.body_ref === conversationSeedBody,
        );
        const job = evidence.jobs.find(
          (candidate) => candidate.message_id === seed?.message_id,
        );
        const attempt = evidence.attempts.find(
          (candidate) => candidate.message_id === seed?.message_id,
        );
        const execution = evidence.executions.find(
          (candidate) => candidate.execution_id === attempt?.execution_id,
        );
        return (
          seed !== undefined &&
          job?.state === "Answered" &&
          job.response_body !== null &&
          job.response_execution_id === attempt?.execution_id &&
          attempt?.settled_at !== null &&
          attempt?.settlement_kind === "Completed" &&
          execution !== undefined &&
          execution.settled_at !== null &&
          execution.settlement_kind === "Completed" &&
          execution.settlement_json?.includes(
            "ConversationResponseProduced",
          ) === true &&
          evidence.assistantEntries.some((entry) =>
            entry.payload_json.includes(
              "AH19 answered conversation history source",
            ),
          )
        );
      },
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 conversation seed did not settle: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.filter((line) => line.includes("AH19_CHILD_")).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; process=${JSON.stringify(fixture.daemonProcessSnapshot())}`,
      );
    });
    expect(answeredSeed.messages).toHaveLength(1);
    expect(answeredSeed.jobs).toHaveLength(1);
    expect(answeredSeed.jobs[0]).toMatchObject({ state: "Answered" });
    expect(answeredSeed.attempts).toEqual([
      expect.objectContaining({ settlement_kind: "Completed" }),
    ]);
    expect(answeredSeed.executions).toEqual([
      expect.objectContaining({ settlement_kind: "Completed" }),
    ]);
    expect(
      answeredSeed.assistantEntries.some((entry) =>
        entry.payload_json.includes(
          "AH19 answered conversation history source",
        ),
      ),
    ).toBe(true);
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: ah19DaemonEnvironment,
    });
    conversationCurrentBody = `AH19 terminal response ${crypto.randomUUID()}`;
    await submitHumanMessage(client, project, conversationCurrentBody);
  }
  const probe = await waitForPublic(
    async () => {
      if (boundary !== "AH12BeforeSuccessCommit") {
        return probes.find((entry) => entry.boundary === boundary);
      }
      const request = providerRequests.find(
        (event) => event.operationKind === "CompactionNative",
      );
      if (request === undefined) return undefined;
      const executionId = readExecutionIdForProviderTurn(
        fixture.databaseFile,
        request.providerTurnId,
      );
      const snapshot = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      const turn = snapshot.providerTurns.find(
        (row) => row.provider_turn_id === request.providerTurnId,
      );
      const attempts = snapshot.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === request.providerTurnId,
      );
      const attempt = attempts[0];
      let events: Array<Record<string, unknown>> = [];
      let observation: Record<string, unknown> = {};
      try {
        events = JSON.parse(
          attempt?.canonical_event_prefix_json ?? "[]",
        ) as Array<Record<string, unknown>>;
        observation = JSON.parse(attempt?.observation_json ?? "{}") as Record<
          string,
          unknown
        >;
      } catch {
        return undefined;
      }
      const continuationEvents = events.filter(
        (event) => event._tag === "ContinuationState",
      );
      if (
        turn?.settled_at === null &&
        turn.output_contract_ref === "provider-native-compaction-v1" &&
        attempts.length === 1 &&
        attempt?.outcome === "InProgress" &&
        attempt.delivered_position === 0 &&
        attempt.continuation_checkpoint_json === null &&
        events[0]?._tag === "TurnStarted" &&
        events[0].providerTurnId === request.providerTurnId &&
        events[0].attemptNo === 0 &&
        continuationEvents.length === 1 &&
        continuationEvents[0]?.stateRef ===
          `ah19-opaque:${request.providerTurnId}` &&
        events.at(-1)?._tag === "TurnCompleted" &&
        events.at(-1)?.finishReason === "Stop" &&
        observation.responseStarted === true &&
        observation.canonicalEventEmitted === true &&
        observation.consumerVisibleOutput === false &&
        observation.toolCallProposed === false &&
        observation.continuationAvailable === true &&
        observation.externalEffectPossible === false
      ) {
        return {
          tag: "AH19_PROBE" as const,
          boundary,
          providerTurnId: request.providerTurnId,
          executionId,
        };
      }
      return undefined;
    },
    (entry) => entry !== undefined,
    60_000,
  ).catch((error: unknown) => {
    const latestNativeRequest = providerRequests
      .filter((event) => event.operationKind === "CompactionNative")
      .at(-1);
    const boundarySnapshot =
      latestNativeRequest === undefined
        ? undefined
        : readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId: readExecutionIdForProviderTurn(
              fixture.databaseFile,
              latestNativeRequest.providerTurnId,
            ),
            workId,
          });
    const latestNativeRow = boundarySnapshot?.providerTurns.find(
      (row) => row.provider_turn_id === latestNativeRequest?.providerTurnId,
    );
    let latestNativeIdentity: unknown;
    try {
      latestNativeIdentity = (
        JSON.parse(latestNativeRow?.manifest_json ?? "{}") as Record<
          string,
          unknown
        >
      ).sourceAgentLoopStep;
    } catch {
      latestNativeIdentity = "invalid";
    }
    throw new Error(
      `AH19 checkpoint boundary missing ${boundary}: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; providerRequests=${JSON.stringify(providerRequests)}; nativeSourceIdentity=${JSON.stringify(latestNativeIdentity)}; session=${JSON.stringify(boundarySnapshot?.session)}; checkpoints=${JSON.stringify(boundarySnapshot?.checkpoints)}; steps=${JSON.stringify(boundarySnapshot?.steps)}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (probe === undefined) throw new Error("AH19 checkpoint probe missing");
  const executionId =
    probe.executionId ??
    readExecutionIdForProviderTurn(fixture.databaseFile, probe.providerTurnId);
  if (
    episode === "ConversationResponse" &&
    conversationSeedBody !== undefined &&
    conversationCurrentBody !== undefined
  ) {
    const evidence = readConversationHistoryEvidence(fixture.databaseFile, {
      rootWorkspaceId: project.rootWorkspaceId,
      sessionId: project.rootSessionId,
    });
    const seed = evidence.messages.find(
      (message) => message.body_ref === conversationSeedBody,
    );
    const current = evidence.messages.find(
      (message) => message.body_ref === conversationCurrentBody,
    );
    const seedJob = evidence.jobs.find(
      (job) => job.message_id === seed?.message_id,
    );
    const currentJob = evidence.jobs.find(
      (job) => job.message_id === current?.message_id,
    );
    expect(seed).toBeDefined();
    expect(current).toMatchObject({ state: "Pending" });
    expect(seed?.message_id).not.toBe(current?.message_id);
    expect(seedJob).toMatchObject({ state: "Answered" });
    expect(currentJob).toMatchObject({
      state: "Running",
      active_execution_id: executionId,
    });
    expect(evidence.messages).toHaveLength(2);
    expect(evidence.jobs).toHaveLength(2);
  }
  return {
    fixture,
    project,
    workId,
    probe: { ...probe, executionId },
    reportUrl,
    childOutput,
  };
};

export const startOrdinaryNativeAtCheckpointBoundary = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit",
  traceStartup = true,
) => {
  if (activePhaseDiagnostic === undefined) {
    beginAh19PhaseDiagnostics(
      `AH19 ordinary Native startup ${boundary}`,
      boundary,
    );
  }
  probes.length = 0;
  providerRequests.length = 0;
  const reportUrl = await startReportServer();
  const workMarker = `AH19-ORDINARY-${crypto.randomUUID()}`;
  const workSeed = ah19WorkSeed(
    "Build public Work history for ordinary Native recovery.",
    workMarker,
    "qualify ordinary Native checkpoint recovery",
  );
  const childOutput: string[] = [];
  const providerDecisions: RootSeedProviderDecision[] = [];
  const responsesSent: Array<RootSeedDiagnostics["responsesSent"][number]> = [];
  const rootReply = approvedRootWorkReply(workMarker, workSeed, (decision) =>
    providerDecisions.push(decision),
  );
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
            reason: "retain AH19 ordinary recovery history",
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
          },
        };
      }
      return rootReply(call, index);
    },
    ...(process.env.ARBOR_AH19_PRESERVE_FAILURE_FIXTURES === "1"
      ? { preserveDirectoryOnStop: true }
      : {}),
    onResponseSent: (call, index) =>
      responsesSent.push({ index, request: call }),
    daemonEnvironment: {
      ARBOR_AH19_REPORT_URL: reportUrl,
      ...(traceStartup ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
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
  }).catch((error: unknown) => {
    if (traceStartup) {
      persistAh19StartupRecord({
        kind: "startup-failure",
        boundary: "fixture-startup",
        process: parseAh19HandshakeState(error) ?? null,
        persistedState: "fresh cloned schema; public project setup not reached",
      });
    }
    throw error;
  });
  if (activePhaseDiagnostic !== undefined) {
    activePhaseDiagnostic.fixture = fixture;
    activePhaseDiagnostic.childOutput = childOutput;
  }
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH19 ordinary Native recovery ${boundary}`,
  );
  const workId = await seedRootWorkViaPublicApproval(
    fixture,
    client,
    project,
    workMarker,
    workSeed,
    {
      ARBOR_AH19_BOUNDARY: boundary,
      ARBOR_AH19_BINDING_VARIANT: "A",
      ARBOR_AH19_ORDINARY_WORK: "1",
      ARBOR_AH19_CONTEXT_WINDOW: "16384",
      ARBOR_AH19_REPORT_URL: reportUrl,
      ...(traceStartup ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
    },
    undefined,
    {
      providerDecisions,
      responsesSent,
      daemonStdout: childOutput,
    },
  );
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
      (state) => state.native !== undefined || state.current?.status === "Open",
      60_000,
    );
    if (observed.native !== undefined) break;
    if (observed.current?.workId !== workId)
      throw new Error("ordinary Work ceased to be current");
    const beforeSteer = providerRequests.length;
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: observed.current.revision,
      steer: {
        severity: "Normal",
        guidance: `AH19 ordinary recovery history ${index}: ${"bounded retained Work history ".repeat(200)}`,
      },
      provenance: { source: "HumanInput" },
    });
    await waitForPublic(
      async () => ({
        requests: providerRequests.slice(beforeSteer),
        native: providerRequests.find(ordinaryWorkNative),
      }),
      (state) =>
        state.native !== undefined ||
        state.requests.some(
          (request) =>
            request.operationKind === "Inference" &&
            request.hasPublicWorkInput === true,
        ),
      120_000,
    ).catch((error: unknown) => {
      throw new Error(
        `ordinary Native did not advance after SteerWork ${index}: before=${beforeSteer}, current=${JSON.stringify(observed.current)}, requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, workActionHistoryCount }) => ({ operationKind, providerTurnId, workActionHistoryCount })))}; ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  const probe = await waitForPublic(
    async () => probes.find((event) => event.boundary === boundary),
    (event) => event !== undefined,
    60_000,
  );
  if (probe === undefined)
    throw new Error(`ordinary Native boundary missing: ${boundary}`);
  const native = providerRequests.find(ordinaryWorkNative);
  if (native === undefined) throw new Error("ordinary Native request missing");
  return { fixture, project, workId, probe, native, reportUrl, childOutput };
};
