import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../support/lease-qualification.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10Probe,
  ah10Child,
  fixtures,
  manualWait,
  pushProbe,
  readAh10Rows,
  releaseGate,
} from "./support.js";

export const ah10GenRecoverCommittedDeliverableReceipt =
  async (): Promise<void> => {
    const phaseStartedAt = Date.now();
    const markPhase = (phase: string) =>
      console.info(
        `[AH10 committed Deliverable] ${phase} +${Date.now() - phaseStartedAt}ms`,
      );
    const marker = `AH10-pending-${crypto.randomUUID().slice(0, 8)}`;
    const events: Ah10Probe[] = [];
    let probeArmed = false;
    let seedWaitIssued = false;
    let targetProviderCalls = 0;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          !available.has("claim_completion") &&
          available.has("assign_work")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Parent Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Exercise pending action takeover ${marker}.`,
                  why: "qualify canonical receipt recovery before Action result commit",
                  constraints: [],
                  completionExpectation:
                    "the pinned action commits one Deliverable",
                  verificationMission: {
                    goal: `Verify AH10 pending Action ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-pending-action",
                        requirement:
                          "the source Work remains open during takeover",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (context.includes(marker) && available.has("produce_deliverable")) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(
              `AH10 seed Work waits for pending receipt probe ${marker}`,
            );
          }
          targetProviderCalls += 1;
          return {
            _tag: "ToolCall",
            name: "produce_deliverable",
            arguments: { kind: "report", artifacts: [] },
          };
        }
        return { _tag: "HttpError", status: 422 };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    markPhase("schema44 fixture and primary daemon ready");
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed receipt pending-action recovery",
    );
    markPhase("public project created");
    const sourceWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please create the pending AH10 Work ${marker}.`,
    );
    markPhase("source Work publicly admitted");
    const sourceWorkId = sourceWork.workId;
    const seedWorkAtWait = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        seedWaitIssued &&
        work?.workId === sourceWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedWorkAtWait === null || seedWorkAtWait.workId !== sourceWorkId) {
      throw new Error("AH10 pending seed Work did not reach Manual wait");
    }
    expect(seedWorkAtWait.revision).toBe(0);
    await fixture.crash();
    markPhase("seed daemon stopped");
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
      },
    });
    markPhase("gen0 daemon restarted");
    await client.command(project.projectId, "SteerWork", {
      workId: sourceWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedWorkAtWait.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume pending AH10 Work ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const actionIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (actionIntent === undefined) {
      throw new Error("AH10 initial Action intent probe was absent");
    }
    markPhase("gen0 action intent committed");
    releaseGate(fixture, "old", "action-intent");

    const afterControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      5_000,
    );
    if (afterControlReturn === undefined) {
      throw new Error("AH10 post-control-return probe was absent");
    }
    markPhase("Deliverable Gateway command returned before Observation");
    const beforeCrash = readAh10Rows(fixture.databaseFile);
    const committedBeforeCrash = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        readonly sourceWorkId?: string;
        readonly kind?: string;
      };
      return result.sourceWorkId === sourceWorkId && result.kind === "report";
    });
    expect(committedBeforeCrash).toHaveLength(1);
    expect(beforeCrash.deliverables).toHaveLength(1);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: actionIntent.executionId,
        provider_turn_id: actionIntent.providerTurnId,
        logical_action_id: actionIntent.logicalActionId,
        call_ref: actionIntent.callRef,
        action_kind: "produce_deliverable",
        state: "Pending",
      }),
    );
    expect(
      beforeCrash.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${actionIntent.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    markPhase("gen0 crashed after committed receipt");
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: actionIntent.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
    markPhase("gen0 lease expired");
    const recoveryDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    markPhase("gen1 recovery daemon ready");
    const recoveredLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === actionIntent.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(recoveredLease?.fencingGeneration).toBe(1);
    markPhase("gen1 acquired lease");
    const recoveredIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredIntent?.providerTurnId).toBe(actionIntent.providerTurnId);
    expect(recoveredIntent?.callRef).toBe(actionIntent.callRef);
    expect(recoveredIntent?.logicalActionId).toBe(actionIntent.logicalActionId);
    markPhase("gen1 recovered original Action identity");
    releaseGate(fixture, "new", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionResultCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH10 gen-1 action result did not commit: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readAh10Rows(fixture.databaseFile))}; providerCalls=${fixture.providerCalls.length}; daemonErrors=${recoveryDaemon.daemonErrors.join(" | ")}`,
      );
    });
    markPhase("gen1 Action result committed");

    const recovered = readAh10Rows(fixture.databaseFile);
    const committedAfterRecovery = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        readonly sourceWorkId?: string;
        readonly kind?: string;
      };
      return result.sourceWorkId === sourceWorkId && result.kind === "report";
    });
    expect(committedAfterRecovery).toHaveLength(1);
    expect(committedAfterRecovery[0]?.command_id).toBe(
      committedBeforeCrash[0]?.command_id,
    );
    expect(recovered.deliverables).toHaveLength(1);
    expect(recovered.actions).toContainEqual(
      expect.objectContaining({
        execution_id: actionIntent.executionId,
        provider_turn_id: actionIntent.providerTurnId,
        logical_action_id: actionIntent.logicalActionId,
        call_ref: actionIntent.callRef,
        action_kind: "produce_deliverable",
        state: "Applied",
      }),
    );
    expect(
      recovered.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${actionIntent.executionId}_`,
        ),
      ),
    ).toHaveLength(1);
    expect(targetProviderCalls).toBe(1);
    markPhase("receipt, Action, Observation, and provider assertions complete");
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    releaseGate(fixture, "new", "action-result");
    await recoveryDaemon.crash();
  };
