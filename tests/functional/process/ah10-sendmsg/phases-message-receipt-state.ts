import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../support/lease-qualification.js";
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

export const ah10SendMsgRecoverReceiptState = async ({
  kind,
  crashSide,
}: {
  readonly kind: "Query" | "DecisionRequest" | "Report";
  readonly crashSide: "before" | "after" | "committed";
}): Promise<void> => {
  const marker = `AH10-${kind.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const actionProviderCalls: number[] = [];
  let probeArmed = false;
  let seedWaitIssued = false;
  let parentWorkspaceId = "";
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
          ? { _tag: "Text", text: `Proposed sender ${marker}` }
          : {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: `child-${marker}`,
                rationale: `send one ${kind} to the direct parent`,
                responsibilityDraft: {
                  purpose: `send one ${kind} for ${marker}`,
                  ownedResponsibilities: [marker],
                  obligations: [`send one ${kind} to the parent`],
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
                  objective: `Send one ${kind} to the parent for ${marker}.`,
                  why: `qualify ${kind} receipt recovery across generations`,
                  constraints: [`send exactly one ${kind}`],
                  completionExpectation: `one ${kind} is admitted`,
                  verificationMission: {
                    goal: `Verify ${kind} admission ${marker}`,
                    criteria: [
                      {
                        criterionId: `ah10-${kind.toLowerCase()}-admitted`,
                        requirement: `one exact ${kind} reaches the parent`,
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
        return { _tag: "Text", text: `Received ${kind} ${marker}.` };
      }
      if (
        isWorkEpisode &&
        available.has("send_message") &&
        context.includes(marker)
      ) {
        if (context.includes("MessageDelivered(")) {
          return manualWait(`finish ${kind} qualification ${marker}`);
        }
        if (!probeArmed) {
          seedWaitIssued = true;
          return manualWait(`seed ${kind} Work waits for takeover ${marker}`);
        }
        actionProviderCalls.push(index);
        const sendMessage = {
          name: "send_message",
          arguments: {
            kind,
            body: `Please record ${kind} ${marker}.`,
            ...(kind === "Query"
              ? { recipientWorkspaceId: parentWorkspaceId }
              : {}),
          },
        };
        return kind === "DecisionRequest"
          ? {
              _tag: "ToolCalls",
              calls: [
                sendMessage,
                {
                  name: "wait",
                  arguments: {
                    reason: `wait after ${kind} ${marker}`,
                    waitSpec: {
                      mode: "Any",
                      conditions: [{ _tag: "Manual" }],
                    },
                  },
                },
              ],
            }
          : { _tag: "ToolCall", ...sendMessage };
      }
      return { _tag: "Text", text: `Waiting for ${marker}.` };
    },
    onDaemonStdout: (line) => pushProbe(events, line),
  });
  fixtures.push(fixture);
  mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH10 SendMessage ${kind} recovery`,
    { resourceSelection: "Profile" },
  );
  parentWorkspaceId = project.rootWorkspaceId;
  const child = await proposeAndApproveChildWithInitialWork(
    client,
    project,
    marker,
    `Propose ${marker} as a child sender for one ${kind}.`,
    {
      name: `child-${marker}`,
      initialWork: {
        objective: `Send one ${kind} to the parent for ${marker}.`,
      },
    },
  );
  const childWorkspaceId = child.workspaceId;
  const childWorkId = child.currentWork.workId;
  expect(child.currentWork.objective).toContain(`one ${kind}`);
  const seedWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: unknown;
      } | null>("current-work", { workspaceId: childWorkspaceId }),
    (work) =>
      seedWaitIssued &&
      work?.workId === childWorkId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seedWork === null || seedWork.workId !== childWorkId) {
    throw new Error(`${kind} seed Work did not reach Manual wait`);
  }
  expect(seedWork).toMatchObject({
    workId: childWorkId,
    revision: 0,
    status: "Open",
  });
  await fixture.crash();
  probeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "send_message",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN:
        crashSide === "committed" ? "1" : "0",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "send_message",
      ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE:
        crashSide === "committed" ? "0" : "1",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId: childWorkId,
    workspaceId: childWorkspaceId,
    expectedWorkRevision: seedWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume ${kind} ${marker}.`,
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
  if (
    oldAction?.providerTurnId === undefined ||
    oldAction.logicalActionId === undefined ||
    oldAction.callRef === undefined
  ) {
    throw new Error(`${kind} gen0 ActionIntent omitted its pinned identity`);
  }
  expect(actionProviderCalls).toHaveLength(1);

  let oldRejectedCommandId: string | undefined;
  let newDaemon: Awaited<ReturnType<typeof fixture.startAdditionalDaemon>>;
  if (crashSide === "committed") {
    releaseGate(fixture, "old", "action-intent");
    const returned = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === oldAction.logicalActionId &&
            event.callRef === oldAction.callRef &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      20_000,
    );
    expect(returned).toBeDefined();
    const committedState = readRows(fixture.databaseFile);
    expect(committedState.messages).toHaveLength(1);
    expect(committedState.messageEvents).toHaveLength(1);
    expect(committedState.inbox).toHaveLength(1);
    expect(committedState.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "send_message",
        state: "Pending",
        observation_source_ref: null,
      }),
    );
    expect(
      committedState.observations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(actionProviderCalls).toHaveLength(1);
    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
    newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "send_message",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
  } else {
    const oldLeaseAtIntent = readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLeaseAtIntent?.generation).toBe(0);
    expect(
      Date.parse(oldLeaseAtIntent?.expires_at ?? "1970-01-01"),
    ).toBeGreaterThan(Date.now());
    newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "send_message",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const leaseAfterNewReady = readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(leaseAfterNewReady?.generation).toBe(0);
    expect(
      Date.parse(leaseAfterNewReady?.expires_at ?? "1970-01-01"),
    ).toBeGreaterThan(Date.now());
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === oldAction.executionId,
      ),
    ).toBe(false);
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
    expect(oldLeasePause?.fencingGeneration).toBe(0);
    const oldLeaseAtPause = readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLeaseAtPause?.generation).toBe(0);
    const generationZeroExpiresAt = Date.parse(
      oldLeaseAtPause?.expires_at ?? "1970-01-01",
    );
    expect(generationZeroExpiresAt).toBeGreaterThan(Date.now());
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === oldAction.executionId,
      ),
    ).toBe(false);
    const gen1Lease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) =>
        event !== undefined &&
        (event.receivedAt ?? 0) >= generationZeroExpiresAt,
      45_000,
    );
    expect(gen1Lease?.fencingGeneration).toBe(1);
    await waitForPublic(
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
    const newAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionKind === "send_message" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(newAction).toMatchObject({
      providerTurnId: oldAction.providerTurnId,
      logicalActionId: oldAction.logicalActionId,
      callRef: oldAction.callRef,
    });
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
      oldRejectedCommandId = beforeCommit?.commandId;
      expect(fencedReceipts(readRows(fixture.databaseFile))).toHaveLength(0);
    } else {
      const fenced = await waitForPublic(
        async () => fencedReceipts(readRows(fixture.databaseFile)),
        (rows) => rows.length === 1,
        15_000,
      );
      oldRejectedCommandId = fenced[0]?.command_id;
      expect(oldRejectedCommandId).toMatch(/^cmd_/u);
    }
    await fixture.crash();
  }

  const newLease = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === oldAction.executionId,
      ),
    (event) => event !== undefined && event.fencingGeneration === 1,
    45_000,
  );
  expect(newLease?.fencingGeneration).toBe(1);
  const newAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.executionId === oldAction.executionId &&
          event.actionKind === "send_message" &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  expect(newAction).toMatchObject({
    providerTurnId: oldAction.providerTurnId,
    logicalActionId: oldAction.logicalActionId,
    callRef: oldAction.callRef,
  });

  releaseGate(fixture, "new", "action-intent");
  const messageRows = await waitForPublic(
    async () => readRows(fixture.databaseFile),
    (rows) =>
      rows.actions.some(
        (action) =>
          action.execution_id === oldAction.executionId &&
          action.logical_action_id === oldAction.logicalActionId &&
          action.state === "Applied",
      ) && rows.messages.length === 1,
    30_000,
  );
  const message = messageRows.messages[0];
  expect(message).toMatchObject({
    sender_workspace_id: childWorkspaceId,
    recipient_workspace_id: project.rootWorkspaceId,
    kind,
    correlation_id: kind === "Query" ? expect.stringMatching(/^cor_/u) : null,
  });
  expect(message?.body_ref).toMatch(/^[a-f0-9]{64}$/u);
  expect(messageRows.inbox).toEqual([
    expect.objectContaining({
      workspace_id: project.rootWorkspaceId,
      entry_key: `msg:${message?.message_id}`,
      kind: "Message",
      correlation_id: message?.correlation_id,
    }),
  ]);
  const messageEvent = messageRows.messageEvents.find(
    (event) => event.aggregate_ref === message?.message_id,
  );
  expect(messageEvent).toBeDefined();
  const committedReceipt = messageRows.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null)
      return false;
    try {
      return (
        (JSON.parse(command.result_json) as { messageId?: string })
          .messageId === message?.message_id
      );
    } catch {
      return false;
    }
  });
  expect(committedReceipt).toHaveLength(1);
  expect(messageEvent?.caused_by_command_id).toBe(
    committedReceipt[0]?.command_id,
  );
  expect(fencedReceipts(messageRows)).toHaveLength(
    crashSide === "before" ? 0 : crashSide === "after" ? 1 : 0,
  );
  const committedResult = JSON.parse(
    committedReceipt[0]?.result_json ?? "{}",
  ) as {
    promotion?: {
      closesCorrelation?: string | null;
      triggersReevaluation?: boolean;
    };
  };
  expect(committedResult.promotion).toEqual({
    closesCorrelation: null,
    triggersReevaluation: kind === "DecisionRequest",
  });
  if (kind === "Query") {
    expect(message?.recipient_workspace_id).toBe(parentWorkspaceId);
    expect(message?.correlation_id).toMatch(/^cor_/u);
    expect(
      messageRows.correlations.some(
        (row) =>
          row.correlation_id === message?.correlation_id &&
          row.closed_at !== null,
      ),
    ).toBe(false);
  } else if (kind === "Report") {
    expect(message?.recipient_workspace_id).toBe(project.rootWorkspaceId);
    expect(message?.correlation_id).toBeNull();
    expect(messageEvent).toMatchObject({ correlation_ref: null });
  } else {
    expect(message?.recipient_workspace_id).toBe(project.rootWorkspaceId);
    expect(message?.correlation_id).toBeNull();
    const messageSequence = messageEvent?.sequence ?? Number.MAX_SAFE_INTEGER;
    const offsetBeforeRelease = messageRows.workflowOffsets.find(
      (candidate) => candidate.project_id === project.projectId,
    );
    expect(offsetBeforeRelease?.last_sequence).toBeLessThan(messageSequence);
    // The process child pauses the new owner after the action/result
    // transaction. Release it so the same Work's persisted Wait can run
    // and the daemon can reach its workflow-signal consumer poll.
    releaseGate(fixture, "new", "action-result");
    const completed = await waitForPublic(
      async () => readRows(fixture.databaseFile),
      (rows) => {
        const inputEpisode = rows.inboxExecutions.find(
          (episode) => episode.episode_ref === `msg:${message?.message_id}`,
        );
        const offset = rows.workflowOffsets.find(
          (candidate) => candidate.project_id === project.projectId,
        );
        return (
          inputEpisode !== undefined &&
          offset !== undefined &&
          offset.last_sequence >= messageSequence &&
          rows.workspaceExecutions.some(
            (execution) =>
              execution.execution_id === oldAction.executionId &&
              execution.settled_at !== null,
          )
        );
      },
      30_000,
    );
    expect(
      completed.inboxExecutions.filter(
        (episode) => episode.episode_ref === `msg:${message?.message_id}`,
      ),
    ).toHaveLength(1);
    expect(actionProviderCalls).toHaveLength(1);
    expect(newDaemon.daemonErrors).toEqual([]);
  }
  expect(
    messageRows.actions.filter(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId &&
        action.state === "Applied",
    ),
  ).toHaveLength(1);
  const recoveredMessageAction = messageRows.actions.find(
    (action) =>
      action.execution_id === oldAction.executionId &&
      action.logical_action_id === oldAction.logicalActionId,
  );
  expect(recoveredMessageAction?.observation_source_ref).toEqual(
    expect.any(String),
  );
  expect(
    messageRows.observations.filter(
      (observation) =>
        observation.source_ref ===
        recoveredMessageAction?.observation_source_ref,
    ),
  ).toHaveLength(1);
  expect(actionProviderCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
};
