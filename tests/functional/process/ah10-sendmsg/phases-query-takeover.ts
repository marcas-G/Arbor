import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
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
  fixtures,
  manualWait,
  pushProbe,
  readRows,
  releaseGate,
} from "./support.js";

export const ah10SendMsgTakeOverQuery = async (
  crashSide: "before" | "after",
): Promise<void> => {
  const phaseStartedAt = Date.now();
  const markPhase = (phase: string) =>
    console.info(
      `[AH10 Query ${crashSide}] ${phase} +${Date.now() - phaseStartedAt}ms`,
    );
  const marker = `AH10-send-query-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const providerMarkerCalls: number[] = [];
  let probeArmed = false;
  let seedWaitIssued = false;
  let parentWorkspaceId = "";
  const fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    reply: (call, index) => {
      const context = JSON.stringify(call.messages);
      if (!context.includes(marker)) return { _tag: "HttpError", status: 422 };
      const available = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion")
      ) {
        return context.includes("ProposalRecorded(")
          ? { _tag: "Text", text: `Proposed child for ${marker}` }
          : {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: `child-${marker}`,
                rationale: "durable status Query sender for AH10 takeover",
                responsibilityDraft: {
                  purpose: `send a status Query for ${marker}`,
                  ownedResponsibilities: [marker],
                  obligations: ["send one durable Query to the parent"],
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
                  objective: `Send the parent a status Query for ${marker}.`,
                  why: "qualify durable SendMessage ownership across daemon generations",
                  constraints: ["send exactly one Query to the parent"],
                  completionExpectation:
                    "one Query is admitted to the parent Inbox",
                  verificationMission: {
                    goal: `Verify one status Query for ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-send-query-admitted",
                        requirement:
                          "one exact Query is present in the parent Inbox",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                },
              },
            };
      }
      if (!available.has("send_message")) {
        return { _tag: "HttpError", status: 422 };
      }
      if (!probeArmed) {
        seedWaitIssued = true;
        return manualWait(`AH10 Query seed waits for probe ${marker}`);
      }
      providerMarkerCalls.push(index);
      return {
        _tag: "ToolCall",
        name: "send_message",
        arguments: {
          kind: "Query",
          body: `Please report the status for ${marker}.`,
          recipientWorkspaceId: project.rootWorkspaceId,
        },
      };
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
    "AH10 SendMessage generation takeover",
    { resourceSelection: "Profile" },
  );
  parentWorkspaceId = project.rootWorkspaceId;
  const child = await proposeAndApproveChildWithInitialWork(
    client,
    project,
    marker,
    `请为职责 ${marker} 提议子工作区，并安排首个工作发送状态 Query。`,
    {
      name: `child-${marker}`,
      initialWork: {
        objective: `Send the parent a status Query for ${marker}.`,
      },
    },
  );
  markPhase("public project, child Work, and initial approval settled");
  const childWorkspaceId = child.workspaceId;
  const childWorkId = child.currentWork.workId;
  expect(child.currentWork.objective).toBe(
    `Send the parent a status Query for ${marker}.`,
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
    throw new Error("AH10 Query seed Work did not reach its Manual wait");
  }
  expect(seedChildWork).toMatchObject({
    workId: childWorkId,
    revision: 0,
    status: "Open",
  });
  await fixture.crash();
  markPhase("seed daemon stopped");
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
  markPhase("old daemon restarted for generation-zero episode");
  await client.command(project.projectId, "SteerWork", {
    workId: childWorkId,
    workspaceId: childWorkspaceId,
    expectedWorkRevision: seedChildWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume the measured status Query ${marker}.`,
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
    throw new Error("AH10 old SendMessage ActionIntent probe was absent");
  }
  markPhase("old SendMessage intent committed");
  expect(oldAction.callRef).toMatch(/^call_/u);
  expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
  expect(oldAction.logicalActionId).toMatch(/^lac_/u);

  const newDaemon = await fixture.startAdditionalDaemon({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_GATE_ACTION_KIND: "send_message",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
    },
    onStdout: (line) => pushProbe(events, line),
  });
  markPhase("new daemon ready while generation-zero lease is still valid");
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

  // Keep gen0 renewing while the second real daemon boots. Pause only its
  // next renewal after gen1 is ready, so the full 30s lease interval is
  // observed with both processes already running.
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
    throw new Error("AH10 old lease renewal pause probe was absent");
  }
  markPhase("old owner paused its next lease renewal");
  expect(oldLeasePause.fencingGeneration).toBe(0);
  const oldLease = readRows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction.executionId,
  );
  expect(oldLease?.generation).toBe(0);
  const generationZeroExpiresAt = Date.parse(
    oldLease?.expires_at ?? "1970-01-01",
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
    throw new Error("AH10 new SendMessage owner did not acquire the lease");
  }
  expect(newLease.receivedAt).toBeGreaterThanOrEqual(generationZeroExpiresAt);
  markPhase("new daemon acquired generation one after expiry");
  expect(newLease.fencingGeneration).toBe(1);
  expect(
    readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    )?.generation,
  ).toBe(1);
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
    throw new Error("AH10 new SendMessage ActionIntent probe was absent");
  }
  expect(newAction.providerTurnId).toBe(oldAction.providerTurnId);
  expect(newAction.callRef).toBe(oldAction.callRef);
  expect(newAction.logicalActionId).toBe(oldAction.logicalActionId);

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
    if (beforeCommit === undefined) {
      throw new Error("AH10 pre-commit FencingRejected probe was absent");
    }
    expect(beforeCommit.commandId).toMatch(/^cmd_/u);
    oldRejectedCommandId = beforeCommit.commandId ?? "";
    const beforeKill = readRows(fixture.databaseFile);
    expect(
      beforeKill.commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
    expect(beforeKill.messages).toHaveLength(0);
    expect(beforeKill.inbox).toHaveLength(0);
  } else {
    const fenced = await waitForPublic(
      async () =>
        readRows(fixture.databaseFile).commands.filter(
          (command) =>
            command.resolution === "TerminalRejected" &&
            command.terminal_error_json?.includes("FencingRejected"),
        ),
      (commands) => commands.length === 1,
      15_000,
    );
    expect(fenced).toHaveLength(1);
    oldRejectedCommandId = fenced[0]?.command_id ?? "";
    expect(oldRejectedCommandId).toMatch(/^cmd_/u);
    expect(readRows(fixture.databaseFile).messages).toHaveLength(0);
    expect(readRows(fixture.databaseFile).inbox).toHaveLength(0);
  }
  expect(oldRejectedCommandId).toMatch(/^cmd_/u);
  await fixture.crash();
  if (crashSide === "before") {
    const afterKill = readRows(fixture.databaseFile);
    expect(
      afterKill.commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      ),
    ).toHaveLength(0);
    expect(afterKill.messages).toHaveLength(0);
    expect(afterKill.inbox).toHaveLength(0);
  }

  releaseGate(fixture, "new", "action-intent");
  const completed = await waitForPublic(
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

  const message = completed.messages[0];
  expect(message).toMatchObject({
    sender_workspace_id: childWorkspaceId,
    recipient_workspace_id: parentWorkspaceId,
    kind: "Query",
  });
  expect(message?.body_ref).toMatch(/^[a-f0-9]{64}$/u);
  expect(message?.correlation_id).toMatch(/^cor_/u);
  expect(completed.inbox).toEqual([
    expect.objectContaining({
      workspace_id: project.rootWorkspaceId,
      entry_key: `msg:${message?.message_id}`,
      kind: "Message",
      correlation_id: message?.correlation_id,
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
  const rejected = completed.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );
  expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
  expect(completed.actions).toContainEqual(
    expect.objectContaining({
      execution_id: oldAction.executionId,
      provider_turn_id: oldAction.providerTurnId,
      logical_action_id: oldAction.logicalActionId,
      call_ref: oldAction.callRef,
      action_kind: "send_message",
      state: "Applied",
    }),
  );
  expect(
    completed.observations.filter((observation) =>
      observation.source_ref.startsWith(
        `observation_${oldAction.executionId}_`,
      ),
    ),
  ).toHaveLength(1);
  expect(providerMarkerCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
};
