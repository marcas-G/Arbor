import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10Probe,
  type Ah10ReplyScenarioState,
  ah10Child,
  fixtures,
  manualWait,
  pushProbe,
  readRows,
} from "./support.js";

export const ah10SendMsgReplyScenario = async (
  crashSide: "before" | "after" | "committed",
): Promise<Ah10ReplyScenarioState> => {
  const queryMarker = `AH10-reply-query-${crypto.randomUUID().slice(0, 8)}`;
  const replyMarker = `AH10-reply-work-${crypto.randomUUID().slice(0, 8)}`;
  const events: Ah10Probe[] = [];
  const queryProviderCalls: number[] = [];
  const replyProviderCalls: number[] = [];
  let replyProbeArmed = false;
  let parentSeedWaitIssued = false;
  let parentWorkspaceId = "";
  const fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    onDaemonStdout: (line) => pushProbe(events, line),
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
        latestUser?.includes(`Propose ${queryMarker}`) === true
      ) {
        return context.includes("ProposalRecorded(")
          ? { _tag: "Text", text: `Proposed Query sender ${queryMarker}` }
          : {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: `child-${queryMarker}`,
                rationale: "ask the root for one status reply",
                responsibilityDraft: {
                  purpose: `ask the root for status ${queryMarker}`,
                  ownedResponsibilities: [queryMarker],
                  obligations: ["send one Query to the root Workspace"],
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
                  objective: `Ask the root for status ${queryMarker}.`,
                  why: "create an exact open Query for Reply recovery qualification",
                  constraints: ["send only one Query to the parent"],
                  completionExpectation:
                    "the exact Query is admitted to the root Inbox",
                  verificationMission: {
                    goal: `Verify Query admission ${queryMarker}`,
                    criteria: [
                      {
                        criterionId: "ah10-reply-query-admitted",
                        requirement: "one Query is admitted to the root Inbox",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                },
              },
            };
      }

      if (
        !isWorkEpisode &&
        available.has("assign_work") &&
        latestUser?.includes(`Create Parent Reply Work ${replyMarker}`) === true
      ) {
        return context.includes("WorkAssigned(")
          ? {
              _tag: "Text",
              text: `Parent Reply Work admitted ${replyMarker}`,
            }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Reply to the pending status Query ${replyMarker}.`,
                why: "qualify receipt-first recovery of a committed Reply",
                constraints: ["reply to the unique open Query exactly once"],
                completionExpectation:
                  "send one Reply bound to the pending Query",
                verificationMission: {
                  goal: `Verify Reply recovery ${replyMarker}`,
                  criteria: [
                    {
                      criterionId: "ah10-reply-committed",
                      requirement: "one Reply is committed for the open Query",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "AH10 Reply process fixture",
              },
            };
      }

      if (
        isWorkEpisode &&
        available.has("send_message") &&
        context.includes(`objective: Ask the root for status ${queryMarker}`)
      ) {
        if (context.includes("MessageDelivered(")) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: "the status Query has been sent",
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            },
          };
        }
        queryProviderCalls.push(index);
        return {
          _tag: "ToolCall",
          name: "send_message",
          arguments: {
            kind: "Query",
            body: `Please send a status reply for ${queryMarker}.`,
            recipientWorkspaceId: parentWorkspaceId,
          },
        };
      }

      if (!isWorkEpisode && available.has("send_message")) {
        return {
          _tag: "Text",
          text: `Received status Query ${queryMarker}.`,
        };
      }

      if (
        isWorkEpisode &&
        available.has("send_message") &&
        context.includes(replyMarker)
      ) {
        if (!replyProbeArmed) {
          parentSeedWaitIssued = true;
          return manualWait(
            `AH10 Parent Reply Work waits for probe ${replyMarker}`,
          );
        }
        if (context.includes("MessageDelivered(")) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: "the pending Query has been answered",
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            },
          };
        }
        replyProviderCalls.push(index);
        return {
          _tag: "ToolCall",
          name: "send_message",
          arguments: {
            kind: "Reply",
            body: `The requested status for ${queryMarker} is ready.`,
          },
        };
      }

      return { _tag: "Text", text: "No additional AH10 message action." };
    },
  });
  fixtures.push(fixture);

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH10 SendMessage Reply recovery",
    { resourceSelection: "Profile" },
  );
  parentWorkspaceId = project.rootWorkspaceId;
  const child = await proposeAndApproveChildWithInitialWork(
    client,
    project,
    queryMarker,
    `Propose ${queryMarker} as a status-Query sender with its first Work.`,
    {
      name: `child-${queryMarker}`,
      initialWork: {
        objective: `Ask the root for status ${queryMarker}.`,
      },
    },
  );
  const childWorkspaceId = child.workspaceId;
  expect(child.currentWork.objective).toBe(
    `Ask the root for status ${queryMarker}.`,
  );

  const queryReady = await waitForPublic(
    async () => readRows(fixture.databaseFile),
    (rows) => {
      const query = rows.messages.find(
        (message) =>
          message.kind === "Query" &&
          message.sender_workspace_id === childWorkspaceId &&
          message.recipient_workspace_id === project.rootWorkspaceId,
      );
      if (query === undefined) return false;
      const entryKey = `msg:${query.message_id}`;
      const inbox = rows.inbox.find(
        (entry) =>
          entry.workspace_id === project.rootWorkspaceId &&
          entry.entry_key === entryKey,
      );
      const inputExecution = rows.inboxExecutions.find(
        (execution) => execution.episode_ref === entryKey,
      );
      return (
        inbox?.consumed_at !== null &&
        inbox?.consumed_at !== undefined &&
        inputExecution?.settled_at !== null &&
        inputExecution?.settled_at !== undefined
      );
    },
    45_000,
  );
  const query = queryReady.messages.find(
    (message) =>
      message.kind === "Query" &&
      message.sender_workspace_id === childWorkspaceId &&
      message.recipient_workspace_id === project.rootWorkspaceId,
  );
  if (query === undefined || query.correlation_id === null) {
    throw new Error("the public Query setup did not persist its correlation");
  }
  expect(queryProviderCalls).toHaveLength(1);
  expect(queryReady.messages).toEqual([query]);
  expect(queryReady.inbox).toHaveLength(1);
  expect(queryReady.correlations).not.toContainEqual(
    expect.objectContaining({
      correlation_id: query.correlation_id,
      closed_at: expect.any(String),
    }),
  );
  const queryReceipt = queryReady.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    try {
      return (
        (JSON.parse(command.result_json) as { messageId?: string })
          .messageId === query.message_id
      );
    } catch {
      return false;
    }
  });
  expect(queryReceipt).toHaveLength(1);
  const queryEvents = queryReady.messageEvents.filter(
    (event) => event.aggregate_ref === query.message_id,
  );
  expect(queryEvents).toHaveLength(1);
  expect(queryEvents[0]).toMatchObject({
    event_type: "MessageSent",
    caused_by_command_id: queryReceipt[0]?.command_id,
    correlation_ref: query.correlation_id,
  });
  expect(queryReady.inbox).toContainEqual(
    expect.objectContaining({
      workspace_id: project.rootWorkspaceId,
      entry_key: `msg:${query.message_id}`,
      kind: "Message",
      correlation_id: query.correlation_id,
    }),
  );

  const parentWork = await admitRootWorkThroughPublicConversation(
    client,
    project,
    replyMarker,
    `Create Parent Reply Work ${replyMarker}`,
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
    throw new Error("AH10 Reply Parent Work did not reach Manual wait");
  }
  expect(seedParentWork.revision).toBe(0);
  await fixture.crash();
  replyProbeArmed = true;
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "send_message",
      ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE:
        crashSide === "committed" ? "0" : "1",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN:
        crashSide === "committed" ? "1" : "0",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "send_message",
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
      guidance: `Resume Parent Reply action ${replyMarker}.`,
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
    throw new Error("AH10 old Reply ActionIntent probe was absent");
  }
  const providerTurnId = oldAction.providerTurnId;
  const logicalActionId = oldAction.logicalActionId;
  const callRef = oldAction.callRef;
  if (
    providerTurnId === undefined ||
    logicalActionId === undefined ||
    callRef === undefined
  ) {
    throw new Error("AH10 Reply ActionIntent omitted its pinned identity");
  }
  expect(replyProviderCalls).toHaveLength(1);
  const oldLeaseAtIntent = readRows(fixture.databaseFile).leases.find(
    (lease) => lease.execution_id === oldAction.executionId,
  );
  expect(oldLeaseAtIntent?.generation).toBe(0);
  expect(
    Date.parse(oldLeaseAtIntent?.expires_at ?? "1970-01-01"),
  ).toBeGreaterThan(Date.now());
  return {
    crashSide,
    queryMarker,
    replyMarker,
    events,
    queryProviderCalls,
    replyProviderCalls,
    fixture,
    childWorkspaceId,
    parentWorkspaceId,
    query,
    oldAction,
    providerTurnId: providerTurnId as string,
    logicalActionId: logicalActionId as string,
    callRef: callRef as string,
    oldLeaseAtIntent,
    newDaemon: undefined,
    oldRejectedCommandId: undefined,
    beforeCrash: undefined,
  };
};
