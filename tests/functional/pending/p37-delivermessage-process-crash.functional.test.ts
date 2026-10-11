import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { DomainEventJournalLive } from "../../../adapters/persistence-sqlite/src/index.js";
import { deliverHandler } from "../../../apps/single-workspace/src/control-actions.js";
import type { AgentActionHandlerInput } from "../../../packages/agent-runtime/src/index.js";
import { newUuid7 } from "../../../packages/application/src/index.js";
import {
  Clock,
  DeliverableRepository,
  DomainEventJournal,
  IdGenerator,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "../../../packages/ports/src/index.js";
import { makeP7App, runP7 } from "../../support/p7-app.js";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import type { PublicClient } from "../support/public-client.js";
import {
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../support/public-client.js";

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
 * TODO(P37 L4): finish the public Work seed/recovery matrix cases; the fixture,
 * process gates and coherent SQLite snapshot below are executable. Do not move
 * this pending file into the default qualification suite until all six cases
 * replace their TODOs with real assertions.
 */

const fixtures: ProductionFixture[] = [];
const p37Child = resolve(
  "tests/functional/support/p37-deliver-process-child.mjs",
);
const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});
const deliverOccurrence = (providerTurnId: string) => `${providerTurnId}:0`;
const expectedDeliverCommandId = (
  providerTurnId: string,
  generation: number,
) => {
  const occurrence = deliverOccurrence(providerTurnId);
  const seed =
    generation === 0 ? occurrence : `${occurrence}:generation:${generation}`;
  return `cmd_${newUuid7("deliver-command", seed)}`;
};
const expectedDeliverMessageId = (providerTurnId: string) =>
  `msg_${newUuid7("deliver-message", deliverOccurrence(providerTurnId))}`;

interface P37Probe {
  readonly tag: "P37_DELIVER_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId?: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly commandId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly messageId?: string;
  readonly attentionFactId?: string;
  readonly failureCode?: string;
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
    admitWorkspaceDirectory: true,
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
) =>
  waitForPublic(
    async () => probes.find(predicate),
    (probe) => probe !== undefined,
  );

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
    const deliverables = db
      .prepare(
        "SELECT deliverable_id, source_work_id, kind FROM deliverables ORDER BY created_at, deliverable_id",
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
        `SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at
           FROM inbox_entries
          WHERE entry_key IN (
            SELECT 'msg:' || message_id FROM messages WHERE kind = 'Deliver'
          )
          ORDER BY workspace_id, entry_key`,
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
    const leases = db
      .prepare(
        "SELECT execution_id, generation, expires_at FROM execution_leases ORDER BY execution_id",
      )
      .all();
    const executions = db
      .prepare(
        `SELECT execution_id, project_id, workspace_id, episode_kind,
                episode_ref, episode_revision, session_id, admitted_at,
                stop_requested_at, settlement_kind
           FROM executions ORDER BY admitted_at, execution_id`,
      )
      .all();
    return {
      commands,
      messages,
      deliverables,
      messageEvents,
      replayEvents,
      inbox,
      actions,
      observations,
      facts,
      pendingFacts,
      markers,
      attentionOffsets,
      leases,
      executions,
    };
  } finally {
    db.exec("COMMIT");
    db.close();
  }
};

const seedDeliverableWaitingForDelivery = async (marker: string) => {
  const probes: P37Probe[] = [];
  let seedWaitIssued = false;
  let deliverArmed = false;
  let deliverDecisionCalls = 0;
  let workspacePath = "";
  const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
    const context = JSON.stringify(call.messages);
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
      latestUser?.includes(marker) === true
    ) {
      return {
        _tag: "ToolCall",
        name: "propose_workspace",
        arguments: {
          name: `p37-producer-${marker}`,
          rationale: "P37 L6 process crash fixture",
          responsibilityDraft: {
            purpose: `produce ${marker}`,
            ownedResponsibilities: [marker],
            obligations: ["produce and deliver a formal result"],
            includes: [],
            excludes: [],
            interfaces: [],
          },
          resourceBoundaryDraft: {
            addresses: [{ _tag: "FileTree", path: workspacePath }],
          },
          initialWork: {
            objective: `Produce and deliver ${marker}.`,
            why: "qualify DeliverMessage process recovery",
            constraints: ["use the admitted functional proof file"],
            completionExpectation: "one Deliver handover",
            verificationMission: {
              goal: `Verify ${marker} handover`,
              criteria: [
                {
                  criterionId: "p37-one-handover",
                  requirement: "one exact Deliver Message is committed",
                  required: true,
                },
              ],
              riskRequirements: [],
            },
          },
        },
      };
    }
    if (context.includes(`objective: Produce and deliver ${marker}`)) {
      const artifactId = /art_[0-9a-f-]{36}/u.exec(context)?.[0];
      const deliverableId = /del_[0-9a-f-]{36}/u.exec(context)?.[0];
      if (artifactId === undefined) {
        return {
          _tag: "ToolCall",
          name: "read",
          arguments: {
            target: { mount: "workspace", path: "proof.txt" },
            limit: 200,
          },
        };
      }
      if (deliverableId === undefined) {
        return {
          _tag: "ToolCall",
          name: "produce_deliverable",
          arguments: {
            kind: "p37-process-report",
            artifacts: [{ role: "result", artifactId }],
          },
        };
      }
      if (!deliverArmed) {
        seedWaitIssued = true;
        return manualWait(`P37 seed waits before Deliver ${marker}`);
      }
      if (!context.includes("DeliverableDelivered(")) {
        deliverDecisionCalls += 1;
        return {
          _tag: "ToolCall",
          name: "deliver",
          arguments: {
            deliverableId,
            summary: `Delivered ${marker}`,
          },
        };
      }
      return manualWait(`P37 delivery settled ${marker}`);
    }
    return { _tag: "HttpError", status: 422 };
  };
  const fixture = await startP37Fixture({
    reply,
    onProbe: (probe) => probes.push(probe),
  });
  fixtures.push(fixture);
  workspacePath = fixture.workspaceDirectory;
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `P37 Deliver ${marker}`,
    { resourceSelection: "Profile" },
  );
  const producer = await proposeAndApproveChildWithInitialWork(
    client,
    project,
    marker,
    `Please propose a producer workspace for ${marker}.`,
    {
      name: `p37-producer-${marker}`,
      rationale: "P37 L6 process crash fixture",
      responsibilityDraft: {
        purpose: `produce ${marker}`,
        ownedResponsibilities: [marker],
        obligations: ["produce and deliver a formal result"],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      resourceBoundaryDraft: {
        addresses: [{ _tag: "FileTree", path: fixture.workspaceDirectory }],
      },
      initialWork: { objective: `Produce and deliver ${marker}.` },
    },
  );
  const seededWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: producer.workspaceId }),
    (work) =>
      seedWaitIssued &&
      work?.workId === producer.currentWork.workId &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  if (seededWork === null || seededWork.workId === undefined) {
    throw new Error(`P37 seed Work did not reach Manual wait for ${marker}`);
  }
  const before = readP37Snapshot(fixture.databaseFile);
  const deliverable = before.deliverables.find(
    (row) => row.source_work_id === seededWork.workId,
  );
  if (deliverable === undefined) {
    throw new Error(`P37 seed Deliverable is absent for ${marker}`);
  }
  return {
    fixture,
    client,
    project,
    producer,
    seededWork,
    deliverable,
    probes,
    armDeliver: () => {
      deliverArmed = true;
    },
    get deliverDecisionCalls() {
      return deliverDecisionCalls;
    },
  };
};

const deliverAndHoldCommittedReceipt = async (marker: string) => {
  const seed = await seedDeliverableWaitingForDelivery(marker);
  seed.armDeliver();
  await seed.fixture.crash();
  await seed.fixture.restart({
    entry: p37Child,
    daemonEnvironment: {
      ARBOR_P37_ROLE: "old",
      ARBOR_P37_PAUSE_ROLE: "old",
      ARBOR_P37_PAUSE_BOUNDARY:
        "AH10AfterControlHandlerReturnBeforeObservationCommit",
      ARBOR_P37_GATE_ACTION_KIND: "deliver",
    },
  });
  await seed.client.command(seed.project.projectId, "SteerWork", {
    workId: seed.seededWork.workId,
    workspaceId: seed.producer.workspaceId,
    expectedWorkRevision: seed.seededWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume the measured Deliver action ${marker}.`,
    },
    provenance: { source: "HumanInput" },
  });
  const held = await awaitP37Probe(
    seed.probes,
    (probe) =>
      probe.role === "old" &&
      probe.boundary === "AH10AfterControlHandlerReturnBeforeObservationCommit",
  );
  if (held?.executionId === undefined) {
    throw new Error(`P37 committed Deliver action did not pause for ${marker}`);
  }
  const snapshot = readP37Snapshot(seed.fixture.databaseFile);
  const receipt = snapshot.commands.find(
    (row) =>
      row.command_type === "DeliverMessage" && row.resolution === "Committed",
  );
  const action = snapshot.actions.find(
    (row) =>
      (row as { logical_action_id?: string }).logical_action_id ===
      held.logicalActionId,
  );
  const message = snapshot.messages.find(
    (row) => (row as { message_id?: string }).message_id !== undefined,
  );
  if (receipt === undefined || action === undefined || message === undefined) {
    throw new Error(
      `P37 committed receipt/effect/action seed is incomplete for ${marker}`,
    );
  }
  return {
    ...seed,
    held,
    receipt: receipt as { command_id: string },
    action: action as {
      execution_id: string;
      provider_turn_id: string;
      logical_action_id: string;
      state: string;
    },
    message: message as { message_id: string },
  };
};

const corruptDeliverReceiptResult = (
  databaseFile: string,
  commandId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare("UPDATE commands SET result_json = '{}' WHERE command_id = ?")
      .run(commandId);
    if (Number(result.changes) !== 1) {
      throw new Error(`P37 could not corrupt exact receipt ${commandId}`);
    }
  } finally {
    db.close();
  }
};

const prepareContradictoryCommittedReceipt = async (marker: string) => {
  const prepared = await deliverAndHoldCommittedReceipt(marker);
  await prepared.fixture.crash();
  corruptDeliverReceiptResult(
    prepared.fixture.databaseFile,
    prepared.receipt.command_id,
  );
  return prepared;
};

const waitForLeaseExpiry = async (databaseFile: string, executionId: string) =>
  waitForPublic(
    async () =>
      readP37Snapshot(databaseFile).leases.find(
        (lease) =>
          (lease as { execution_id: string }).execution_id === executionId,
      ),
    (lease) =>
      lease !== undefined &&
      Date.parse((lease as { expires_at: string }).expires_at) <= Date.now(),
    40_000,
  );

const startP37RecoveryDaemon = (
  fixture: ProductionFixture,
  role: "new",
  probes: P37Probe[],
  boundaries?: string,
) =>
  fixture.startAdditionalDaemon({
    entry: p37Child,
    daemonEnvironment: {
      ARBOR_P37_ROLE: role,
      ...(boundaries === undefined
        ? {}
        : {
            ARBOR_P37_PAUSE_ROLE: role,
            ARBOR_P37_PAUSE_BOUNDARY: boundaries,
          }),
    },
    onStdout: (line) => {
      try {
        const probe = JSON.parse(line) as P37Probe;
        if (probe.tag === "P37_DELIVER_PROBE") probes.push(probe);
      } catch {
        // The fixture retains stderr; unrelated stdout is not a P37 signal.
      }
    },
  });

const restartP37Normally = async (fixture: ProductionFixture) =>
  fixture.restart({
    entry: p37Child,
    daemonEnvironment: { ARBOR_P37_ROLE: "new" },
  });

const publicDeliverReplayRows = async (
  client: PublicClient,
  projectId: string,
) => {
  const attention = await readPublicAttention(client, projectId);
  return attention.rows.filter((row) => row.source === "DeliverReplayFailure");
};

const executeLegacyDirectDeliver = async (input: {
  readonly databaseFile: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workId: string;
  readonly deliverableId: string;
  readonly providerTurnId: string;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly summary: string;
}) => {
  const base = makeP7App(input.databaseFile);
  const journal = Layer.provide(
    DomainEventJournalLive,
    base as unknown as Layer.Layer<SqlClient | IdGenerator>,
  );
  const app = Layer.mergeAll(base, journal);
  const activeExecution = {
    executionId: input.executionId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    binding: {
      _tag: "WorkspaceExecution" as const,
      workspaceId: input.workspaceId,
      episode: {
        _tag: "WorkEpisode" as const,
        workId: input.workId,
        targetWorkRevision: 0,
      },
    },
    admittedAt: "t",
    stopRequestedAt: null,
    state: { status: "Active" as const, settlement: null },
  };
  return runP7(
    Effect.gen(function* () {
      const handler = deliverHandler({
        deliverables: yield* DeliverableRepository,
        journal: yield* DomainEventJournal,
        ids: yield* IdGenerator,
        works: yield* WorkRepository,
        workspaces: yield* WorkspaceRepository,
        messages: yield* MessageStore,
        inbox: yield* InboxProjectionStore,
        clock: yield* Clock,
        tx: yield* TransactionPort,
      });
      return yield* Effect.exit(
        handler.handle({
          action: {
            _tag: "Deliver",
            deliverableId: input.deliverableId,
            summary: input.summary,
          },
          invocation: {
            providerTurnId: input.providerTurnId,
            outputPosition: 0,
            callRef: input.callRef,
            toolName: "deliver",
            argumentsJson: JSON.stringify({
              deliverableId: input.deliverableId,
              summary: input.summary,
            }),
          },
          execution: activeExecution,
          context: {
            _tag: "ExecutionOrigin",
            principal: "agent:deliver-child",
            executionId: input.executionId,
            fencingGeneration: 0,
          },
          logicalActionId: input.logicalActionId,
        } as AgentActionHandlerInput),
      );
    }),
    app,
  );
};

// These types are intentionally retained in the pending file: the later L6
// test bodies use the ordinary public client to check the ActionRequired row.
void readPublicAttention;
void makePublicClient;
void awaitP37Probe;
void releaseP37Gate;
void readP37Snapshot;
void startP37Fixture;
void seedDeliverableWaitingForDelivery;
void manualWait;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("pending P37 L6 DeliverMessage real-process crash matrix", () => {
  it.each(["before", "after"] as const)(
    "kills gen0 %s its FencingRejected receipt commit; gen1 commits the same logical delivery once",
    async (crashSide) => {
      const marker = `P37-L6-FENCE-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const seed = await seedDeliverableWaitingForDelivery(marker);
      const { fixture, client, producer, seededWork, probes } = seed;
      seed.armDeliver();
      await fixture.crash();
      const oldBoundaries = [
        "AH7AfterActionIntentCommit",
        crashSide === "before"
          ? "AH10BeforeFencedReceiptCommit"
          : "AH10AfterControlHandlerReturnBeforeObservationCommit",
      ].join(",");
      await fixture.restart({
        entry: p37Child,
        daemonEnvironment: {
          ARBOR_P37_ROLE: "old",
          ARBOR_P37_PAUSE_ROLE: "old",
          ARBOR_P37_PAUSE_BOUNDARY: oldBoundaries,
          ARBOR_P37_GATE_ACTION_KIND: "deliver",
        },
      });
      await client.command(seed.project.projectId, "SteerWork", {
        workId: seededWork.workId,
        workspaceId: producer.workspaceId,
        expectedWorkRevision: seededWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume the measured Deliver action ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });

      const oldAction = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "old" &&
          probe.boundary === "AH7AfterActionIntentCommit" &&
          probe.actionKind === "deliver",
      );
      if (oldAction === undefined || oldAction.executionId === undefined) {
        throw new Error("P37 gen0 Deliver action intent probe is absent");
      }
      expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
      expect(oldAction.logicalActionId).toMatch(/^act_/u);

      await waitForPublic(
        async () =>
          readP37Snapshot(fixture.databaseFile).leases.find(
            (lease) =>
              (lease as { execution_id: string }).execution_id ===
              oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined &&
          Date.parse((lease as { expires_at: string }).expires_at) <=
            Date.now(),
        40_000,
      );
      const newDaemon = await fixture.startAdditionalDaemon({
        entry: p37Child,
        daemonEnvironment: {
          ARBOR_P37_ROLE: "new",
          ARBOR_P37_PAUSE_ROLE: "new",
          ARBOR_P37_PAUSE_BOUNDARY: "AH7AfterActionIntentCommit",
          ARBOR_P37_GATE_ACTION_KIND: "deliver",
        },
        onStdout: (line) => {
          try {
            const probe = JSON.parse(line) as P37Probe;
            if (probe.tag === "P37_DELIVER_PROBE") probes.push(probe);
          } catch {
            // The fixture retains stderr; unrelated stdout is not a P37 signal.
          }
        },
      });
      const newLease = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === "AH10AfterLeaseAcquired" &&
          probe.executionId === oldAction.executionId,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === "AH7AfterActionIntentCommit" &&
          probe.executionId === oldAction.executionId &&
          probe.actionKind === "deliver",
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

      releaseP37Gate(fixture, "old", "boundary-AH7AfterActionIntentCommit");
      let oldPrecommitCommandId: string | undefined;
      if (crashSide === "before") {
        const oldPrecommit = await awaitP37Probe(
          probes,
          (probe) =>
            probe.role === "old" &&
            probe.boundary === "AH10BeforeFencedReceiptCommit" &&
            probe.executionId === oldAction.executionId,
        );
        expect(oldPrecommit?.commandId).toMatch(/^cmd_/u);
        oldPrecommitCommandId = oldPrecommit?.commandId;
        const uncommittedSnapshot = readP37Snapshot(fixture.databaseFile);
        expect(
          uncommittedSnapshot.commands.filter(
            (row) =>
              row.resolution === "TerminalRejected" &&
              String(row.terminal_error_json).includes("FencingRejected"),
          ),
        ).toHaveLength(0);
        await fixture.crash();
      } else {
        const afterCommit = await awaitP37Probe(
          probes,
          (probe) =>
            probe.role === "old" &&
            probe.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            probe.executionId === oldAction.executionId,
        );
        expect(afterCommit?.logicalActionId).toBe(oldAction.logicalActionId);
        const committedSnapshot = readP37Snapshot(fixture.databaseFile);
        const rejectedReceipt = committedSnapshot.commands.find(
          (row) =>
            row.resolution === "TerminalRejected" &&
            String(row.terminal_error_json).includes("FencingRejected"),
        );
        expect(rejectedReceipt).toBeDefined();
        oldPrecommitCommandId = (rejectedReceipt as { command_id: string })
          .command_id;
        await fixture.crash();
      }

      releaseP37Gate(fixture, "new", "boundary-AH7AfterActionIntentCommit");
      const newActionTurn = await waitForPublic(
        async () => readP37Snapshot(fixture.databaseFile),
        (snapshot) =>
          snapshot.actions.some(
            (action) =>
              (action as { logical_action_id?: string }).logical_action_id ===
                oldAction.logicalActionId &&
              (action as { state?: string }).state === "Applied",
          ),
        60_000,
      );
      const oldRejects = newActionTurn.commands.filter(
        (row) =>
          row.resolution === "TerminalRejected" &&
          String(row.terminal_error_json).includes("FencingRejected"),
      );
      const committed = newActionTurn.commands.filter(
        (row) =>
          row.command_type === "DeliverMessage" &&
          row.resolution === "Committed",
      );
      expect(oldRejects).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(committed).toHaveLength(1);
      const gen1CommandId = (committed[0] as { command_id: string }).command_id;
      expect(gen1CommandId).toBe(
        expectedDeliverCommandId(oldAction.providerTurnId as string, 1),
      );
      if (crashSide === "before") {
        expect(oldPrecommitCommandId).toBe(
          expectedDeliverCommandId(oldAction.providerTurnId as string, 0),
        );
        expect(gen1CommandId).not.toBe(oldPrecommitCommandId);
      }
      if (crashSide === "after") {
        expect((oldRejects[0] as { command_id: string }).command_id).toBe(
          expectedDeliverCommandId(oldAction.providerTurnId as string, 0),
        );
        expect(oldRejects[0]).toMatchObject({
          command_id: oldPrecommitCommandId,
        });
      }
      expect(newActionTurn.messages).toHaveLength(1);
      expect(
        (newActionTurn.messages[0] as { message_id: string }).message_id,
      ).toBe(expectedDeliverMessageId(oldAction.providerTurnId as string));
      expect(newActionTurn.messageEvents).toHaveLength(1);
      expect(newActionTurn.inbox).toHaveLength(1);
      const applied = newActionTurn.actions[0] as {
        execution_id: string;
        provider_turn_id: string;
        logical_action_id: string;
        observation_source_ref: string;
      };
      expect(applied.execution_id).toBe(oldAction.executionId);
      expect(applied.provider_turn_id).toBe(oldAction.providerTurnId);
      expect(applied.logical_action_id).toBe(oldAction.logicalActionId);
      expect(
        newActionTurn.observations.filter(
          (observation) =>
            (observation as { source_ref: string }).source_ref ===
            applied.observation_source_ref,
        ),
      ).toHaveLength(1);
      expect(seed.deliverDecisionCalls).toBe(1);
      expect(newDaemon.daemonErrors).toEqual([]);
    },
    180_000,
  );
  it("converges a committed DeliverMessage after killing the daemon before Action/Observation commit", async () => {
    const marker = `P37-L6-RECEIPT-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker);
    const { fixture, client, producer, seededWork, probes } = seed;
    seed.armDeliver();
    await fixture.crash();
    await fixture.restart({
      entry: p37Child,
      daemonEnvironment: {
        ARBOR_P37_ROLE: "old",
        ARBOR_P37_PAUSE_ROLE: "old",
        ARBOR_P37_PAUSE_BOUNDARY:
          "AH10AfterControlHandlerReturnBeforeObservationCommit",
        ARBOR_P37_GATE_ACTION_KIND: "deliver",
      },
    });
    await client.command(seed.project.projectId, "SteerWork", {
      workId: seededWork.workId,
      workspaceId: producer.workspaceId,
      expectedWorkRevision: seededWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume the measured Deliver action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });

    const beforeObservation = await awaitP37Probe(
      probes,
      (probe) =>
        probe.role === "old" &&
        probe.boundary ===
          "AH10AfterControlHandlerReturnBeforeObservationCommit",
    );
    const executionId = beforeObservation?.executionId;
    expect(executionId).toMatch(/^exe_/u);
    if (executionId === undefined)
      throw new Error("P37 old ExecutionId missing");

    const committedBeforeKill = readP37Snapshot(fixture.databaseFile);
    const receipt = committedBeforeKill.commands.filter(
      (row) =>
        row.command_type === "DeliverMessage" && row.resolution === "Committed",
    );
    expect(receipt).toHaveLength(1);
    expect(committedBeforeKill.messages).toHaveLength(1);
    const originalMessageId = (
      committedBeforeKill.messages[0] as { message_id: string }
    ).message_id;
    expect(
      committedBeforeKill.messageEvents.filter(
        (event) => event.aggregate_ref === originalMessageId,
      ),
    ).toHaveLength(1);
    expect(committedBeforeKill.inbox).toHaveLength(1);
    expect(committedBeforeKill.actions).toHaveLength(1);
    const originalAction = committedBeforeKill.actions[0] as {
      execution_id: string;
      provider_turn_id: string;
      logical_action_id: string;
      call_ref: string;
      state: string;
    };
    expect(originalAction.execution_id).toBe(executionId);
    expect((receipt[0] as { command_id: string }).command_id).toBe(
      expectedDeliverCommandId(originalAction.provider_turn_id, 0),
    );
    expect(originalMessageId).toBe(
      expectedDeliverMessageId(originalAction.provider_turn_id),
    );
    expect(originalAction.state).not.toBe("Applied");
    expect(
      committedBeforeKill.observations.filter((observation) =>
        (observation as { source_ref?: string }).source_ref?.startsWith(
          `observation_${executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(seed.deliverDecisionCalls).toBe(1);

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: p37Child,
      daemonEnvironment: { ARBOR_P37_ROLE: "new" },
      onStdout: (line) => {
        try {
          const probe = JSON.parse(line) as P37Probe;
          if (probe.tag === "P37_DELIVER_PROBE") probes.push(probe);
        } catch {
          // The fixture retains stderr; unrelated stdout is not a P37 signal.
        }
      },
    });
    await fixture.crash();
    const newLease = await awaitP37Probe(
      probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "AH10AfterLeaseAcquired" &&
        probe.executionId === executionId,
    );
    expect(newLease?.fencingGeneration).toBe(1);

    const recovered = await waitForPublic(
      async () => readP37Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            (action as { logical_action_id?: string }).logical_action_id ===
              originalAction.logical_action_id &&
            (action as { state?: string }).state === "Applied",
        ) &&
        snapshot.actions.some((action) => {
          const observationSourceRef = (
            action as { observation_source_ref?: string | null }
          ).observation_source_ref;
          return (
            observationSourceRef !== undefined &&
            observationSourceRef !== null &&
            snapshot.observations.filter(
              (observation) =>
                (observation as { source_ref?: string }).source_ref ===
                observationSourceRef,
            ).length === 1
          );
        }),
      60_000,
    );
    const recoveredReceipt = recovered.commands.filter(
      (row) =>
        row.command_type === "DeliverMessage" && row.resolution === "Committed",
    );
    expect(recoveredReceipt).toHaveLength(1);
    expect((recoveredReceipt[0] as { command_id: string }).command_id).toBe(
      (receipt[0] as { command_id: string }).command_id,
    );
    const receiptResult = JSON.parse(
      (recoveredReceipt[0] as { result_json: string }).result_json,
    ) as { messageId: string };
    expect(receiptResult.messageId).toBe(originalMessageId);
    expect(recovered.messages).toHaveLength(1);
    expect((recovered.messages[0] as { message_id: string }).message_id).toBe(
      originalMessageId,
    );
    expect(
      recovered.messageEvents.filter(
        (event) => event.aggregate_ref === originalMessageId,
      ),
    ).toHaveLength(1);
    expect(recovered.inbox).toHaveLength(1);
    expect(recovered.actions).toHaveLength(1);
    const recoveredAction = recovered.actions[0] as {
      observation_source_ref: string;
      provider_turn_id: string;
      logical_action_id: string;
    };
    expect(
      recovered.observations.filter(
        (observation) =>
          (observation as { source_ref: string }).source_ref ===
          recoveredAction.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(seed.deliverDecisionCalls).toBe(1);
    expect(recoveredAction.provider_turn_id).toBe(
      originalAction.provider_turn_id,
    );
    expect(recoveredAction.logical_action_id).toBe(
      originalAction.logical_action_id,
    );
    expect(newDaemon.daemonErrors).toEqual([]);
    await newDaemon.crash();
  }, 180_000);
  it.each(["before", "after"] as const)(
    "kills %s the P9 DeliverReplay event/fact/outbox commit and retains one public Attention after restart",
    async (crashSide) => {
      const marker = `P37-L6-P9-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const prepared = await prepareContradictoryCommittedReceipt(marker);
      const recovery = await startP37RecoveryDaemon(
        prepared.fixture,
        "new",
        prepared.probes,
        crashSide === "before"
          ? "BeforeDeliverReplayAttentionCommit"
          : "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit",
      );
      const boundary =
        crashSide === "before"
          ? "BeforeDeliverReplayAttentionCommit"
          : "AfterDeliverReplayAttentionCommit";
      const p9Probe = await awaitP37Probe(
        prepared.probes,
        (probe) => probe.role === "new" && probe.boundary === boundary,
      );
      expect(p9Probe?.logicalActionId).toBe(prepared.action.logical_action_id);
      expect(p9Probe?.messageId).toBe(prepared.message.message_id);
      let atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
      if (crashSide === "before") {
        expect(atBoundary.facts).toHaveLength(0);
        expect(atBoundary.replayEvents).toHaveLength(0);
        expect(atBoundary.pendingFacts).toHaveLength(0);
      } else {
        await awaitP37Probe(
          prepared.probes,
          (probe) =>
            probe.role === "new" &&
            probe.boundary ===
              "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
            probe.attentionFactId === p9Probe?.attentionFactId,
        );
        atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
        expect(atBoundary.facts).toHaveLength(1);
        expect(atBoundary.replayEvents).toHaveLength(1);
        expect(atBoundary.pendingFacts).toHaveLength(1);
        expect(atBoundary.markers).toHaveLength(0);
      }
      await recovery.crash();
      if (p9Probe?.executionId !== undefined) {
        await waitForLeaseExpiry(
          prepared.fixture.databaseFile,
          p9Probe.executionId,
        );
      }
      await restartP37Normally(prepared.fixture);
      const attentionRows = await waitForPublic(
        () =>
          publicDeliverReplayRows(prepared.client, prepared.project.projectId),
        (rows) => rows.some((row) => row.dedupKey === p9Probe?.attentionFactId),
        60_000,
      );
      const exactRows = attentionRows.filter(
        (row) => row.dedupKey === p9Probe?.attentionFactId,
      );
      expect(exactRows).toHaveLength(1);
      expect(exactRows[0]).toMatchObject({
        source: "DeliverReplayFailure",
        severity: "ActionRequired",
        targetWorkspaceId: prepared.producer.workspaceId,
        dedupKey: p9Probe?.attentionFactId,
        summaryRef:
          "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
      });
      const final = readP37Snapshot(prepared.fixture.databaseFile);
      expect(final.facts).toHaveLength(1);
      expect(final.replayEvents).toHaveLength(1);
      expect(final.messages).toHaveLength(1);
      expect(final.messageEvents).toHaveLength(1);
      expect(final.inbox).toHaveLength(1);
      expect(final.actions).toHaveLength(1);
      expect((final.actions[0] as { state: string }).state).not.toBe("Applied");
      expect(prepared.deliverDecisionCalls).toBe(1);
    },
    240_000,
  );
  it("does not accept a gen0 direct-write Observation in gen1; an existing fact still blocks after Inbox deletion", async () => {
    const marker = `P37-L6-LEGACY-GEN0-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker);
    seed.armDeliver();
    await seed.fixture.crash();
    await seed.fixture.restart({
      entry: p37Child,
      daemonEnvironment: {
        ARBOR_P37_ROLE: "old",
        ARBOR_P37_PAUSE_ROLE: "old",
        ARBOR_P37_PAUSE_BOUNDARY: "AH7AfterActionIntentCommit",
        ARBOR_P37_GATE_ACTION_KIND: "deliver",
      },
    });
    await seed.client.command(seed.project.projectId, "SteerWork", {
      workId: seed.seededWork.workId,
      workspaceId: seed.producer.workspaceId,
      expectedWorkRevision: seed.seededWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume the measured Deliver action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const oldAction = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "old" &&
        probe.boundary === "AH7AfterActionIntentCommit" &&
        probe.actionKind === "deliver",
    );
    if (
      oldAction?.executionId === undefined ||
      oldAction.providerTurnId === undefined ||
      oldAction.logicalActionId === undefined ||
      oldAction.callRef === undefined
    ) {
      throw new Error("P37 gen0 direct-write action identity is incomplete");
    }
    const executionId = oldAction.executionId;
    const providerTurnId = oldAction.providerTurnId;
    const logicalActionId = oldAction.logicalActionId;
    const callRef = oldAction.callRef;
    const beforeLegacyWrite = readP37Snapshot(seed.fixture.databaseFile);
    const execution = beforeLegacyWrite.executions.find(
      (row) => (row as { execution_id: string }).execution_id === executionId,
    ) as
      | {
          project_id: string;
          workspace_id: string;
          episode_ref: string;
          session_id: string;
        }
      | undefined;
    if (execution === undefined) {
      throw new Error(`P37 live Execution ${executionId} is absent`);
    }
    const workId = seed.seededWork.workId;
    if (workId === undefined) {
      throw new Error(`P37 source Work is absent for ${marker}`);
    }
    const legacyOutcome = await executeLegacyDirectDeliver({
      databaseFile: seed.fixture.databaseFile,
      executionId,
      projectId: String(execution.project_id),
      workspaceId: seed.producer.workspaceId,
      sessionId: String(execution.session_id),
      workId,
      deliverableId: String(seed.deliverable.deliverable_id),
      providerTurnId,
      logicalActionId,
      callRef,
      summary: `Delivered ${marker}`,
    });
    expect(Exit.isSuccess(legacyOutcome)).toBe(true);
    if (Exit.isSuccess(legacyOutcome)) {
      expect(legacyOutcome.value._tag).toBe("Observation");
      if (legacyOutcome.value._tag === "Observation") {
        expect(legacyOutcome.value.observation.text).toContain(
          `DeliverableDelivered(${seed.deliverable.deliverable_id}, `,
        );
      }
    }
    const directWrite = readP37Snapshot(seed.fixture.databaseFile);
    expect(
      directWrite.commands.filter(
        (row) => row.command_type === "DeliverMessage",
      ),
    ).toHaveLength(0);
    expect(directWrite.messages).toHaveLength(1);
    expect(directWrite.messageEvents).toHaveLength(1);
    expect(directWrite.inbox).toHaveLength(1);
    expect(directWrite.actions).toHaveLength(1);
    expect((directWrite.actions[0] as { state: string }).state).not.toBe(
      "Applied",
    );
    await seed.fixture.crash();
    await waitForLeaseExpiry(seed.fixture.databaseFile, executionId);

    const recovery = await startP37RecoveryDaemon(
      seed.fixture,
      "new",
      seed.probes,
      "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit",
    );
    const failure = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "AfterDeliverReplayAttentionCommit" &&
        probe.logicalActionId === logicalActionId,
    );
    expect(failure?.failureCode).toBe("PriorReceiptEffectConflict");
    expect(failure?.messageId).toBe(expectedDeliverMessageId(providerTurnId));
    await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
        probe.attentionFactId === failure?.attentionFactId,
    );
    const failureCommitted = readP37Snapshot(seed.fixture.databaseFile);
    expect(failureCommitted.facts).toHaveLength(1);
    expect(failureCommitted.replayEvents).toHaveLength(1);
    expect(
      failureCommitted.commands.filter(
        (row) => row.command_type === "DeliverMessage",
      ),
    ).toHaveLength(0);
    expect(failureCommitted.messages).toHaveLength(1);
    expect(failureCommitted.messageEvents).toHaveLength(1);
    expect(failureCommitted.pendingFacts).toHaveLength(1);
    expect(failureCommitted.markers).toHaveLength(0);
    await recovery.crash();

    const inboxDb = new DatabaseSync(seed.fixture.databaseFile);
    try {
      const deleted = inboxDb
        .prepare("DELETE FROM inbox_entries WHERE entry_key = ?")
        .run(`msg:${expectedDeliverMessageId(providerTurnId)}`);
      expect(Number(deleted.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    await waitForLeaseExpiry(seed.fixture.databaseFile, executionId);
    await restartP37Normally(seed.fixture);
    const attentionRows = await waitForPublic(
      () => publicDeliverReplayRows(seed.client, seed.project.projectId),
      (rows) =>
        rows.length === 1 && rows[0]?.dedupKey === failure?.attentionFactId,
      60_000,
    );
    expect(attentionRows).toHaveLength(1);
    expect(attentionRows[0]).toMatchObject({
      severity: "ActionRequired",
      dedupKey: failure?.attentionFactId,
    });
    const final = readP37Snapshot(seed.fixture.databaseFile);
    expect(final.facts).toHaveLength(1);
    expect(final.replayEvents).toHaveLength(1);
    expect(final.messages).toHaveLength(1);
    expect(final.messageEvents).toHaveLength(1);
    expect(final.inbox).toHaveLength(0);
    expect(
      final.commands.filter((row) => row.command_type === "DeliverMessage"),
    ).toHaveLength(0);
    expect((final.actions[0] as { state: string }).state).not.toBe("Applied");
    expect(seed.deliverDecisionCalls).toBe(1);
  }, 240_000);
  it.each(["before", "after"] as const)(
    "kills %s the P10 DeliverReplay marker/ACK/offset commit and keeps one public row",
    async (crashSide) => {
      const marker = `P37-L6-P10-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const prepared = await prepareContradictoryCommittedReceipt(marker);
      const before = readP37Snapshot(prepared.fixture.databaseFile);
      const initialOffset = Number(
        (
          before.attentionOffsets.find(
            (row) =>
              (row as { project_id: string }).project_id ===
              prepared.project.projectId,
          ) as { last_sequence?: number } | undefined
        )?.last_sequence ?? 0,
      );
      const boundary =
        crashSide === "before"
          ? "P10AfterAttentionRowWriteBeforeConsumerCommit"
          : "P10AfterDeliverAttentionConsumerCommit";
      const recovery = await startP37RecoveryDaemon(
        prepared.fixture,
        "new",
        prepared.probes,
        boundary,
      );
      const projectionProbe = await awaitP37Probe(
        prepared.probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === boundary &&
          probe.projectId === prepared.project.projectId,
      );
      expect(projectionProbe?.attentionFactId).toBeTruthy();
      const atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
      const projectOffset = atBoundary.attentionOffsets.find(
        (row) =>
          (row as { project_id: string }).project_id ===
          prepared.project.projectId,
      ) as { last_sequence?: number } | undefined;
      if (crashSide === "before") {
        expect(
          atBoundary.markers.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(0);
        expect(
          atBoundary.pendingFacts.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(1);
        expect(Number(projectOffset?.last_sequence ?? 0)).toBe(initialOffset);
      } else {
        expect(
          atBoundary.markers.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(1);
        expect(
          atBoundary.pendingFacts.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(0);
        expect(Number(projectOffset?.last_sequence ?? 0)).toBeGreaterThan(
          initialOffset,
        );
      }
      await recovery.crash();
      if (projectionProbe?.executionId !== undefined) {
        await waitForLeaseExpiry(
          prepared.fixture.databaseFile,
          projectionProbe.executionId,
        );
      }
      await restartP37Normally(prepared.fixture);
      const publicRows = await waitForPublic(
        () =>
          publicDeliverReplayRows(prepared.client, prepared.project.projectId),
        (rows) =>
          rows.some((row) => row.dedupKey === projectionProbe?.attentionFactId),
        60_000,
      );
      expect(
        publicRows.filter(
          (row) => row.dedupKey === projectionProbe?.attentionFactId,
        ),
      ).toHaveLength(1);
      const final = readP37Snapshot(prepared.fixture.databaseFile);
      expect(
        final.markers.filter(
          (row) =>
            (row as { attention_fact_id: string }).attention_fact_id ===
            projectionProbe?.attentionFactId,
        ),
      ).toHaveLength(1);
      expect(prepared.deliverDecisionCalls).toBe(1);
    },
    240_000,
  );
  it("keeps an existing P9 fact ActionRequired after Inbox evidence drifts, without a new Command or Observation", async () => {
    const marker = `P37-L6-CONFLICT-${crypto.randomUUID().slice(0, 8)}`;
    const prepared = await prepareContradictoryCommittedReceipt(marker);
    const recovery = await startP37RecoveryDaemon(
      prepared.fixture,
      "new",
      prepared.probes,
    );
    const initialAttention = await waitForPublic(
      () =>
        publicDeliverReplayRows(
          makePublicClient(recovery.baseUrl),
          prepared.project.projectId,
        ),
      (rows) => rows.length === 1,
      60_000,
    );
    const originalFactId = initialAttention[0]?.dedupKey;
    expect(originalFactId).toBeTruthy();
    const beforeDrift = readP37Snapshot(prepared.fixture.databaseFile);
    expect(beforeDrift.facts).toHaveLength(1);
    const deliverCommandCount = beforeDrift.commands.filter(
      (row) => row.command_type === "DeliverMessage",
    ).length;
    const inboxDb = new DatabaseSync(prepared.fixture.databaseFile);
    try {
      const changed = inboxDb
        .prepare(
          "UPDATE inbox_entries SET summary = 'drifted after fact commit' WHERE entry_key = ?",
        )
        .run(`msg:${prepared.message.message_id}`);
      expect(Number(changed.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    await recovery.crash();
    if (prepared.held.executionId === undefined) {
      throw new Error("P37 contradictory receipt ExecutionId missing");
    }
    await waitForLeaseExpiry(
      prepared.fixture.databaseFile,
      prepared.held.executionId,
    );
    await restartP37Normally(prepared.fixture);
    const attentionRows = await waitForPublic(
      () =>
        publicDeliverReplayRows(prepared.client, prepared.project.projectId),
      (rows) => rows.length === 1 && rows[0]?.dedupKey === originalFactId,
      60_000,
    );
    expect(attentionRows).toHaveLength(1);
    const final = readP37Snapshot(prepared.fixture.databaseFile);
    expect(final.facts).toHaveLength(1);
    expect(final.messages).toHaveLength(1);
    expect(final.messageEvents).toHaveLength(1);
    expect(final.inbox).toHaveLength(1);
    const action = final.actions[0] as {
      state: string;
      observation_source_ref: string | null;
    };
    expect(action.state).not.toBe("Applied");
    expect(action.observation_source_ref).toBeNull();
    expect(
      final.commands.filter((row) => row.command_type === "DeliverMessage"),
    ).toHaveLength(deliverCommandCount);
    expect((final.inbox[0] as { summary: string }).summary).toBe(
      "drifted after fact commit",
    );
    expect(prepared.deliverDecisionCalls).toBe(1);
  }, 180_000);
});
