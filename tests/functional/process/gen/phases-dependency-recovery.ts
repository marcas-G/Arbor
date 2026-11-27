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

export const ah10GenRecoverCommittedDeclareDependencyReceipt =
  async (): Promise<void> => {
    const marker = `AH10-dependency-pending-${crypto.randomUUID().slice(0, 8)}`;
    const dependencyKind = `ah10-pending-${marker}`;
    const events: Ah10Probe[] = [];
    let declarationProviderCalls = 0;
    let probeArmed = false;
    let seedWaitIssued = false;
    let producerWorkspaceId = "";
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
            ? { _tag: "Text", text: `Dependency Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Declare one dependency ${marker}.`,
                  why: "qualify committed dependency receipt recovery before Observation",
                  constraints: [],
                  completionExpectation:
                    "one exact dependency is durably declared",
                  verificationMission: {
                    goal: `Verify dependency declaration ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-dependency-pending-recovery",
                        requirement: "one dependency is durably declared",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (
          declarationProviderCalls === 0 &&
          available.has("declare_dependency") &&
          context.includes(marker)
        ) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(
              `seed Work waits for dependency receipt probe ${marker}`,
            );
          }
          declarationProviderCalls += 1;
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: {
                _tag: "WorkspaceBound",
                workspaceId: producerWorkspaceId,
              },
              expectedDeliverable: {
                kind: dependencyKind,
                requiredArtifactRoles: [],
              },
            },
          };
        }
        return { _tag: "Text", text: `Declared dependency for ${marker}.` };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed DeclareDependency receipt recovery",
    );
    producerWorkspaceId = project.rootWorkspaceId;
    const consumerWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit the dependency Work ${marker}.`,
    );
    const consumerWorkId = consumerWork.workId;
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
        work?.workId === consumerWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedWorkAtWait === null || seedWorkAtWait.workId !== consumerWorkId) {
      throw new Error("AH10 dependency seed Work did not reach Manual wait");
    }
    expect(seedWorkAtWait.revision).toBe(0);
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_GATE_ACTION_KIND: "declare_dependency",
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: consumerWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedWorkAtWait.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume dependency receipt action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });

    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "declare_dependency" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (oldAction === undefined) {
      throw new Error("AH10 committed DeclareDependency ActionIntent absent");
    }
    expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
    expect(oldAction.logicalActionId).toMatch(/^lac_/u);
    expect(oldAction.callRef).toMatch(/^call_/u);
    releaseGate(fixture, "old", "action-intent");
    const oldControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(oldControlReturn).toBeDefined();

    const beforeCrash = readAh10Rows(fixture.databaseFile);
    const dependencyReceipt = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        dependencyId?: string;
        consumerWorkId?: string;
        state?: string;
        revision?: number;
      };
      return (
        result.consumerWorkId === consumerWorkId &&
        result.state === "Unsatisfied"
      );
    });
    expect(dependencyReceipt).toHaveLength(1);
    const resultBeforeCrash = JSON.parse(
      dependencyReceipt[0]?.result_json ?? "{}",
    ) as { dependencyId?: string };
    expect(resultBeforeCrash.dependencyId).toMatch(/^dep_/u);
    expect(beforeCrash.dependencies).toEqual([
      expect.objectContaining({
        dependency_id: resultBeforeCrash.dependencyId,
        project_id: project.projectId,
        consumer_work_id: consumerWorkId,
        state: "Unsatisfied",
        revision: 0,
      }),
    ]);
    const declarationEvents = beforeCrash.domainEvents.filter(
      (event) =>
        event.project_id === project.projectId &&
        event.event_type === "DependencyDeclared" &&
        event.aggregate_ref === resultBeforeCrash.dependencyId,
    );
    expect(declarationEvents).toHaveLength(1);
    expect(declarationEvents[0]?.caused_by_command_id).toBe(
      dependencyReceipt[0]?.command_id,
    );
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "declare_dependency",
        state: "Pending",
      }),
    );
    expect(
      beforeCrash.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(
      beforeCrash.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(declarationProviderCalls).toBe(1);

    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
    const recoveryDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        ARBOR_AH10_GATE_ACTION_KIND: "declare_dependency",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const recoveredLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(recoveredLease?.fencingGeneration).toBe(1);
    const recoveredIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionKind === "declare_dependency" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredIntent?.providerTurnId).toBe(oldAction.providerTurnId);
    expect(recoveredIntent?.logicalActionId).toBe(oldAction.logicalActionId);
    expect(recoveredIntent?.callRef).toBe(oldAction.callRef);
    releaseGate(fixture, "new", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionResultCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );

    const recovered = readAh10Rows(fixture.databaseFile);
    const recoveredReceipts = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        dependencyId?: string;
        consumerWorkId?: string;
      };
      return (
        result.dependencyId === resultBeforeCrash.dependencyId &&
        result.consumerWorkId === consumerWorkId
      );
    });
    expect(recoveredReceipts).toHaveLength(1);
    expect(recoveredReceipts[0]?.command_id).toBe(
      dependencyReceipt[0]?.command_id,
    );
    expect(recovered.dependencies).toEqual(beforeCrash.dependencies);
    expect(
      recovered.domainEvents.filter(
        (event) =>
          event.project_id === project.projectId &&
          event.event_type === "DependencyDeclared" &&
          event.aggregate_ref === resultBeforeCrash.dependencyId,
      ),
    ).toHaveLength(1);
    expect(recovered.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "declare_dependency",
        state: "Applied",
      }),
    );
    const actionObservation = recovered.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId,
    )?.observation_source_ref;
    expect(actionObservation).toMatch(/^observation_/u);
    expect(
      recovered.actionObservations.filter(
        (observation) => observation.source_ref === actionObservation,
      ),
    ).toHaveLength(1);
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(declarationProviderCalls).toBe(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    releaseGate(fixture, "new", "action-result");
    await recoveryDaemon.crash();
  };
