import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import type { ProductionFixture } from "../../support/production-fixture.js";

type Ah10AdditionalDaemon = Awaited<
  ReturnType<ProductionFixture["startAdditionalDaemon"]>
>;

interface MessageRow {
  readonly message_id: string;
  readonly correlation_id: string | null;
}

export interface Ah10ReplyScenarioState {
  readonly crashSide: "before" | "after" | "committed";
  readonly queryMarker: string;
  readonly replyMarker: string;
  readonly events: Ah10Probe[];
  readonly queryProviderCalls: number[];
  readonly replyProviderCalls: number[];
  fixture: ProductionFixture | undefined;
  childWorkspaceId: string;
  parentWorkspaceId: string;
  query: MessageRow | undefined;
  oldAction: Ah10Probe | undefined;
  providerTurnId: string | undefined;
  logicalActionId: string | undefined;
  callRef: string | undefined;
  oldLeaseAtIntent:
    | Awaited<ReturnType<typeof readRows>>["leases"][number]
    | undefined;
  newDaemon: Ah10AdditionalDaemon | undefined;
  oldRejectedCommandId: string | undefined;
  beforeCrash: Awaited<ReturnType<typeof readRows>> | undefined;
}

export interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly pauseRequested?: boolean;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
  readonly receivedAt?: number;
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

export const fixtures: ProductionFixture[] = [];
export const ah10Child = resolve(
  "tests/functional/support/process-child.mjs",
);

export const manualWait = (reason: string) => ({
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

export const pushProbe = (events: Ah10Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah10Probe;
    if (event.tag === "AH10_PROBE")
      events.push({ ...event, receivedAt: Date.now() });
  } catch {
    // Daemon logs are retained by the fixture for failure diagnostics.
  }
};

export const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

export const readRows = (databaseFile: string) => {
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

export const fencedReceipts = (rows: ReturnType<typeof readRows>) =>
  rows.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );
