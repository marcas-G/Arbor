import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { waitForLiveOwnerLeaseExpiryForQualification } from "../../support/lease-qualification.js";
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

export const ah10GenTakeoverAcceptResult = async (
  crashSide: "before" | "after",
): Promise<void> => {
  const childMarker = `AH10-accept-child-${crypto.randomUUID().slice(0, 8)}`;
  const parentMarker = `AH10-accept-parent-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const acceptResultCalls: Array<{
    readonly providerCallIndex: number;
    readonly resultRef: string;
  }> = [];
  const listWorkspaceCalls: number[] = [];
  const listWorkspacesUnavailableCalls: number[] = [];
  const missingResultRefContexts: string[] = [];
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
        !available.has("claim_completion") &&
        available.has("propose_workspace") &&
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
                  why: "prepare a verified child result before parent execution starts",
                  constraints: ["do not perform external side effects"],
                  completionExpectation: "independently verified child result",
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
                why: "qualify durable Parent acceptance across owner generations",
                constraints: [],
                completionExpectation:
                  "the exact verified child result is accepted",
                verificationMission: {
                  goal: `Verify Parent acceptance ${parentMarker}`,
                  criteria: [
                    {
                      criterionId: "ah10-parent-acceptance",
                      requirement:
                        "the child PASS result is accepted exactly once",
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
          `AH10 Parent Acceptance Work waits for probe ${parentMarker}`,
        );
      }
      if (context.includes(parentMarker) && available.has("accept_result")) {
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
            missingResultRefContexts.push(context.slice(-2_000));
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
    "AH10 AcceptResult generation takeover",
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
  ).catch((error: unknown) => {
    throw new Error(
      `child Verification did not reach PASS: ${error instanceof Error ? error.message : String(error)}; provider=${JSON.stringify(providerTrace)}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  const childCurrentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision?: number;
        status?: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: childWorkspaceId }),
    (view) =>
      view !== null &&
      view.workId === childWorkId &&
      view.status === "Open" &&
      view.activeExecution === undefined,
    30_000,
  );
  expect(childVerification).toMatchObject({
    verdict: "Pass",
  });
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
    throw new Error("AH10 Parent Acceptance Work did not reach Manual wait");
  }
  expect(seedParentWork.revision).toBe(0);
  await fixture.crash();
  probeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
      ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
    },
  });
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
  await client.command(project.projectId, "SteerWork", {
    workId: parentWorkId,
    workspaceId: project.rootWorkspaceId,
    expectedWorkRevision: seedParentWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume Parent AcceptResult ${parentMarker}.`,
    },
    provenance: { source: "HumanInput" },
  });
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
    15_000,
  ).catch((error: unknown) => {
    throw new Error(
      `AcceptResult-specific ActionIntent was not observed: ${error instanceof Error ? error.message : String(error)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; listWorkspacesUnavailableCalls=${JSON.stringify(listWorkspacesUnavailableCalls)}; missingResultRef=${JSON.stringify(missingResultRefContexts)}; providerTrace=${JSON.stringify(providerTrace.slice(-8))}; actionIntents=${JSON.stringify(events.filter((event) => event.role === "old" && event.boundary === "AH7AfterActionIntentCommit"))}`,
    );
  });
  if (oldAction === undefined) {
    throw new Error("AH10 old AcceptResult Action intent probe was absent");
  }
  expect(oldAction.callRef).toMatch(/^call_/u);
  expect(listWorkspaceCalls).toHaveLength(1);
  expect(listWorkspacesUnavailableCalls).toEqual([]);
  expect(acceptResultCalls).toHaveLength(1);
  expect(acceptResultCalls[0]?.resultRef).toMatch(/^rref_[a-f0-9]{64}$/u);
  const oldLeasePause = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH10BeforeLeaseRenewal" &&
          event.pauseRequested === true &&
          event.executionId === oldAction.executionId,
      ),
    (event) => event !== undefined,
    20_000,
  );
  if (oldLeasePause === undefined) {
    throw new Error("AH10 old AcceptResult lease pause evidence absent");
  }
  expect(oldLeasePause?.fencingGeneration).toBe(0);
  const oldAcceptLease = readAh10Rows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction.executionId,
  );
  if (oldAcceptLease === undefined)
    throw new Error("AH10 old AcceptResult lease row is absent");
  await waitForLiveOwnerLeaseExpiryForQualification({
    databaseFile: fixture.databaseFile,
    executionId: oldAction.executionId,
    pauseEvidence: {
      boundary: "AH10BeforeLeaseRenewal",
      pauseRequested: oldLeasePause.pauseRequested === true,
      executionId: oldLeasePause.executionId,
      fencingGeneration: oldLeasePause.fencingGeneration ?? -1,
    },
    expected: {
      workerId: oldAcceptLease.worker_id,
      workerIncarnationId: oldAcceptLease.worker_incarnation_id,
      generation: oldAcceptLease.generation,
      expiresAt: oldAcceptLease.expires_at,
    },
    daemon: {
      snapshot: fixture.daemonProcessSnapshot,
    },
  });

  const newDaemon = await fixture.startAdditionalDaemon({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
    },
    onStdout: (line) => pushProbe(events, line),
  });
  const newLease = await waitForPublic(
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
  expect(newLease?.fencingGeneration).toBe(1);
  const newAction = await waitForPublic(
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
  expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
  expect(newAction?.callRef).toBe(oldAction.callRef);
  expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

  releaseGate(fixture, "old", "action-intent");
  if (crashSide === "before") {
    const beforeCommit = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeFencedReceiptCommit" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
    // readAh10Rows opens a new read-only connection, independent of the
    // old daemon's uncommitted Gateway transaction.
    expect(
      readAh10Rows(fixture.databaseFile).commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
  } else {
    const fenced = await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).commands.filter(
          (command) =>
            command.resolution === "TerminalRejected" &&
            command.terminal_error_json?.includes("FencingRejected"),
        ),
      (rows) => rows.length === 1,
      15_000,
    );
    expect(fenced).toHaveLength(1);
  }
  expect(readAh10Rows(fixture.databaseFile).acceptances).toHaveLength(0);
  await fixture.crash();
  if (crashSide === "before") {
    expect(
      readAh10Rows(fixture.databaseFile).commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
  }

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
    20_000,
  );

  const final = readAh10Rows(fixture.databaseFile);
  const rejected = final.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );
  const committed = final.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    const result = JSON.parse(command.result_json) as {
      readonly acceptanceId?: string;
      readonly workId?: string;
      readonly targetWorkRevision?: number;
      readonly verificationId?: string;
    };
    return (
      result.acceptanceId !== undefined &&
      result.workId === childWorkId &&
      result.targetWorkRevision === childVerification.targetWorkRevision &&
      result.verificationId === childVerification.verificationId
    );
  });
  expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
  expect(committed).toHaveLength(1);
  expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
  const committedResult = JSON.parse(committed[0]?.result_json ?? "{}") as {
    readonly acceptanceId?: string;
    readonly workId?: string;
    readonly targetWorkRevision?: number;
    readonly verificationId?: string;
  };
  expect(committedResult).toMatchObject({
    acceptanceId: expect.stringMatching(/^acc_/u),
    workId: childWorkId,
    targetWorkRevision: childVerification.targetWorkRevision,
    verificationId: childVerification.verificationId,
  });
  expect(final.acceptances).toEqual([
    expect.objectContaining({
      acceptance_id: committedResult.acceptanceId,
      project_id: project.projectId,
      work_id: childWorkId,
      target_work_revision: childVerification.targetWorkRevision,
      verification_id: childVerification.verificationId,
    }),
  ]);
  expect(
    final.works.find((work) => work.work_id === childWorkId),
  ).toMatchObject({
    project_id: project.projectId,
    workspace_id: childWorkspaceId,
    lifecycle: "Completed",
  });
  const acceptedAction = final.actions.filter(
    (action) =>
      action.execution_id === oldAction.executionId &&
      action.provider_turn_id === oldAction.providerTurnId &&
      action.logical_action_id === oldAction.logicalActionId &&
      action.call_ref === oldAction.callRef &&
      action.action_kind === "accept_result" &&
      action.state === "Applied",
  );
  expect(acceptedAction).toHaveLength(1);
  const observationSourceRef = acceptedAction[0]?.observation_source_ref;
  expect(observationSourceRef).toMatch(/^observation_/u);
  const parentObservations = final.actionObservations.filter((observation) =>
    observation.source_ref.startsWith(`observation_${oldAction.executionId}_`),
  );
  expect(
    parentObservations,
    `AH10 AcceptResult provider/workspace facts: ${JSON.stringify({
      providerTrace: providerTrace.slice(-10),
      listWorkspaceCalls,
      listWorkspacesUnavailableCalls,
      acceptResultCalls,
      childVerification: {
        verdict: childVerification.verdict,
        verificationId: childVerification.verificationId,
        targetWorkRevision: childVerification.targetWorkRevision,
      },
      childCurrentWork,
      works: final.works,
      deliverables: final.deliverables,
      acceptances: final.acceptances,
      listWorkspaceActions: final.actions.filter(
        (action) => action.action_kind === "list_workspaces",
      ),
    })}`,
  ).toHaveLength(2);
  expect(
    parentObservations.filter(
      (observation) => observation.source_ref === observationSourceRef,
    ),
  ).toHaveLength(1);
  expect(
    final.providerAttempts.filter(
      (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
    ),
  ).toEqual([
    expect.objectContaining({
      outcome: "Success",
      settled_at: expect.any(String),
    }),
  ]);
  expect(acceptResultCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
  await newDaemon.crash();
};
