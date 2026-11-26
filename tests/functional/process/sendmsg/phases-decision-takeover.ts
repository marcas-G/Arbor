import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { waitForLiveOwnerLeaseExpiryForQualification } from "../../support/lease-qualification.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10Probe,
  ah10Child,
  fencedReceipts,
  fixtures,
  manualWait,
  pushProbe,
  readRows,
  releaseGate,
} from "./support.js";

export const ah10SendMsgTakeOverDecisionRequest = async (
  crashSide: "before" | "after",
): Promise<void> => {
  const marker = `AH10-decision-request-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const actionProviderCalls: number[] = [];
  let probeArmed = false;
  let seedWaitIssued = false;
  const fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    reply: (call, index) => {
      const context = JSON.stringify(call.messages);
      const available = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      const isWorkEpisode = available.has("claim_completion");
      const latestUser = [...call.messages]
        .reverse()
        .find((message) => message.role === "user")?.content;
      if (
        !isWorkEpisode &&
        available.has("propose_workspace") &&
        latestUser?.includes(`Propose ${marker}`) === true
      ) {
        return context.includes("ProposalRecorded(")
          ? {
              _tag: "Text",
              text: `Proposed DecisionRequest sender ${marker}`,
            }
          : {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: `child-${marker}`,
                rationale: "send a direct-parent DecisionRequest",
                responsibilityDraft: {
                  purpose: `request a parent decision for ${marker}`,
                  ownedResponsibilities: [marker],
                  obligations: [
                    "send one DecisionRequest to the direct parent",
                  ],
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
                  objective: `Request a parent decision for ${marker}.`,
                  why: "qualify DecisionRequest Message takeover across generations",
                  constraints: [
                    "send exactly one DecisionRequest to the parent",
                  ],
                  completionExpectation:
                    "one direct-parent DecisionRequest is admitted",
                  verificationMission: {
                    goal: `Verify DecisionRequest admission ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-decision-request-admitted",
                        requirement:
                          "one DecisionRequest is admitted to the parent Inbox",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                },
              },
            };
      }
      if (!isWorkEpisode && available.has("send_message")) {
        return {
          _tag: "Text",
          text: `Received parent decision request ${marker}.`,
        };
      }
      if (
        isWorkEpisode &&
        available.has("wait") &&
        context.includes("MessageDelivered(")
      ) {
        return {
          _tag: "ToolCall",
          name: "wait",
          arguments: {
            reason: `wait for the parent to consider ${marker}`,
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
          },
        };
      }
      if (
        isWorkEpisode &&
        available.has("send_message") &&
        available.has("wait") &&
        context.includes(marker)
      ) {
        if (!probeArmed) {
          seedWaitIssued = true;
          return manualWait(
            `DecisionRequest seed Work waits for probe ${marker}`,
          );
        }
        actionProviderCalls.push(index);
        return {
          _tag: "ToolCalls",
          calls: [
            {
              name: "send_message",
              arguments: {
                kind: "DecisionRequest",
                body: `Please decide the next step for ${marker}.`,
              },
            },
            {
              name: "wait",
              arguments: {
                reason: `wait for the parent to consider ${marker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            },
          ],
        };
      }
      return { _tag: "HttpError", status: 422 };
    },
    onDaemonStdout: (line) => pushProbe(events, line),
  });
  fixtures.push(fixture);
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH10 DecisionRequest generation takeover",
    { resourceSelection: "Profile" },
  );
  const child = await proposeAndApproveChildWithInitialWork(
    client,
    project,
    marker,
    `Propose ${marker} as a DecisionRequest sender with its first Work.`,
    {
      name: `child-${marker}`,
      initialWork: {
        objective: `Request a parent decision for ${marker}.`,
      },
    },
  );
  const childWorkspaceId = child.workspaceId;
  const childWorkId = child.currentWork.workId;
  expect(child.currentWork.objective).toBe(
    `Request a parent decision for ${marker}.`,
  );
  const seedChildWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: childWorkspaceId }),
    (work) =>
      seedWaitIssued &&
      work?.workId === childWorkId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seedChildWork === null || seedChildWork.workId !== childWorkId) {
    throw new Error("AH10 DecisionRequest seed Work did not reach Manual wait");
  }
  expect(seedChildWork.revision).toBe(0);
  await fixture.crash();
  probeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "send_message",
      ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE: "1",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId: childWorkId,
    workspaceId: childWorkspaceId,
    expectedWorkRevision: seedChildWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume DecisionRequest ${marker}.`,
    },
    provenance: { source: "HumanInput" },
  });

  const oldAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === "send_message" &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (oldAction === undefined) {
    throw new Error("AH10 old DecisionRequest ActionIntent was absent");
  }
  const providerTurnId = oldAction.providerTurnId;
  const logicalActionId = oldAction.logicalActionId;
  const callRef = oldAction.callRef;
  if (
    providerTurnId === undefined ||
    logicalActionId === undefined ||
    callRef === undefined
  ) {
    throw new Error(
      "AH10 DecisionRequest ActionIntent omitted pinned identity",
    );
  }
  expect(actionProviderCalls).toHaveLength(1);

  writeFileSync(
    resolve(fixture.directory, "ah10-gates", "old-lease-renewal.pause"),
    "pause next renewal",
  );
  const oldLeasePause = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH10BeforeLeaseRenewal" &&
          event.executionId === oldAction.executionId &&
          event.pauseRequested === true,
      ),
    (event) => event !== undefined,
    20_000,
  );
  if (oldLeasePause === undefined) {
    throw new Error("AH10 old DecisionRequest lease pause was absent");
  }
  expect(oldLeasePause.fencingGeneration).toBe(0);
  const oldLease = readRows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction.executionId,
  );
  expect(oldLease?.generation).toBe(0);
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
      generation: 0,
      ...(oldLease === undefined ? {} : { expiresAt: oldLease.expires_at }),
    },
    daemon: {
      snapshot: fixture.daemonProcessSnapshot,
    },
  });

  const newDaemon = await fixture.startAdditionalDaemon({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_GATE_ACTION_KIND: "send_message",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
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
  if (newLease === undefined) {
    throw new Error("AH10 gen1 did not acquire DecisionRequest lease");
  }
  expect(newLease.fencingGeneration).toBe(1);
  const newAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === "send_message" &&
          event.executionId === oldAction.executionId &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (newAction === undefined) {
    throw new Error("AH10 gen1 DecisionRequest ActionIntent was absent");
  }
  expect(newAction.providerTurnId).toBe(providerTurnId);
  expect(newAction.callRef).toBe(callRef);
  expect(newAction.logicalActionId).toBe(logicalActionId);
  expect(actionProviderCalls).toHaveLength(1);

  releaseGate(fixture, "old", "action-intent");
  let oldRejectedCommandId: string;
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
    if (beforeCommit?.commandId === undefined) {
      throw new Error("AH10 pre-commit DecisionRequest fence probe was absent");
    }
    oldRejectedCommandId = beforeCommit.commandId;
    expect(oldRejectedCommandId).toMatch(/^cmd_/u);
    const beforeKill = readRows(fixture.databaseFile);
    expect(fencedReceipts(beforeKill)).toHaveLength(0);
    expect(beforeKill.messages).toHaveLength(0);
    expect(beforeKill.messageEvents).toHaveLength(0);
    expect(beforeKill.inbox).toHaveLength(0);
    expect(
      beforeKill.commands.some(
        (command) => command.command_id === oldRejectedCommandId,
      ),
    ).toBe(false);
  } else {
    const rejected = await waitForPublic(
      async () => fencedReceipts(readRows(fixture.databaseFile)),
      (rows) => rows.length === 1,
      15_000,
    );
    oldRejectedCommandId = rejected[0]?.command_id ?? "";
    expect(oldRejectedCommandId).toMatch(/^cmd_/u);
    const beforeKill = readRows(fixture.databaseFile);
    expect(beforeKill.messages).toHaveLength(0);
    expect(beforeKill.messageEvents).toHaveLength(0);
    expect(beforeKill.inbox).toHaveLength(0);
  }

  await fixture.crash();
  if (crashSide === "before") {
    const afterKill = readRows(fixture.databaseFile);
    expect(fencedReceipts(afterKill)).toHaveLength(0);
    expect(afterKill.messages).toHaveLength(0);
    expect(afterKill.messageEvents).toHaveLength(0);
    expect(afterKill.inbox).toHaveLength(0);
    expect(
      afterKill.commands.some(
        (command) => command.command_id === oldRejectedCommandId,
      ),
    ).toBe(false);
  }

  releaseGate(fixture, "new", "action-intent");
  const gen1ActionResult = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionResultCommit" &&
          event.executionId === oldAction.executionId &&
          event.logicalActionId === logicalActionId &&
          event.callRef === callRef &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    15_000,
  );
  if (gen1ActionResult === undefined) {
    throw new Error("AH10 gen1 DecisionRequest ActionResult gate was absent");
  }
  const atActionResultGate = readRows(fixture.databaseFile);
  const decisionAtGate = atActionResultGate.messages.find(
    (message) =>
      message.kind === "DecisionRequest" &&
      message.sender_workspace_id === childWorkspaceId &&
      message.recipient_workspace_id === project.rootWorkspaceId,
  );
  expect(decisionAtGate).toBeDefined();
  const messageEventAtGate = atActionResultGate.messageEvents.find(
    (event) => event.aggregate_ref === decisionAtGate?.message_id,
  );
  expect(messageEventAtGate).toBeDefined();
  const offsetAtActionResultGate = atActionResultGate.workflowOffsets.find(
    (offset) => offset.project_id === project.projectId,
  );
  expect(offsetAtActionResultGate).toBeDefined();
  expect(offsetAtActionResultGate?.last_sequence).toBeLessThan(
    messageEventAtGate?.sequence ?? 0,
  );
  expect(
    atActionResultGate.workspaceExecutions.filter(
      (execution) =>
        execution.workspace_id === project.rootWorkspaceId &&
        execution.settled_at === null,
    ),
  ).toHaveLength(0);
  const stepAtGate = atActionResultGate.agentLoopSteps.find(
    (step) =>
      step.execution_id === oldAction.executionId &&
      step.provider_turn_id === providerTurnId,
  );
  expect(stepAtGate).toMatchObject({
    state: "ActionsInProgress",
    next_action_index: 1,
  });
  expect(
    atActionResultGate.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === logicalActionId,
    ),
  ).toMatchObject({ state: "Applied" });

  // The qualification gate intentionally pauses before the same
  // ProviderTurn's model-authored Wait action. Release it to let the
  // WorkEpisode settle and the daemon reach its consumer poll.
  releaseGate(fixture, "new", "action-result");
  const completed = await waitForPublic(
    async () => readRows(fixture.databaseFile),
    (rows) => {
      const decisionMessage = rows.messages.find(
        (message) =>
          message.kind === "DecisionRequest" &&
          message.sender_workspace_id === childWorkspaceId &&
          message.recipient_workspace_id === project.rootWorkspaceId,
      );
      if (decisionMessage === undefined) return false;
      const messageEvent = rows.messageEvents.find(
        (event) => event.aggregate_ref === decisionMessage.message_id,
      );
      const workflowOffset = rows.workflowOffsets.find(
        (offset) => offset.project_id === project.projectId,
      );
      const parentInputEpisode = rows.inboxExecutions.find(
        (episode) =>
          episode.workspace_id === project.rootWorkspaceId &&
          episode.episode_ref === `msg:${decisionMessage.message_id}`,
      );
      const settledChildExecution = rows.workspaceExecutions.find(
        (execution) =>
          execution.execution_id === oldAction.executionId &&
          execution.settled_at !== null,
      );
      const childWorkWait = rows.workWaits.find(
        (wait) => wait.work_id === childWorkId,
      );
      return (
        messageEvent !== undefined &&
        workflowOffset !== undefined &&
        workflowOffset.last_sequence >= messageEvent.sequence &&
        parentInputEpisode !== undefined &&
        settledChildExecution !== undefined &&
        childWorkWait !== undefined &&
        rows.actions.some(
          (action) =>
            action.execution_id === oldAction.executionId &&
            action.logical_action_id === logicalActionId &&
            action.state === "Applied",
        )
      );
    },
    30_000,
  ).catch((error: unknown) => {
    const snapshot = readRows(fixture.databaseFile);
    const step = snapshot.agentLoopSteps.find(
      (candidate) =>
        candidate.execution_id === oldAction.executionId &&
        candidate.provider_turn_id === providerTurnId,
    );
    const childExecution = snapshot.workspaceExecutions.find(
      (execution) => execution.execution_id === oldAction.executionId,
    );
    throw new Error(
      `DecisionRequest completion predicate timed out: ${error instanceof Error ? error.message : String(error)}; step=${JSON.stringify(step)}; actions=${JSON.stringify(snapshot.actions.filter((action) => action.execution_id === oldAction.executionId))}; childExecution=${JSON.stringify(childExecution)}; workWait=${JSON.stringify(snapshot.workWaits.filter((wait) => wait.work_id === childWorkId))}; providerAttempts=${JSON.stringify(snapshot.providerAttempts.filter((attempt) => attempt.provider_turn_id === providerTurnId))}; workflowOffset=${JSON.stringify(snapshot.workflowOffsets.find((offset) => offset.project_id === project.projectId))}; messageEvents=${JSON.stringify(snapshot.messageEvents)}; deadLetters=${JSON.stringify(snapshot.workflowDeadLetters)}; fixture=${fixture.directory}; primaryDaemon=${fixture.daemonErrors.join(" | ")}; recoveryDaemon=${newDaemon.daemonErrors.join(" | ")}`,
    );
  });

  const decisionMessages = completed.messages.filter(
    (message) =>
      message.kind === "DecisionRequest" &&
      message.sender_workspace_id === childWorkspaceId &&
      message.recipient_workspace_id === project.rootWorkspaceId,
  );
  expect(decisionMessages).toHaveLength(1);
  const message = decisionMessages[0];
  expect(message?.correlation_id).toBeNull();
  expect(message?.body_ref).toMatch(/^[a-f0-9]{64}$/u);
  const messageEvents = completed.messageEvents.filter(
    (event) => event.aggregate_ref === message?.message_id,
  );
  expect(messageEvents).toHaveLength(1);
  expect(messageEvents[0]).toMatchObject({
    event_type: "MessageSent",
    caused_by_command_id: expect.any(String),
    correlation_ref: null,
  });
  const inboxEntryKey = `msg:${message?.message_id}`;
  expect(completed.inbox).toEqual([
    expect.objectContaining({
      workspace_id: project.rootWorkspaceId,
      entry_key: inboxEntryKey,
      kind: "Message",
      correlation_id: null,
    }),
  ]);

  const committed = completed.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    try {
      return (
        (JSON.parse(command.result_json) as { messageId?: string })
          .messageId === message?.message_id
      );
    } catch {
      return false;
    }
  });
  expect(committed).toHaveLength(1);
  expect(committed[0]?.command_id).not.toBe(oldRejectedCommandId);
  const result = JSON.parse(committed[0]?.result_json ?? "{}") as {
    promotion?: {
      closesCorrelation?: string | null;
      triggersReevaluation?: boolean;
    };
  };
  expect(result.promotion).toEqual({
    closesCorrelation: null,
    triggersReevaluation: true,
  });
  expect(messageEvents[0]?.caused_by_command_id).toBe(committed[0]?.command_id);
  expect(fencedReceipts(completed)).toHaveLength(
    crashSide === "before" ? 0 : 1,
  );

  const action = completed.actions.find(
    (candidate) =>
      candidate.execution_id === oldAction.executionId &&
      candidate.logical_action_id === logicalActionId,
  );
  expect(action).toMatchObject({
    provider_turn_id: providerTurnId,
    call_ref: callRef,
    action_kind: "send_message",
    state: "Applied",
  });
  expect(
    completed.observations.filter(
      (observation) =>
        observation.source_ref === action?.observation_source_ref,
    ),
  ).toHaveLength(1);
  expect(
    completed.providerAttempts.filter(
      (attempt) => attempt.provider_turn_id === providerTurnId,
    ),
  ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
  expect(actionProviderCalls).toHaveLength(1);

  const workflowOffset = completed.workflowOffsets.find(
    (offset) => offset.project_id === project.projectId,
  );
  expect(workflowOffset?.last_sequence).toBeGreaterThanOrEqual(
    messageEvents[0]?.sequence ?? Number.MAX_SAFE_INTEGER,
  );
  const parentInputEpisodes = completed.inboxExecutions.filter(
    (episode) => episode.episode_ref === inboxEntryKey,
  );
  expect(parentInputEpisodes).toHaveLength(1);
  expect(parentInputEpisodes[0]?.workspace_id).toBe(project.rootWorkspaceId);
  const settledChild = completed.workspaceExecutions.find(
    (execution) => execution.execution_id === oldAction.executionId,
  );
  expect(settledChild?.settled_at).not.toBeNull();
  const childWorkWait = completed.workWaits.find(
    (wait) => wait.work_id === childWorkId,
  );
  expect(childWorkWait).toBeDefined();
  expect(childWorkWait?.wait_mode).toBe("Any");
  expect(JSON.parse(childWorkWait?.conditions_json ?? "[]")).toEqual([
    { _tag: "Manual" },
  ]);
  expect(
    completed.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.provider_turn_id === providerTurnId &&
        action.action_index === 1,
    ),
  ).toMatchObject({ action_kind: "wait" });
  const sourcedCalls = completed.modelOutputCalls
    .filter((row) => row.source_ref.startsWith(`${providerTurnId}:`))
    .map(
      (row) =>
        JSON.parse(row.payload_json) as {
          _tag?: string;
          callRef?: string;
          toolRef?: string;
        },
    );
  expect(sourcedCalls).toHaveLength(2);
  expect(sourcedCalls.map((call) => call.toolRef)).toEqual([
    "send_message",
    "wait",
  ]);
  expect(sourcedCalls.every((call) => call._tag === "ToolCall")).toBe(true);
  expect(completed.messages).toHaveLength(1);
  expect(completed.messageEvents).toHaveLength(1);
  expect(completed.inbox).toHaveLength(1);
  expect(
    completed.workflowDeadLetters.filter(
      (entry) =>
        entry.sequence <=
        (completed.messageEvents[0]?.sequence ?? Number.MIN_SAFE_INTEGER),
    ),
  ).toHaveLength(0);
  expect(newDaemon.daemonErrors).toEqual([]);
};
