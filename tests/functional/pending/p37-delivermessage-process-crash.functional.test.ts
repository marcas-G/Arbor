import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import type { PublicClient } from "../support/public-client.js";
import { makePublicClient, waitForPublic } from "../support/public-client.js";

/*
 * P37 L6 is process-crash qualification, not a module/store test. The cases
 * below stay isolated in pending/ until the P37 L4/L5 implementations and
 * commit probes are integrated. The shared scenario helpers will use this
 * dedicated test child with two OS daemons and one file-backed SQLite DB.
 *
 * Required common oracle for every completed case:
 *   - identical LogicalActionId, ProviderTurnId and MessageId before/after;
 *   - CommandId changes with fencing generation when the route is resubmitted;
 *   - one canonical Message, exact MessageSent event, Inbox admission,
 *     Observation and Provider request at most once;
 *   - reads are captured in one SQLite read transaction and public Attention
 *     is checked over the ordinary public view path.
 *
 * TODO(P37 L4): add the public Work seed which produces one Deliverable and
 * stops immediately before the Deliver action is invoked. The fixture/gate/
 * coherent-snapshot helpers below are real; the remaining TODO is the domain
 * seed plus the composed recovery/public-view assertions, not a placeholder
 * production seam.
 */

const fixtures: ProductionFixture[] = [];
const p37Child = resolve("tests/functional/support/p37-deliver-process-child.mjs");

interface P37Probe {
  readonly tag: "P37_DELIVER_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId?: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly commandId?: string;
  readonly messageId?: string;
  readonly attentionFactId?: string;
  readonly projectId?: string;
  readonly fencingGeneration?: number;
}

const startP37Fixture = (input: {
  readonly reply: (
    call: CapturedProviderCall,
    index: number,
  ) => ScriptedProviderResponse;
  readonly onProbe: (probe: P37Probe) => void;
}) =>
  startProductionFixture({
    isolatedPortHandshake: true,
    firstDaemonEntry: p37Child,
    daemonEnvironment: { ARBOR_P37_ROLE: "old" },
    reply: input.reply,
    onDaemonStdout: (line) => {
      try {
        const probe = JSON.parse(line) as P37Probe;
        if (probe.tag === "P37_DELIVER_PROBE") input.onProbe(probe);
      } catch {
        // The fixture retains stderr; unrelated stdout is not a P37 signal.
      }
    },
  });

const releaseP37Gate = (
  fixture: ProductionFixture,
  role: "old" | "new",
  name: string,
) => {
  mkdirSync(resolve(fixture.directory, "p37-gates"), { recursive: true });
  writeFileSync(
    resolve(fixture.directory, "p37-gates", `${role}-${name}.release`),
    "release",
  );
};

const awaitP37Probe = (
  probes: ReadonlyArray<P37Probe>,
  predicate: (probe: P37Probe) => boolean,
) => waitForPublic(async () => probes.find(predicate), (probe) => probe !== undefined);

const readPublicAttention = (client: PublicClient, projectId: string) =>
  client.view<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>(
    "attention",
    { projectId },
  );

const readP37Snapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const commands = db
      .prepare(
        "SELECT command_id, command_type, project_id, resolution, result_json, terminal_error_json FROM commands ORDER BY created_at, command_id",
      )
      .all();
    const messages = db
      .prepare(
        "SELECT message_id, project_id, sender_workspace_id, recipient_workspace_id, kind, deliverable_id, body_ref, correlation_id, causation_id FROM messages WHERE kind = 'Deliver' ORDER BY created_at, message_id",
      )
      .all();
    const messageEvents = db
      .prepare(
        "SELECT event_id, project_id, event_type, aggregate_ref, correlation_ref, caused_by_command_id, payload_json FROM domain_events WHERE event_type = 'MessageSent' ORDER BY sequence",
      )
      .all();
    const replayEvents = db
      .prepare(
        "SELECT event_id, project_id, event_type, aggregate_ref, correlation_ref, caused_by_command_id, payload_json FROM domain_events WHERE event_type = 'DeliverReplayEscalated' ORDER BY sequence",
      )
      .all();
    const inbox = db
      .prepare(
        "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at FROM inbox_entries WHERE entry_key LIKE 'msg:%' ORDER BY workspace_id, entry_key",
      )
      .all();
    const actions = db
      .prepare(
        `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                a.action_index, a.observation_source_ref, a.call_ref,
                a.action_kind, a.state
           FROM agent_loop_step_actions a
           JOIN agent_loop_steps s
             ON s.execution_id = a.execution_id
            AND s.logical_step_no = a.logical_step_no
            AND s.repair_attempt = a.repair_attempt
          WHERE a.action_kind = 'deliver' ORDER BY a.action_index`,
      )
      .all();
    const observations = db
      .prepare(
        `SELECT source_ref, payload_json FROM session_entries
          WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'
          ORDER BY sequence`,
      )
      .all();
    const facts = db
      .prepare(
        `SELECT attention_fact_id, event_id, project_id, execution_id,
                target_workspace_id, logical_action_id, message_id,
                failure_code, first_detected_at
           FROM deliver_replay_attention_facts ORDER BY attention_fact_id`,
      )
      .all();
    const pendingFacts = db
      .prepare(
        "SELECT queue_sequence, attention_fact_id FROM deliver_replay_attention_pending ORDER BY queue_sequence",
      )
      .all();
    const markers = db
      .prepare(
        "SELECT attention_fact_id FROM deliver_replay_attention_rows ORDER BY attention_fact_id",
      )
      .all();
    const attentionOffsets = db
      .prepare(
        "SELECT consumer_id, project_id, last_sequence FROM consumer_offsets WHERE consumer_id = 'p10-rebuild:attention' ORDER BY project_id",
      )
      .all();
    return {
      commands,
      messages,
      messageEvents,
      replayEvents,
      inbox,
      actions,
      observations,
      facts,
      pendingFacts,
      markers,
      attentionOffsets,
    };
  } finally {
    db.exec("COMMIT");
    db.close();
  }
};

// These types are intentionally retained in the pending file: the later L6
// test bodies use the ordinary public client to check the ActionRequired row.
void readPublicAttention;
void makePublicClient;
void awaitP37Probe;
void releaseP37Gate;
void readP37Snapshot;
void startP37Fixture;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("pending P37 L6 DeliverMessage real-process crash matrix", () => {
  it.todo(
    "kills gen0 immediately before FencingRejected receipt commit; gen1 commits the same logical delivery once",
  );
  it.todo(
    "kills gen0 immediately after FencingRejected receipt commit; gen1 observes the exact old rejection before committing once",
  );
  it.todo(
    "kills after DeliverMessage receipt/effect commit but before Action/Observation commit; restart converges receipt-first without another Provider request",
  );
  it.todo(
    "kills on both sides of the atomic P9 DeliverReplay event + fact + pending-outbox commit; restart retains exactly one fact/event/queue item",
  );
  it.todo(
    "kills before P10 marker + P9 queue ACK + P1 offset commit and after that commit; restart produces exactly one public ActionRequired row",
  );
  it.todo(
    "keeps a contradictory old receipt/effect visible as public ActionRequired and never silently replays or writes an Observation",
  );
});

