import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../support/public-client.js";

interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
}

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface MessageRow {
  readonly message_id: string;
  readonly sender_workspace_id: string;
  readonly recipient_workspace_id: string;
  readonly kind: string;
  readonly body_ref: string;
  readonly correlation_id: string | null;
}

interface InboxRow {
  readonly workspace_id: string;
  readonly entry_key: string;
  readonly kind: string;
  readonly summary: string;
  readonly correlation_id: string | null;
  readonly consumed_at: string | null;
}

interface CorrelationRow {
  readonly correlation_id: string;
  readonly closed_at: string | null;
}

interface MessageEventRow {
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly correlation_ref: string | null;
  readonly payload_json: string;
}

interface WorkflowOffsetRow {
  readonly project_id: string;
  readonly last_sequence: number;
}

interface AgentLoopStepRow {
  readonly execution_id: string;
  readonly provider_turn_id: string;
  readonly state: string;
  readonly next_action_index: number;
}

interface WorkWaitRow {
  readonly work_id: string;
  readonly wait_mode: string;
  readonly conditions_json: string;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const pushProbe = (events: Ah10Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah10Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Daemon logs are retained by the fixture for failure diagnostics.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

const readRows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Array<{
        execution_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as CommandRow[],
      messages: db
        .prepare(
          "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id FROM messages ORDER BY message_id",
        )
        .all() as unknown as MessageRow[],
      inbox: db
        .prepare(
          "SELECT workspace_id, entry_key, kind, summary, correlation_id, consumed_at FROM inbox_entries WHERE kind = 'Message' ORDER BY entry_key",
        )
        .all() as unknown as InboxRow[],
      correlations: db
        .prepare(
          "SELECT correlation_id, closed_at FROM message_correlations ORDER BY correlation_id",
        )
        .all() as unknown as CorrelationRow[],
      messageEvents: db
        .prepare(
          "SELECT sequence, event_type, aggregate_ref, caused_by_command_id, correlation_ref, payload_json FROM domain_events WHERE event_type = 'MessageSent' ORDER BY sequence",
        )
        .all() as unknown as MessageEventRow[],
      domainEvents: db
        .prepare(
          "SELECT sequence, event_type, event_version, aggregate_ref FROM domain_events ORDER BY sequence",
        )
        .all() as Array<{
        sequence: number;
        event_type: string;
        event_version: number;
        aggregate_ref: string;
      }>,
      workflowOffsets: db
        .prepare(
          "SELECT project_id, last_sequence FROM consumer_offsets WHERE consumer_id = 'workflow-signals' ORDER BY project_id",
        )
        .all() as unknown as WorkflowOffsetRow[],
      workflowDeadLetters: db
        .prepare(
          "SELECT sequence, reason FROM consumer_dead_letters WHERE consumer_id = 'workflow-signals' ORDER BY sequence",
        )
        .all() as Array<{ sequence: number; reason: string }>,
      providerAttempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at FROM provider_attempts ORDER BY provider_turn_id, attempt_no",
        )
        .all() as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        settled_at: string | null;
      }>,
      agentLoopSteps: db
        .prepare(
          "SELECT execution_id, provider_turn_id, state, next_action_index FROM agent_loop_steps ORDER BY updated_at",
        )
        .all() as unknown as AgentLoopStepRow[],
      workWaits: db
        .prepare(
          "SELECT work_id, wait_mode, conditions_json FROM work_waits ORDER BY work_id",
        )
        .all() as unknown as WorkWaitRow[],
      modelOutputCalls: db
        .prepare(
          "SELECT source_ref, payload_json FROM session_entries WHERE source_kind = 'ProviderTurnCall' ORDER BY sequence",
        )
        .all() as Array<{
        source_ref: string;
        payload_json: string;
      }>,
      inboxExecutions: db
        .prepare(
          "SELECT execution_id, workspace_id, episode_ref, settlement_kind, settled_at FROM executions WHERE episode_kind = 'InboxEpisode'",
        )
        .all() as Array<{
        execution_id: string;
        workspace_id: string;
        episode_ref: string;
        settlement_kind: string | null;
        settled_at: string | null;
      }>,
      workspaceExecutions: db
        .prepare(
          `SELECT execution_id, workspace_id, episode_kind, episode_ref,
                  settlement_kind, settled_at FROM executions
            WHERE binding_kind = 'workspace' ORDER BY admitted_at, execution_id`,
        )
        .all() as Array<{
        execution_id: string;
        workspace_id: string;
        episode_kind: string;
        episode_ref: string;
        settlement_kind: string | null;
        settled_at: string | null;
      }>,
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index, a.observation_source_ref, a.call_ref,
                  a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      observations: db
        .prepare(
          `SELECT se.source_ref, se.payload_json
             FROM session_entries se
            WHERE se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
    };
  } finally {
    db.close();
  }
};

const fencedReceipts = (rows: ReturnType<typeof readRows>) =>
  rows.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );

describe("AH10 real daemon SendMessage generation takeover", () => {
  it.each(["before", "after"] as const)(
    "takes over a Query after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-send-query-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      const providerMarkerCalls: number[] = [];
      let probeArmed = false;
      let seedWaitIssued = false;
      let parentWorkspaceId = "";
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          if (!context.includes(marker))
            return { _tag: "HttpError", status: 422 };
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
      probeArmed = true;
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "send_message",
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
      expect(oldAction.callRef).toMatch(/^call_/u);
      expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
      expect(oldAction.logicalActionId).toMatch(/^lac_/u);

      const oldLeasePause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        20_000,
      );
      if (oldLeasePause === undefined) {
        throw new Error("AH10 old lease renewal pause probe was absent");
      }
      expect(oldLeasePause.fencingGeneration).toBe(0);
      const oldLease = readRows(fixture.databaseFile).leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      expect(oldLease?.generation).toBe(0);
      await waitForPublic(
        async () =>
          readRows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

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
        throw new Error("AH10 new SendMessage owner did not acquire the lease");
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
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
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
    },
    90_000,
  );

  it.each(["before", "after", "committed"] as const)(
    "recovers a Reply after gen0 %s its Gateway transaction",
    async (crashSide) => {
      const queryMarker = `AH10-reply-query-${crypto.randomUUID().slice(0, 8)}`;
      const replyMarker = `AH10-reply-work-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      const queryProviderCalls: number[] = [];
      const replyProviderCalls: number[] = [];
      let replyProbeArmed = false;
      let parentSeedWaitIssued = false;
      let parentWorkspaceId = "";
      const fixture = await startProductionFixture({
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
                            requirement:
                              "one Query is admitted to the root Inbox",
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
            latestUser?.includes(`Create Parent Reply Work ${replyMarker}`) ===
              true
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
                    constraints: [
                      "reply to the unique open Query exactly once",
                    ],
                    completionExpectation:
                      "send one Reply bound to the pending Query",
                    verificationMission: {
                      goal: `Verify Reply recovery ${replyMarker}`,
                      criteria: [
                        {
                          criterionId: "ah10-reply-committed",
                          requirement:
                            "one Reply is committed for the open Query",
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
            context.includes(
              `objective: Ask the root for status ${queryMarker}`,
            )
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
        throw new Error(
          "the public Query setup did not persist its correlation",
        );
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
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
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
      let newDaemon:
        | Awaited<ReturnType<typeof fixture.startAdditionalDaemon>>
        | undefined;
      let oldRejectedCommandId: string | undefined;
      let beforeCrash: ReturnType<typeof readRows>;
      if (crashSide === "committed") {
        releaseGate(fixture, "old", "action-intent");
        const handlerReturned = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary ===
                  "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
                event.executionId === oldAction.executionId &&
                event.logicalActionId === logicalActionId &&
                event.callRef === callRef &&
                event.actionIndex === 0,
            ),
          (event) => event !== undefined,
          15_000,
        );
        if (handlerReturned === undefined)
          throw new Error("AH10 post-Reply handler probe was absent");
        beforeCrash = readRows(fixture.databaseFile);
        const committedReply = beforeCrash.messages.find(
          (message) =>
            message.kind === "Reply" &&
            message.sender_workspace_id === project.rootWorkspaceId &&
            message.recipient_workspace_id === childWorkspaceId,
        );
        expect(committedReply).toBeDefined();
        expect(committedReply?.correlation_id).toBe(query.correlation_id);
        expect(beforeCrash.messages).toHaveLength(2);
        expect(
          beforeCrash.correlations.filter(
            (row) =>
              row.correlation_id === query.correlation_id &&
              row.closed_at !== null,
          ),
        ).toHaveLength(1);
        expect(
          beforeCrash.messageEvents.filter(
            (row) => row.aggregate_ref === committedReply?.message_id,
          ),
        ).toHaveLength(1);
        expect(beforeCrash.inbox).toHaveLength(2);
        expect(beforeCrash.actions).toContainEqual(
          expect.objectContaining({
            execution_id: oldAction.executionId,
            provider_turn_id: providerTurnId,
            logical_action_id: logicalActionId,
            call_ref: callRef,
            action_kind: "send_message",
            state: "Pending",
            observation_source_ref: null,
          }),
        );
        expect(
          beforeCrash.observations.filter((row) =>
            row.source_ref.startsWith(`observation_${oldAction.executionId}_`),
          ),
        ).toHaveLength(0);
        expect(
          beforeCrash.providerAttempts.filter(
            (row) => row.provider_turn_id === providerTurnId,
          ),
        ).toEqual([
          expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
        ]);
        expect(replyProviderCalls).toHaveLength(1);
        await fixture.crash();
        await waitForPublic(
          async () =>
            readRows(fixture.databaseFile).leases.find(
              (lease) => lease.execution_id === oldAction.executionId,
            ),
          (lease) =>
            lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
          35_000,
        );
      } else {
        const oldLeasePause = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeLeaseRenewal" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          20_000,
        );
        if (oldLeasePause === undefined)
          throw new Error(
            "AH10 old Reply lease renewal pause probe was absent",
          );
        expect(oldLeasePause.fencingGeneration).toBe(0);
        await waitForPublic(
          async () =>
            readRows(fixture.databaseFile).leases.find(
              (lease) => lease.execution_id === oldAction.executionId,
            ),
          (lease) =>
            lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
          35_000,
        );
        newDaemon = await fixture.startAdditionalDaemon({
          entry: ah10Child,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "new",
            ARBOR_AH10_GATE_ACTION_KIND: "send_message",
            ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          },
          onStdout: (line) => pushProbe(events, line),
        });
        const newLeaseProbe = await waitForPublic(
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
        expect(newLeaseProbe?.fencingGeneration).toBe(1);
        const newIntent = await waitForPublic(
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
        expect(newIntent?.providerTurnId).toBe(providerTurnId);
        expect(newIntent?.logicalActionId).toBe(logicalActionId);
        expect(newIntent?.callRef).toBe(callRef);
        releaseGate(fixture, "old", "action-intent");
        if (crashSide === "before") {
          const precommit = await waitForPublic(
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
          expect(precommit?.commandId).toMatch(/^cmd_/u);
          oldRejectedCommandId = precommit?.commandId;
          const independentRead = readRows(fixture.databaseFile);
          expect(fencedReceipts(independentRead)).toHaveLength(0);
          expect(independentRead.messages).toEqual([query]);
          expect(independentRead.messageEvents).toHaveLength(1);
          expect(independentRead.inbox).toHaveLength(1);
        } else {
          const rejected = await waitForPublic(
            async () => fencedReceipts(readRows(fixture.databaseFile)),
            (rows) => rows.length === 1,
            15_000,
          );
          oldRejectedCommandId = rejected[0]?.command_id;
          expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        }
        await fixture.crash();
        beforeCrash = readRows(fixture.databaseFile);
        expect(fencedReceipts(beforeCrash)).toHaveLength(
          crashSide === "before" ? 0 : 1,
        );
        if (crashSide === "before") {
          expect(
            beforeCrash.commands.some(
              (row) => row.command_id === oldRejectedCommandId,
            ),
          ).toBe(false);
        }
        expect(beforeCrash.messages).toEqual([query]);
        expect(beforeCrash.messageEvents).toHaveLength(1);
        expect(beforeCrash.inbox).toHaveLength(1);
        expect(
          beforeCrash.correlations.filter(
            (row) =>
              row.correlation_id === query.correlation_id &&
              row.closed_at !== null,
          ),
        ).toHaveLength(0);
        expect(beforeCrash.actions).toContainEqual(
          expect.objectContaining({
            execution_id: oldAction.executionId,
            provider_turn_id: providerTurnId,
            logical_action_id: logicalActionId,
            call_ref: callRef,
            action_kind: "send_message",
            state: "Pending",
            observation_source_ref: null,
          }),
        );
        expect(
          beforeCrash.observations.filter((row) =>
            row.source_ref.startsWith(`observation_${oldAction.executionId}_`),
          ),
        ).toHaveLength(0);
        expect(replyProviderCalls).toHaveLength(1);
      }
      if (newDaemon === undefined) {
        newDaemon = await fixture.startAdditionalDaemon({
          entry: ah10Child,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "new",
            ARBOR_AH10_GATE_ACTION_KIND: "send_message",
            ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          },
          onStdout: (line) => pushProbe(events, line),
        });
      }
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
        throw new Error("AH10 new Reply owner did not acquire the lease");
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
        throw new Error("AH10 new Reply ActionIntent probe was absent");
      }
      expect(newAction.providerTurnId).toBe(providerTurnId);
      expect(newAction.callRef).toBe(callRef);
      expect(newAction.logicalActionId).toBe(logicalActionId);
      releaseGate(fixture, "new", "action-intent");
      const recovered = await waitForPublic(
        async () => readRows(fixture.databaseFile),
        (rows) =>
          rows.actions.some(
            (action) =>
              action.execution_id === oldAction.executionId &&
              action.logical_action_id === logicalActionId &&
              action.state === "Applied",
          ),
        30_000,
      );
      const recoveredReply = recovered.messages.filter(
        (message) =>
          message.kind === "Reply" &&
          message.sender_workspace_id === project.rootWorkspaceId &&
          message.recipient_workspace_id === childWorkspaceId,
      );
      expect(recovered.messages).toHaveLength(2);
      expect(recoveredReply).toHaveLength(1);
      const reply = recoveredReply[0];
      expect(reply?.correlation_id).toBe(query.correlation_id);
      expect(recovered.inbox).toHaveLength(2);
      expect(recovered.messageEvents).toHaveLength(2);
      const replyEvents = recovered.messageEvents.filter(
        (event) => event.aggregate_ref === reply?.message_id,
      );
      expect(replyEvents).toHaveLength(1);
      expect(replyEvents[0]).toMatchObject({
        event_type: "MessageSent",
        correlation_ref: query.correlation_id,
      });
      expect(
        recovered.commands.filter((command) => {
          if (
            command.resolution !== "Committed" ||
            command.result_json === null
          ) {
            return false;
          }
          try {
            return (
              (JSON.parse(command.result_json) as { messageId?: string })
                .messageId === reply?.message_id
            );
          } catch {
            return false;
          }
        }),
      ).toHaveLength(1);
      const committedReplyReceipt = recovered.commands.find(
        (command) =>
          command.resolution === "Committed" &&
          command.result_json !== null &&
          (JSON.parse(command.result_json) as { messageId?: string })
            .messageId === reply?.message_id,
      );
      expect(replyEvents[0]?.caused_by_command_id).toBe(
        committedReplyReceipt?.command_id,
      );
      if (crashSide === "committed") {
        expect(
          beforeCrash.commands.find(
            (command) =>
              command.command_id === committedReplyReceipt?.command_id,
          ),
        ).toMatchObject({ resolution: "Committed" });
      } else {
        expect(committedReplyReceipt?.command_id).not.toBe(
          oldRejectedCommandId,
        );
        expect(fencedReceipts(recovered)).toHaveLength(
          crashSide === "before" ? 0 : 1,
        );
      }
      expect(
        recovered.correlations.filter(
          (correlation) =>
            correlation.correlation_id === query.correlation_id &&
            correlation.closed_at !== null,
        ),
      ).toHaveLength(1);
      const recoveredReplyAction = recovered.actions.find(
        (action) =>
          action.execution_id === oldAction.executionId &&
          action.logical_action_id === logicalActionId,
      );
      expect(recoveredReplyAction).toMatchObject({
        provider_turn_id: providerTurnId,
        call_ref: callRef,
        action_kind: "send_message",
        state: "Applied",
      });
      expect(
        recovered.observations.filter(
          (observation) =>
            observation.source_ref ===
            recoveredReplyAction?.observation_source_ref,
        ),
      ).toHaveLength(1);
      expect(
        recovered.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === providerTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
      ]);
      expect(replyProviderCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
    },
    180_000,
  );

  it.each(["before", "after"] as const)(
    "takes over a DecisionRequest after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-decision-request-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      const actionProviderCalls: number[] = [];
      let probeArmed = false;
      let seedWaitIssued = false;
      const fixture = await startProductionFixture({
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
                `AH10 DecisionRequest seed Work waits for probe ${marker}`,
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
        throw new Error(
          "AH10 DecisionRequest seed Work did not reach Manual wait",
        );
      }
      expect(seedChildWork.revision).toBe(0);
      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "send_message",
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

      const oldLeasePause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === oldAction.executionId,
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
      await waitForPublic(
        async () =>
          readRows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

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
          throw new Error(
            "AH10 pre-commit DecisionRequest fence probe was absent",
          );
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
        throw new Error(
          "AH10 gen1 DecisionRequest ActionResult gate was absent",
        );
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
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
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
      expect(messageEvents[0]?.caused_by_command_id).toBe(
        committed[0]?.command_id,
      );
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
      ).toEqual([
        expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
      ]);
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
      expect(parentInputEpisodes[0]?.workspace_id).toBe(
        project.rootWorkspaceId,
      );
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
    },
    120_000,
  );
});
