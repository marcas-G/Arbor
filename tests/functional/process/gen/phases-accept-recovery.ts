import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../support/lease-qualification.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../../support/public-client.js";
import { makeWorkProvider } from "../../support/work-provider.js";
import {
  type Ah10Probe,
  ah10Child,
  fixtures,
  manualWait,
  pushProbe,
  readAh10Rows,
  releaseGate,
} from "./support.js";

export const ah10GenRecoverCommittedAcceptResultReceipt =
  async (): Promise<void> => {
    const childMarker = `AH10-accept-committed-child-${crypto.randomUUID().slice(0, 8)}`;
    const parentMarker = `AH10-accept-committed-parent-${crypto.randomUUID().slice(0, 8)}`;
    const events: Ah10Probe[] = [];
    const acceptResultCalls: Array<{
      readonly providerCallIndex: number;
      readonly resultRef: string;
    }> = [];
    const listWorkspaceCalls: number[] = [];
    const listWorkspacesUnavailableCalls: number[] = [];
    const providerTrace: Array<{
      readonly index: number;
      readonly tools: ReadonlyArray<string | undefined>;
      readonly tail: string;
      readonly resultRefs: ReadonlyArray<string>;
      readonly readyResultsPresent: boolean;
    }> = [];
    let probeArmed = false;
    let parentSeedWaitIssued = false;
    const childWorkProvider = makeWorkProvider({
      marker: childMarker,
      verdict: "Pass",
    });
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply: (call, index) => {
        const context = JSON.stringify(call.messages);
        providerTrace.push({
          index,
          tools: call.tools.map((tool) => tool.function?.name),
          tail: context.slice(-1_200),
          resultRefs: [...context.matchAll(/rref_[a-f0-9]{64}/gu)].map(
            (match) => match[0],
          ),
          readyResultsPresent: context.includes("readyResults"),
        });
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        const latestUser = [...call.messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        if (
          available.has("propose_workspace") &&
          !available.has("claim_completion") &&
          latestUser?.includes(`Propose ${childMarker}`) === true
        ) {
          return context.includes("ProposalRecorded(")
            ? { _tag: "Text", text: `Proposed child ${childMarker}` }
            : {
                _tag: "ToolCall",
                name: "propose_workspace",
                arguments: {
                  name: `child-${childMarker}`,
                  rationale:
                    "produce a verified result for Parent acceptance qualification",
                  responsibilityDraft: {
                    purpose: `produce a verified result for ${childMarker}`,
                    ownedResponsibilities: [childMarker],
                    obligations: ["produce independently verified evidence"],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  resourceBoundaryDraft: {
                    addresses: [
                      { _tag: "FileTree", path: fixture.workspaceDirectory },
                    ],
                  },
                  initialWork: {
                    objective: `Complete ${childMarker}.`,
                    why: "prepare a verified child result before the parent execution starts",
                    constraints: ["do not perform external side effects"],
                    completionExpectation:
                      "independently verified child result",
                    verificationMission: {
                      goal: `Verify ${childMarker}`,
                      criteria: [
                        {
                          criterionId: "functional-criterion",
                          requirement: `proof.txt contains FUNCTIONAL_VERIFIED for ${childMarker}`,
                          required: true,
                        },
                      ],
                      riskRequirements: ["read-only verification"],
                    },
                  },
                },
              };
        }
        if (
          !available.has("claim_completion") &&
          available.has("assign_work") &&
          latestUser?.includes(
            `Create Parent Acceptance Work ${parentMarker}`,
          ) === true
        ) {
          return context.includes("WorkAssigned(")
            ? {
                _tag: "Text",
                text: `Parent Acceptance Work admitted ${parentMarker}`,
              }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Accept the ready child result ${parentMarker}.`,
                  why: "qualify committed Parent acceptance recovery before Observation",
                  constraints: [],
                  completionExpectation:
                    "the exact verified child result is accepted",
                  verificationMission: {
                    goal: `Verify Parent acceptance ${parentMarker}`,
                    criteria: [
                      {
                        criterionId:
                          "ah10-parent-acceptance-committed-recovery",
                        requirement:
                          "the exact child PASS result is accepted once",
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
          available.has("claim_completion") &&
          available.has("accept_result") &&
          context.includes(parentMarker) &&
          !probeArmed
        ) {
          parentSeedWaitIssued = true;
          return manualWait(
            `Parent Acceptance Work waits for probe ${parentMarker}`,
          );
        }
        if (
          available.has("claim_completion") &&
          context.includes(parentMarker) &&
          available.has("accept_result")
        ) {
          if (acceptResultCalls.length > 0) {
            return {
              _tag: "Text",
              text: `Accepted the child result ${parentMarker}.`,
            };
          }
          const resultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
          if (resultRef === undefined) {
            if (!available.has("list_workspaces")) {
              listWorkspacesUnavailableCalls.push(index);
              return {
                _tag: "Text",
                text: "No direct-child ready resultRef or list_workspaces control was supplied.",
              };
            }
            listWorkspaceCalls.push(index);
            return {
              _tag: "ToolCall",
              name: "list_workspaces",
              arguments: { query: childMarker },
            };
          }
          acceptResultCalls.push({ providerCallIndex: index, resultRef });
          return {
            _tag: "ToolCall",
            name: "accept_result",
            arguments: { resultRef },
          };
        }
        if (context.includes(childMarker)) return childWorkProvider(call);
        return { _tag: "Text", text: "Acceptance qualification setup." };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed AcceptResult receipt recovery",
      { resourceSelection: "Profile" },
    );
    const childDirectory = fixture.workspaceDirectory;
    writeFileSync(
      resolve(childDirectory, "proof.txt"),
      `FUNCTIONAL_VERIFIED for ${childMarker}`,
    );
    const child = await proposeAndApproveChildWithInitialWork(
      client,
      project,
      childMarker,
      `Propose ${childMarker} as a durable producer with its first Work.`,
      {
        name: `child-${childMarker}`,
        initialWork: {
          objective: `Complete ${childMarker}.`,
        },
      },
    );
    const childWorkspaceId = child.workspaceId;
    const childWorkId = child.currentWork.workId;
    expect(child.currentWork.objective).toBe(`Complete ${childMarker}.`);
    const childVerification = await waitForPublic(
      () =>
        client.view<{
          verificationId?: string;
          targetWorkRevision?: number;
          verdict?: string;
          acceptance?: { acceptanceId: string };
        }>("verification", { workId: childWorkId }),
      (view) => view.verdict === "Pass" && view.verificationId !== undefined,
      20_000,
    );
    const childCurrentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision?: number;
          status?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: childWorkspaceId }),
      (view) =>
        view?.workId === childWorkId &&
        view.status === "Open" &&
        view.activeExecution === undefined,
      30_000,
    );
    expect(childVerification.verdict).toBe("Pass");
    expect(childVerification.acceptance).toBeUndefined();
    expect(childCurrentWork).toMatchObject({
      workId: childWorkId,
      status: "Open",
    });
    expect(readAh10Rows(fixture.databaseFile).acceptances).toHaveLength(0);

    const parentWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      parentMarker,
      `Create Parent Acceptance Work ${parentMarker}`,
    );
    const parentWorkId = parentWork.workId;
    const seedParentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        parentSeedWaitIssued &&
        work?.workId === parentWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedParentWork === null || seedParentWork.workId !== parentWorkId) {
      throw new Error(
        "AH10 committed Parent Acceptance Work did not reach Manual wait",
      );
    }
    expect(seedParentWork.revision).toBe(0);
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
      },
    });
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    await client.command(project.projectId, "SteerWork", {
      workId: parentWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedParentWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume committed Parent AcceptResult ${parentMarker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const listActionIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "list_workspaces" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (listActionIntent === undefined) {
      throw new Error(
        "AH10 AcceptResult prerequisite list_workspaces intent absent",
      );
    }
    const listControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === listActionIntent.executionId &&
            event.logicalActionId === listActionIntent.logicalActionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(listControlReturn).toBeDefined();
    releaseGate(fixture, "old", "control-return");
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).actions.find(
          (action) =>
            action.execution_id === listActionIntent.executionId &&
            action.logical_action_id === listActionIntent.logicalActionId,
        ),
      (action) =>
        action?.action_kind === "list_workspaces" &&
        action.state === "Applied" &&
        action.observation_source_ref !== null,
      15_000,
    );
    // Remove only this test fixture's temporary release marker after the
    // public list_workspaces Observation is durable. The next control return
    // is now the target AcceptResult handler boundary.
    const controlReturnReleasePath = resolve(
      fixture.directory,
      "ah10-gates",
      "old-control-return.release",
    );
    expect(relative(resolve(fixture.directory), controlReturnReleasePath)).toBe(
      join("ah10-gates", "old-control-return.release"),
    );
    expect(existsSync(controlReturnReleasePath)).toBe(true);
    unlinkSync(controlReturnReleasePath);
    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "accept_result" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `committed AcceptResult ActionIntent absent: ${error instanceof Error ? error.message : String(error)}; providerTrace=${JSON.stringify(providerTrace.slice(-8))}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; listWorkspacesUnavailableCalls=${JSON.stringify(listWorkspacesUnavailableCalls)}; acceptResultCalls=${JSON.stringify(acceptResultCalls)}; events=${JSON.stringify(events)}; oldDaemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (oldAction === undefined) {
      throw new Error("AH10 committed AcceptResult ActionIntent absent");
    }
    expect(listWorkspaceCalls).toHaveLength(1);
    expect(listWorkspacesUnavailableCalls).toEqual([]);
    expect(acceptResultCalls).toHaveLength(1);
    expect(acceptResultCalls[0]?.resultRef).toMatch(/^rref_[a-f0-9]{64}$/u);
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
    const acceptanceEvents = beforeCrash.domainEvents.filter(
      (event) =>
        event.project_id === project.projectId &&
        event.event_type === "WorkOutcomeAccepted" &&
        event.aggregate_ref === childWorkId,
    );
    expect(acceptanceEvents).toHaveLength(1);
    const acceptanceReceipt = beforeCrash.commands.filter((command) => {
      return (
        command.resolution === "Committed" &&
        command.result_json !== null &&
        command.command_id === acceptanceEvents[0]?.caused_by_command_id
      );
    });
    expect(acceptanceReceipt).toHaveLength(1);
    const acceptanceResult = JSON.parse(
      acceptanceReceipt[0]?.result_json ?? "{}",
    ) as { acceptanceId?: string; workId?: string };
    expect(acceptanceResult.acceptanceId).toMatch(/^acc_/u);
    expect(beforeCrash.acceptances).toEqual([
      expect.objectContaining({
        acceptance_id: acceptanceResult.acceptanceId,
        project_id: project.projectId,
        work_id: childWorkId,
        target_work_revision: childVerification.targetWorkRevision,
        verification_id: childVerification.verificationId,
      }),
    ]);
    expect(acceptanceResult).toMatchObject({
      workId: childWorkId,
      targetWorkRevision: childVerification.targetWorkRevision,
      verificationId: childVerification.verificationId,
    });
    expect(acceptanceEvents[0]?.caused_by_command_id).toBe(
      acceptanceReceipt[0]?.command_id,
    );
    expect(
      beforeCrash.works.find((work) => work.work_id === childWorkId)?.lifecycle,
    ).toBe("Open");
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "accept_result",
        state: "Pending",
      }),
    );
    const acceptObservationRef = beforeCrash.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId,
    )?.observation_source_ref;
    expect(acceptObservationRef).toBeNull();
    const parentExecutionObservations = beforeCrash.actionObservations.filter(
      (observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
    );
    expect(parentExecutionObservations).toHaveLength(1);
    expect(parentExecutionObservations[0]?.source_ref).toBe(
      beforeCrash.actions.find(
        (action) =>
          action.execution_id === listActionIntent.executionId &&
          action.logical_action_id === listActionIntent.logicalActionId,
      )?.observation_source_ref,
    );
    expect(acceptResultCalls).toHaveLength(1);
    expect(
      beforeCrash.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);

    const oldLease = beforeCrash.leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLease?.generation).toBe(0);
    expect(Date.parse(oldLease?.expires_at ?? "") - Date.now()).toBeGreaterThan(
      0,
    );
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
        ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
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
            event.actionKind === "accept_result" &&
            event.executionId === oldAction.executionId &&
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
    releaseGate(fixture, "new", "action-result");
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).works.find(
          (work) => work.work_id === childWorkId,
        ),
      (work) => work?.lifecycle === "Completed",
      30_000,
    );

    const recovered = readAh10Rows(fixture.databaseFile);
    const recoveredReceipts = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        acceptanceId?: string;
        workId?: string;
      };
      return (
        command.command_id === acceptanceReceipt[0]?.command_id &&
        result.acceptanceId === acceptanceResult.acceptanceId &&
        result.workId === childWorkId
      );
    });
    expect(recoveredReceipts).toHaveLength(1);
    expect(recoveredReceipts[0]?.command_id).toBe(
      acceptanceReceipt[0]?.command_id,
    );
    expect(recovered.acceptances).toEqual(beforeCrash.acceptances);
    expect(
      recovered.domainEvents.filter(
        (event) =>
          event.project_id === project.projectId &&
          event.event_type === "WorkOutcomeAccepted" &&
          event.aggregate_ref === childWorkId,
      ),
    ).toHaveLength(1);
    expect(
      recovered.works.find((work) => work.work_id === childWorkId)?.lifecycle,
    ).toBe("Completed");
    const appliedAction = recovered.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId &&
        action.action_kind === "accept_result",
    );
    expect(appliedAction).toMatchObject({
      provider_turn_id: oldAction.providerTurnId,
      call_ref: oldAction.callRef,
      state: "Applied",
      observation_source_ref: expect.any(String),
    });
    expect(
      recovered.actionObservations.filter(
        (observation) =>
          observation.source_ref === appliedAction?.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(acceptResultCalls).toHaveLength(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    await recoveryDaemon.crash();
  };
