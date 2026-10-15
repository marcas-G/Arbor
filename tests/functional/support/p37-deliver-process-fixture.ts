import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newUuid7 } from "../../../packages/application/src/index.js";
import {
  expireExecutionLeaseAfterOwnerExitForQualification,
  type LeaseQualificationTuple,
  type QualificationDaemonController,
  type QualificationLeaseOwnerEvidence,
} from "./lease-qualification.js";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "./production-fixture.js";
import type { PublicClient } from "./public-client.js";
import {
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "./public-client.js";

/*
 * P37 L6 is process-crash qualification, not a module/store test. The cases
 * below stay isolated in pending/ until the coordinator schedules the
 * centralized runtime qualification batch. Process-only qualification hooks
 * live in the dedicated test child and are absent from ordinary startup.
 *
 * Required common oracle for every completed case:
 *   - identical LogicalActionId, ProviderTurnId and MessageId before/after;
 *   - CommandId changes with fencing generation when the route is resubmitted;
 *   - one canonical Message, exact MessageSent event, Inbox admission,
 *     Observation and Provider request at most once;
 *   - reads are captured in one SQLite read transaction and public Attention
 *     is checked over the ordinary public view path.
 *
 * The profile-specific P12 capacity cases live in a separate pending file;
 * their gate is profile selection, because accepted P12 forbids invented
 * capacity ceilings.
 */

export const fixtures: ProductionFixture[] = [];
export const p37Child = resolve(
  "tests/functional/support/p37-deliver-process-child.mjs",
);
export const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});
const deliverOccurrence = (providerTurnId: string) => `${providerTurnId}:0`;
export const expectedDeliverCommandId = (
  providerTurnId: string,
  generation: number,
) => {
  const occurrence = deliverOccurrence(providerTurnId);
  const seed =
    generation === 0 ? occurrence : `${occurrence}:generation:${generation}`;
  return `cmd_${newUuid7("deliver-command", seed)}`;
};
export const expectedDeliverMessageId = (providerTurnId: string) =>
  `msg_${newUuid7("deliver-message", deliverOccurrence(providerTurnId))}`;

export interface P37Probe {
  readonly tag: "P37_DELIVER_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly processId?: number;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly executionId?: string;
  readonly providerTurnId?: string;
  readonly d4NoProgressTurns?: number;
  readonly d4Threshold?: number;
  readonly d4StepState?: string;
  readonly d4StepRevision?: number;
  readonly logicalActionId?: string;
  readonly commandId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly legacyObservationText?: string;
  readonly messageId?: string;
  readonly attentionFactId?: string;
  readonly failureCode?: string;
  readonly tickSequence?: number;
  readonly consumerId?: string;
  readonly claimResult?: "NoClaim" | "Claimed";
  readonly observedAt?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly activeExecution?: boolean;
  readonly fencingGeneration?: number;
}

const p37LoggedBoundaries = new Set([
  "AH10AfterLeaseAcquired",
  "AH10BeforeLeaseRenewal",
  "AH10BeforeFencedReceiptCommit",
  "AH10AfterControlHandlerReturnBeforeObservationCommit",
  "P37LegacyDirectObservationReturned",
  "BeforeDeliverReplayAttentionCommit",
  "AfterDeliverReplayAttentionCommit",
  "P10AfterAttentionRowWriteBeforeConsumerCommit",
  "P10AfterDeliverAttentionConsumerCommit",
]);

export const recordP37Probe = (probes: P37Probe[], probe: P37Probe) => {
  probes.push(probe);
  if (
    !p37LoggedBoundaries.has(probe.boundary) &&
    !(
      probe.boundary === "AH7AfterActionIntentCommit" &&
      probe.actionKind === "deliver"
    )
  ) {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ tag: "P37_L6_BOUNDARY", probe })}\n`,
  );
};

const appendSafeDaemonStdout = (lines: string[], line: string) => {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    let safe: Record<string, unknown> | undefined;
    if (
      event.tag === "FUNCTIONAL_DAEMON_STARTED" ||
      event.tag === "FUNCTIONAL_DAEMON_LISTENING"
    ) {
      safe = {
        tag: event.tag,
        nonce: event.nonce,
        pid: event.pid,
        port: event.port,
      };
    } else if (event.tag === "P37_DELIVER_PROBE") {
      const keys = [
        "tag",
        "role",
        "boundary",
        "observedAt",
        "tickSequence",
        "executionId",
        "workspaceId",
        "projectId",
        "logicalActionId",
        "providerTurnId",
        "attentionFactId",
        "failureCode",
        "actionKind",
        "consumerId",
        "claimResult",
        "settlementGateTarget",
      ];
      safe = Object.fromEntries(
        keys
          .filter((key) => event[key] !== undefined)
          .map((key) => [key, event[key]]),
      );
    }
    if (safe !== undefined) {
      lines.push(JSON.stringify(safe));
      if (lines.length > 128) lines.shift();
    }
  } catch {
    // Keep only allowlisted lifecycle/P37 JSON; never retain arbitrary output.
  }
};

const startP37Fixture = (input: {
  readonly reply: (
    call: CapturedProviderCall,
    index: number,
  ) => ScriptedProviderResponse;
  readonly onProbe: (probe: P37Probe) => void;
  readonly stdoutLines?: string[];
  /** These knobs exist only in the P37 child and keep the original Work
   * revision under test; production daemon configuration is untouched. */
  readonly startDeliverImmediately?: boolean;
  readonly maxNoProgressTurns?: number;
}) =>
  startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    firstDaemonEntry: p37Child,
    preserveDirectoryOnStop: true,
    daemonEnvironment: {
      ARBOR_P37_ROLE: "old",
      ...(input.maxNoProgressTurns === undefined
        ? {}
        : {
            ARBOR_P37_MAX_NO_PROGRESS_TURNS: String(input.maxNoProgressTurns),
          }),
      ...(input.startDeliverImmediately === true
        ? {
            ARBOR_P37_PAUSE_ROLE: "old",
            ARBOR_P37_PAUSE_BOUNDARY:
              "AH10AfterControlHandlerReturnBeforeObservationCommit",
            ARBOR_P37_GATE_ACTION_KIND: "deliver",
          }
        : {}),
    },
    reply: input.reply,
    onDaemonStdout: (line) => {
      if (input.stdoutLines !== undefined) {
        appendSafeDaemonStdout(input.stdoutLines, line);
      }
      try {
        const probe = JSON.parse(line) as P37Probe;
        if (probe.tag === "P37_DELIVER_PROBE") input.onProbe(probe);
      } catch {
        // The fixture retains stderr; unrelated stdout is not a P37 signal.
      }
    },
  });

export const releaseP37Gate = (
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

export const awaitP37Probe = (
  probes: ReadonlyArray<P37Probe>,
  predicate: (probe: P37Probe) => boolean,
) =>
  waitForPublic(
    async () => probes.find(predicate),
    (probe) => probe !== undefined,
  );

export const readPublicAttention = (client: PublicClient, projectId: string) =>
  client.view<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>(
    "attention",
    { projectId },
  );

export const readP37Snapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const commands = db
      .prepare(
        "SELECT command_id, project_id, resolution, result_json, terminal_error_json FROM commands ORDER BY created_at, command_id",
      )
      .all();
    const deliverMessageReceipts = db
      .prepare(
        `SELECT command.command_id, command.project_id, command.resolution,
                command.result_json, command.terminal_error_json,
                command.created_at, command.settled_at,
                event.event_id, event.project_id AS event_project_id,
                event.aggregate_ref AS message_id,
                event.caused_by_command_id
           FROM commands AS command
           JOIN domain_events AS event
             ON event.caused_by_command_id = command.command_id
          WHERE event.event_type = 'MessageSent'
            AND event.event_version = 1
            AND json_extract(event.payload_json, '$.kind') = 'Deliver'
          ORDER BY command.created_at, command.command_id`,
      )
      .all();
    const messages = db
      .prepare(
        "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at FROM messages WHERE kind = 'Deliver' ORDER BY sent_at, message_id",
      )
      .all();
    const deliverables = db
      .prepare(
        "SELECT deliverable_id, source_work_id, kind FROM deliverables ORDER BY created_at, deliverable_id",
      )
      .all();
    const works = db
      .prepare(
        "SELECT work_id, project_id, workspace_id, revision, lifecycle, updated_at FROM works ORDER BY updated_at, work_id",
      )
      .all();
    const messageEvents = db
      .prepare(
        "SELECT event_id, project_id, event_type, aggregate_ref, correlation_ref, caused_by_command_id, payload_json FROM domain_events WHERE event_type = 'MessageSent' ORDER BY sequence",
      )
      .all();
    const replayEvents = db
      .prepare(
        "SELECT event_id, project_id, sequence, event_type, aggregate_ref, correlation_ref, caused_by_command_id, payload_json FROM domain_events WHERE event_type = 'DeliverReplayEscalated' ORDER BY sequence",
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
        `SELECT a.execution_id, a.logical_step_no, a.repair_attempt,
                s.provider_turn_id, s.state AS step_state,
                s.settlement_json AS step_settlement_json,
                s.revision AS step_revision, s.updated_at AS step_updated_at,
                a.logical_action_id, a.action_index, a.route_kind,
                a.observation_source_ref, a.call_ref, a.action_kind, a.state,
                a.disposition_json, a.result_ref, a.settlement_ref,
                a.updated_at AS action_updated_at
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
                stop_requested_at, settlement_kind, settlement_json
           FROM executions ORDER BY admitted_at, execution_id`,
      )
      .all();
    const loopSteps = db
      .prepare(
        `SELECT execution_id, logical_step_no, repair_attempt,
                provider_turn_id, state, revision, next_action_index,
                updated_at
           FROM agent_loop_steps ORDER BY updated_at, execution_id`,
      )
      .all();
    const attentionPollDispatch = db
      .prepare(
        `SELECT singleton, next_attempt_sequence, active_project_id,
                lease_owner, lease_generation, claim_started_at,
                lease_expires_at
           FROM p10_attention_dispatch_state WHERE singleton = 1`,
      )
      .all();
    const attentionPollProjects = db
      .prepare(
        `SELECT project_id, last_attempt_sequence,
                consecutive_failed_attempts, next_eligible_at,
                last_failure_code, last_failure_at
           FROM p10_attention_project_poll_state ORDER BY project_id`,
      )
      .all();
    const allConsumerOffsets = db
      .prepare(
        `SELECT consumer_id, project_id, last_sequence
           FROM consumer_offsets ORDER BY project_id, consumer_id LIMIT 64`,
      )
      .all();
    return {
      commands,
      deliverMessageReceipts,
      messages,
      deliverables,
      works,
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
      loopSteps,
      attentionPollDispatch,
      attentionPollProjects,
      allConsumerOffsets,
    };
  } finally {
    db.exec("COMMIT");
    db.close();
  }
};

export const findDeliverReplayFact = (
  snapshot: ReturnType<typeof readP37Snapshot>,
  logicalActionId: string,
  messageId: string,
) =>
  snapshot.facts.find(
    (row) =>
      (row as { logical_action_id: string }).logical_action_id ===
        logicalActionId &&
      (row as { message_id: string }).message_id === messageId,
  ) as
    | {
        attention_fact_id: string;
        event_id: string;
        logical_action_id: string;
        message_id: string;
      }
    | undefined;

export const readRaiBoundaryDiagnostic = async (input: {
  readonly databaseFile: string;
  readonly client: PublicClient;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly executionId: string;
  readonly logicalActionId: string;
  readonly probes: ReadonlyArray<P37Probe>;
  readonly providerRequestCount: number;
  readonly providerRequestBaselineCount: number;
  readonly maxNoProgressTurns: number;
  readonly daemonErrorCount: number;
}) => {
  const snapshot = readP37Snapshot(input.databaseFile);
  const targetExecution = snapshot.executions.find(
    (execution) => execution.execution_id === input.executionId,
  );
  const targetAction = snapshot.actions.find(
    (action) => action.logical_action_id === input.logicalActionId,
  );
  const targetFacts = snapshot.facts
    .filter((fact) => fact.execution_id === input.executionId)
    .slice(-8);
  const targetFactIds = new Set(
    targetFacts.map((fact) => fact.attention_fact_id as string),
  );
  let publicCurrentWork: Record<string, unknown> | null = null;
  try {
    const currentWork = await input.client.view<{
      workId?: string;
      revision?: number;
      status?: string;
      activeExecution?: { executionId?: string };
    } | null>("current-work", { workspaceId: input.workspaceId });
    publicCurrentWork =
      currentWork === null
        ? null
        : {
            workId: currentWork.workId,
            revision: currentWork.revision,
            status: currentWork.status,
            activeExecutionId: currentWork.activeExecution?.executionId,
          };
  } catch {
    publicCurrentWork = null;
  }
  let publicAttention: ReadonlyArray<Record<string, unknown>> | null = null;
  try {
    publicAttention = (
      await readPublicAttention(input.client, input.projectId)
    ).rows
      .slice(-12)
      .map((row) => ({
        source: row.source,
        severity: row.severity,
        targetWorkspaceId: row.targetWorkspaceId,
        dedupKey: row.dedupKey,
        failureCode: row.failureCode,
      }));
  } catch {
    publicAttention = null;
  }
  const relevantBoundaries = new Set([
    "P37D4PolicyResolved",
    "P37D4TurnProbe",
    "P37D4ProgressResetProbe",
    "BeforeDeliverReplayAttentionCommit",
    "AfterDeliverReplayAttentionCommit",
    "P10AfterAttentionRowWriteBeforeConsumerCommit",
    "P10AfterDeliverAttentionConsumerCommit",
    "P37AfterSettlementCommit",
  ]);
  const probeTail = input.probes
    .filter(
      (probe) =>
        probe.role === "new" &&
        relevantBoundaries.has(probe.boundary) &&
        (probe.boundary === "P37D4PolicyResolved" ||
          probe.executionId === input.executionId ||
          probe.logicalActionId === input.logicalActionId),
    )
    .slice(-12)
    .map((probe) => ({
      boundary: probe.boundary,
      executionId: probe.executionId,
      providerTurnId: probe.providerTurnId,
      logicalActionId: probe.logicalActionId,
      d4NoProgressTurns: probe.d4NoProgressTurns,
      d4Threshold: probe.d4Threshold,
      d4StepState: probe.d4StepState,
      d4StepRevision: probe.d4StepRevision,
      attentionFactId: probe.attentionFactId,
      failureCode: probe.failureCode,
    }));
  const activeExecutions = snapshot.executions
    .filter((execution) => execution.settlement_kind === null)
    .slice(-12)
    .map((execution) => ({
      executionId: execution.execution_id,
      projectId: execution.project_id,
      workspaceId: execution.workspace_id,
      episodeKind: execution.episode_kind,
      episodeRef: execution.episode_ref,
      episodeRevision: execution.episode_revision,
      settlementKind: execution.settlement_kind,
    }));
  const activeExecutionIds = new Set([
    input.executionId,
    ...activeExecutions.map((execution) => execution.executionId as string),
  ]);
  const scheduleBoundaries = new Set([
    "SchedulerTickEnter",
    "SchedulerTickExit",
    "PollConsumersEnter",
    "PollConsumersExit",
    "WorkspaceWakeEnter",
    "WorkspaceWakeExit",
    "WorkspaceResumeEnter",
    "WorkspaceResumeExit",
    "ActiveExecutionQueryEnter",
    "ActiveExecutionQueryExit",
    "PreDispatchCheckEnter",
    "PreDispatchCheckExit",
    "RunExecutionEnter",
    "RunExecutionExit",
    "P10TryClaimBegin",
    "P10TryClaimResult",
  ]);
  return {
    target: {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      workId: input.workId,
      workRevision: input.workRevision,
      executionId: input.executionId,
      logicalActionId: input.logicalActionId,
    },
    originalExecution: targetExecution
      ? {
          executionId: targetExecution.execution_id,
          episodeKind: targetExecution.episode_kind,
          episodeRef: targetExecution.episode_ref,
          episodeRevision: targetExecution.episode_revision,
          settlementKind: targetExecution.settlement_kind,
          hasRuntimeSafetyStop: String(
            targetExecution.settlement_json ?? "",
          ).includes("RuntimeSafetyStop"),
        }
      : null,
    originalAction: targetAction
      ? {
          executionId: targetAction.execution_id,
          logicalActionId: targetAction.logical_action_id,
          actionKind: targetAction.action_kind,
          actionState: targetAction.state,
          stepState: targetAction.step_state,
          stepRevision: targetAction.step_revision,
          actionIndex: targetAction.action_index,
        }
      : null,
    probes: probeTail,
    schedulerAndPollTimeline: input.probes
      .filter(
        (probe) =>
          probe.role === "new" && scheduleBoundaries.has(probe.boundary),
      )
      .slice(-128)
      .map((probe) => ({
        boundary: probe.boundary,
        tickSequence: probe.tickSequence,
        observedAt: probe.observedAt,
        consumerId: probe.consumerId,
        claimResult: probe.claimResult,
        projectId: probe.projectId,
        workspaceId: probe.workspaceId,
        executionId: probe.executionId,
        activeExecution: probe.activeExecution,
      })),
    p9Facts: targetFacts.map((fact) => ({
      attentionFactId: fact.attention_fact_id,
      eventId: fact.event_id,
      logicalActionId: fact.logical_action_id,
      messageId: fact.message_id,
      failureCode: fact.failure_code,
    })),
    p9Events: snapshot.replayEvents
      .filter((event) =>
        targetFacts.some((fact) => fact.event_id === event.event_id),
      )
      .slice(-8)
      .map((event) => ({
        eventId: event.event_id,
        projectId: event.project_id,
        sequence: event.sequence,
        aggregateRef: event.aggregate_ref,
        correlationRef: event.correlation_ref,
      })),
    pendingFacts: snapshot.pendingFacts
      .filter((pending) => targetFactIds.has(String(pending.attention_fact_id)))
      .slice(-8),
    p10Markers: snapshot.markers
      .filter((marker) => targetFactIds.has(String(marker.attention_fact_id)))
      .slice(-8),
    attentionOffsets: snapshot.attentionOffsets
      .filter((offset) => offset.project_id === input.projectId)
      .slice(-2),
    targetWork: snapshot.works
      .filter((work) => work.work_id === input.workId)
      .slice(-4)
      .map((work) => ({
        workId: work.work_id,
        projectId: work.project_id,
        workspaceId: work.workspace_id,
        revision: work.revision,
        lifecycle: work.lifecycle,
      })),
    targetLease: snapshot.leases
      .filter((lease) => lease.execution_id === input.executionId)
      .slice(-2)
      .map((lease) => ({
        executionId: lease.execution_id,
        generation: lease.generation,
        expiresAt: lease.expires_at,
      })),
    activeExecutions,
    activeSteps: snapshot.loopSteps
      .filter((step) => activeExecutionIds.has(String(step.execution_id)))
      .slice(-24)
      .map((step) => ({
        executionId: step.execution_id,
        logicalStepNo: step.logical_step_no,
        repairAttempt: step.repair_attempt,
        providerTurnId: step.provider_turn_id,
        state: step.state,
        revision: step.revision,
        nextActionIndex: step.next_action_index,
      })),
    activeLeases: snapshot.leases
      .filter((lease) => activeExecutionIds.has(String(lease.execution_id)))
      .slice(-12)
      .map((lease) => ({
        executionId: lease.execution_id,
        generation: lease.generation,
        expiresAt: lease.expires_at,
      })),
    attentionPollDispatch: snapshot.attentionPollDispatch.slice(0, 1),
    attentionPollProject: snapshot.attentionPollProjects
      .filter((state) => state.project_id === input.projectId)
      .slice(-1),
    consumerOffsets: snapshot.allConsumerOffsets
      .filter((offset) => offset.project_id === input.projectId)
      .slice(-16),
    publicCurrentWork,
    publicAttention,
    providerRequestCount: input.providerRequestCount,
    providerRequestBaselineCount: input.providerRequestBaselineCount,
    providerRequestsSinceBaseline:
      input.providerRequestCount - input.providerRequestBaselineCount,
    maxNoProgressTurns: input.maxNoProgressTurns,
    daemonErrorCount: input.daemonErrorCount,
  };
};

export const persistRaiFailureEvidence = (input: {
  readonly databaseFile: string;
  readonly diagnostic: unknown;
  readonly daemonErrors: ReadonlyArray<string>;
  readonly daemonStdoutLines?: ReadonlyArray<string>;
  readonly daemonProcessSnapshot?: ProductionFixture["daemonProcessSnapshot"] extends () => infer A
    ? A
    : never;
}) => {
  const directory = join(
    tmpdir(),
    "arbor-rai-blackbox-diagnostics",
    `${Date.now()}-${crypto.randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${input.databaseFile}${suffix}`;
    if (existsSync(source))
      copyFileSync(source, join(directory, `db${suffix}`));
  }
  writeFileSync(
    join(directory, "diagnostic.json"),
    JSON.stringify(
      {
        diagnostic: input.diagnostic,
        daemonErrors: input.daemonErrors
          .slice(-32)
          .map((line) => line.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")),
        daemonStdoutLines: input.daemonStdoutLines?.slice(-128) ?? [],
        daemonProcessSnapshot: input.daemonProcessSnapshot ?? null,
      },
      null,
      2,
    ),
    "utf8",
  );
  return directory;
};

export const seedDeliverableWaitingForDelivery = async (
  marker: string,
  options: {
    readonly startDeliverImmediately?: boolean;
    readonly maxNoProgressTurns?: number;
  } = {},
) => {
  const probes: P37Probe[] = [];
  const daemonStdoutLines: string[] = [];
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
      if (context.includes("ProposalRecorded(")) {
        return {
          _tag: "Text",
          text: `Producer proposal recorded for ${marker}.`,
        };
      }
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
      if (!deliverArmed && options.startDeliverImmediately !== true) {
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
    onProbe: (probe) => recordP37Probe(probes, probe),
    stdoutLines: daemonStdoutLines,
    ...(options.startDeliverImmediately === true
      ? { startDeliverImmediately: true }
      : {}),
    ...(options.maxNoProgressTurns === undefined
      ? {}
      : { maxNoProgressTurns: options.maxNoProgressTurns }),
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
      work?.workId === producer.currentWork.workId &&
      work.status === "Open" &&
      (options.startDeliverImmediately === true
        ? probes.some(
            (probe) =>
              probe.boundary ===
                "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
              probe.actionKind === "deliver",
          )
        : seedWaitIssued && work.activeExecution === undefined),
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
    daemonStdoutLines,
    armDeliver: () => {
      deliverArmed = true;
    },
    get deliverDecisionCalls() {
      return deliverDecisionCalls;
    },
  };
};

export const deliverAndHoldCommittedReceipt = async (marker: string) => {
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
  const intent = await awaitP37Probe(
    seed.probes,
    (probe) =>
      probe.role === "old" &&
      probe.boundary === "AH7AfterActionIntentCommit" &&
      probe.actionKind === "deliver" &&
      probe.executionId !== undefined &&
      readP37Snapshot(seed.fixture.databaseFile).executions.some(
        (execution) =>
          execution.execution_id === probe.executionId &&
          execution.workspace_id === seed.producer.workspaceId &&
          execution.episode_kind === "WorkEpisode" &&
          execution.episode_ref === seed.seededWork.workId,
      ),
  );
  if (
    intent?.executionId === undefined ||
    intent.logicalActionId === undefined ||
    intent.providerTurnId === undefined
  ) {
    throw new Error(
      `P37 Deliver intent was not bound to its seeded Work for ${marker}`,
    );
  }
  const held = await awaitP37Probe(
    seed.probes,
    (probe) =>
      probe.role === "old" &&
      probe.boundary ===
        "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
      probe.executionId === intent.executionId &&
      probe.logicalActionId === intent.logicalActionId,
  );
  if (held?.executionId !== intent.executionId) {
    throw new Error(`P37 committed Deliver action did not pause for ${marker}`);
  }
  const snapshot = readP37Snapshot(seed.fixture.databaseFile);
  const expectedCommandId = expectedDeliverCommandId(intent.providerTurnId, 0);
  const expectedMessageId = expectedDeliverMessageId(intent.providerTurnId);
  const matchingReceipts = snapshot.deliverMessageReceipts.filter(
    (row) =>
      row.resolution === "Committed" &&
      row.command_id === expectedCommandId &&
      row.message_id === expectedMessageId,
  );
  const matchingActions = snapshot.actions.filter(
    (row) =>
      (row as { logical_action_id?: string }).logical_action_id ===
        intent.logicalActionId &&
      (row as { execution_id?: string }).execution_id === intent.executionId,
  );
  const matchingMessages = snapshot.messages.filter(
    (row) => (row as { message_id?: string }).message_id === expectedMessageId,
  );
  const matchingEvents = snapshot.messageEvents.filter(
    (row) => row.aggregate_ref === expectedMessageId,
  );
  const matchingInbox = snapshot.inbox.filter(
    (row) =>
      row.entry_key === `msg:${expectedMessageId}` &&
      row.workspace_id === seed.project.rootWorkspaceId,
  );
  if (
    matchingReceipts.length !== 1 ||
    snapshot.deliverMessageReceipts.length !== 1 ||
    matchingActions.length !== 1 ||
    snapshot.actions.length !== 1 ||
    matchingMessages.length !== 1 ||
    snapshot.messages.length !== 1 ||
    matchingEvents.length !== 1 ||
    matchingInbox.length !== 1 ||
    snapshot.inbox.length !== 1 ||
    seed.deliverDecisionCalls !== 1
  ) {
    throw new Error(
      `P37 exact Deliver receipt/effect seed mismatch for ${marker}: ${JSON.stringify(
        {
          executionId: intent.executionId,
          logicalActionId: intent.logicalActionId,
          providerTurnId: intent.providerTurnId,
          commandId: expectedCommandId,
          messageId: expectedMessageId,
          receipts: matchingReceipts.length,
          actions: matchingActions.length,
          messages: matchingMessages.length,
          messageEvents: matchingEvents.length,
          inboxEntries: matchingInbox.length,
          deliverDecisionCalls: seed.deliverDecisionCalls,
          totalDeliverReceipts: snapshot.deliverMessageReceipts.length,
          totalDeliverActions: snapshot.actions.length,
          totalDeliverMessages: snapshot.messages.length,
          totalDeliverInboxEntries: snapshot.inbox.length,
        },
      )}`,
    );
  }
  const receipt = matchingReceipts[0];
  const action = matchingActions[0];
  const message = matchingMessages[0];
  if (receipt === undefined || action === undefined || message === undefined) {
    throw new Error(`P37 exact Deliver seed disappeared for ${marker}`);
  }
  return {
    ...seed,
    held,
    receipt: receipt as { command_id: string; message_id: string },
    action: action as {
      execution_id: string;
      provider_turn_id: string;
      logical_action_id: string;
      state: string;
      observation_source_ref: string | null;
    },
    message: message as { message_id: string },
  };
};

export const corruptDeliverReceiptResult = (
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

export const prepareContradictoryCommittedReceipt = async (marker: string) => {
  const prepared = await deliverAndHoldCommittedReceipt(marker);
  await prepared.fixture.crash();
  corruptDeliverReceiptResult(
    prepared.fixture.databaseFile,
    prepared.receipt.command_id,
  );
  return prepared;
};

const p37LeaseOwnerEvidenceAfterOwnerExit = async (input: {
  readonly databaseFile: string;
  readonly probes: ReadonlyArray<P37Probe>;
  readonly executionId: string;
  readonly daemon: QualificationDaemonController;
  readonly daemonErrors?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}): Promise<QualificationLeaseOwnerEvidence> => {
  const readLease = () => {
    const leaseDb = new DatabaseSync(input.databaseFile, { readOnly: true });
    try {
      return leaseDb
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                  expires_at FROM execution_leases WHERE execution_id = ?`,
        )
        .get(input.executionId) as LeaseQualificationTuple | undefined;
    } finally {
      leaseDb.close();
    }
  };
  const recentProbeGenerations = () =>
    input.probes
      .filter(
        (probe) =>
          probe.executionId === input.executionId &&
          probe.boundary === "AH10AfterLeaseAcquired",
      )
      .slice(-16)
      .map((probe) => ({
        processId: probe.processId,
        generation: probe.fencingGeneration,
        workerId: probe.workerId,
        workerIncarnationId: probe.workerIncarnationId,
      }));
  const ownerProbeCandidates = () =>
    input.probes.filter(
      (probe) =>
        probe.executionId === input.executionId &&
        probe.boundary === "AH10AfterLeaseAcquired",
    );
  const diagnostic = (
    message: string,
    processId: number | undefined,
    lease: LeaseQualificationTuple | undefined,
  ) =>
    new Error(
      `${message}: ${JSON.stringify({
        executionId: input.executionId,
        pid: processId ?? null,
        lease: lease ?? null,
        recentProbeGenerations: recentProbeGenerations(),
        daemonErrors:
          input.daemonErrors?.slice(-8).map((line) => line.slice(-1_000)) ?? [],
        daemon: input.daemon.snapshot(),
      })}`,
    );
  const assertExitedProcess = (expectedPid?: number): number => {
    const snapshot = input.daemon.snapshot();
    if (
      snapshot === null ||
      snapshot.pid === undefined ||
      snapshot.alive ||
      (snapshot.exitCode === null && snapshot.signalCode === null) ||
      (expectedPid !== undefined && snapshot.pid !== expectedPid)
    ) {
      throw diagnostic(
        "P37 owner evidence requires the same confirmed-exited daemon",
        expectedPid ?? snapshot?.pid,
        readLease(),
      );
    }
    return snapshot.pid;
  };
  const sameTuple = (
    actual: LeaseQualificationTuple | undefined,
    expected: LeaseQualificationTuple,
  ) =>
    actual !== undefined &&
    actual.execution_id === expected.execution_id &&
    actual.worker_id === expected.worker_id &&
    actual.worker_incarnation_id === expected.worker_incarnation_id &&
    Number(actual.generation) === Number(expected.generation) &&
    actual.expires_at === expected.expires_at;
  const probeGeneration = (probe: P37Probe) => {
    const generation = probe.fencingGeneration;
    return generation !== undefined &&
      Number.isSafeInteger(generation) &&
      generation >= 0
      ? generation
      : undefined;
  };
  const probeMatchesTuple = (
    probe: P37Probe,
    lease: LeaseQualificationTuple,
    processId: number,
  ) =>
    probe.processId === processId &&
    probe.workerId === lease.worker_id &&
    probe.workerIncarnationId === lease.worker_incarnation_id &&
    probeGeneration(probe) === Number(lease.generation);
  const assertNoProbeConflict = (
    processId: number,
    lease: LeaseQualificationTuple,
  ) => {
    const targetGeneration = Number(lease.generation);
    const candidates = ownerProbeCandidates();
    const conflictingTarget = candidates.find(
      (probe) =>
        probeGeneration(probe) === targetGeneration &&
        !probeMatchesTuple(probe, lease, processId),
    );
    const contradictoryHigher = candidates.find(
      (probe) =>
        probe.workerIncarnationId === lease.worker_incarnation_id &&
        (probeGeneration(probe) ?? -1) > targetGeneration,
    );
    if (conflictingTarget !== undefined || contradictoryHigher !== undefined) {
      throw diagnostic(
        conflictingTarget !== undefined
          ? "P37 conflicting owner probe exists at the durable generation"
          : "P37 same-incarnation probe exceeds the durable lease generation",
        processId,
        lease,
      );
    }
  };
  const latestStablePriorProbe = (
    processId: number,
    lease: LeaseQualificationTuple,
  ) =>
    ownerProbeCandidates()
      .filter((probe) => {
        const generation = probeGeneration(probe);
        return (
          probe.processId === processId &&
          probe.workerId === lease.worker_id &&
          probe.workerIncarnationId === lease.worker_incarnation_id &&
          generation !== undefined &&
          generation < Number(lease.generation)
        );
      })
      .sort(
        (left, right) =>
          (probeGeneration(right) ?? -1) - (probeGeneration(left) ?? -1),
      )[0];

  const processId = assertExitedProcess();
  const initialLease = readLease();
  if (
    initialLease === undefined ||
    initialLease.execution_id !== input.executionId
  ) {
    throw diagnostic(
      "P37 durable lease row is absent",
      processId,
      initialLease,
    );
  }
  const durableGeneration = Number(initialLease.generation);
  if (!Number.isSafeInteger(durableGeneration) || durableGeneration < 0) {
    throw diagnostic(
      "P37 durable lease generation is not a safe nonnegative integer",
      processId,
      initialLease,
    );
  }
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  const pollIntervalMs = input.pollIntervalMs ?? 20;
  for (;;) {
    assertExitedProcess(processId);
    const currentLease = readLease();
    if (!sameTuple(currentLease, initialLease)) {
      throw diagnostic(
        "P37 durable lease tuple changed while awaiting owner stdout",
        processId,
        currentLease,
      );
    }
    assertNoProbeConflict(processId, initialLease);
    const probe = ownerProbeCandidates().find((candidate) =>
      probeMatchesTuple(candidate, initialLease, processId),
    );
    if (probe !== undefined) {
      assertExitedProcess(processId);
      const finalLease = readLease();
      if (!sameTuple(finalLease, initialLease)) {
        throw diagnostic(
          "P37 durable lease tuple changed after exact owner probe arrived",
          processId,
          finalLease,
        );
      }
      return {
        executionId: input.executionId,
        processId,
        workerId: initialLease.worker_id,
        workerIncarnationId: initialLease.worker_incarnation_id,
        generation: durableGeneration,
        provenance: "ExactLeaseAcquireProbe",
      };
    }
    if (Date.now() >= deadline) {
      const priorProbe = latestStablePriorProbe(processId, initialLease);
      if (priorProbe !== undefined) {
        assertExitedProcess(processId);
        const finalLease = readLease();
        if (!sameTuple(finalLease, initialLease)) {
          throw diagnostic(
            "P37 durable lease tuple changed after stable-incarnation evidence",
            processId,
            finalLease,
          );
        }
        return {
          executionId: input.executionId,
          processId,
          workerId: initialLease.worker_id,
          workerIncarnationId: initialLease.worker_incarnation_id,
          generation: durableGeneration,
          provenance: "DurableGenerationWithStableIncarnation",
        };
      }
      throw diagnostic(
        `P37 exact owner probe did not arrive within ${input.timeoutMs ?? 5_000}ms and no stable-incarnation prior probe exists`,
        processId,
        currentLease,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
};

export const expireP37LeaseForQualification = async (input: {
  readonly databaseFile: string;
  readonly executionId: string;
  readonly daemon: QualificationDaemonController;
  readonly probes: ReadonlyArray<P37Probe>;
  readonly daemonErrors?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}) => {
  const ownerEvidence = await p37LeaseOwnerEvidenceAfterOwnerExit(input);
  const leaseDb = new DatabaseSync(input.databaseFile, { readOnly: true });
  let lease:
    | {
        readonly execution_id: string;
        readonly worker_id: string;
        readonly worker_incarnation_id: string;
        readonly generation: number;
        readonly expires_at: string;
      }
    | undefined;
  try {
    lease = leaseDb
      .prepare(
        `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                expires_at FROM execution_leases WHERE execution_id = ?`,
      )
      .get(input.executionId) as typeof lease;
  } finally {
    leaseDb.close();
  }
  if (lease === undefined)
    throw new Error(`P37 lease ${input.executionId} is absent before takeover`);
  if (
    !Number.isSafeInteger(Number(lease.generation)) ||
    Number(lease.generation) < 0 ||
    ownerEvidence.executionId !== input.executionId ||
    ownerEvidence.workerId !== lease.worker_id ||
    ownerEvidence.workerIncarnationId !== lease.worker_incarnation_id ||
    ownerEvidence.generation !== Number(lease.generation)
  ) {
    throw new Error(
      `P37 lease owner evidence does not match durable tuple: ${JSON.stringify({
        executionId: input.executionId,
        lease,
        ownerEvidence,
      })}`,
    );
  }
  const expired = await expireExecutionLeaseAfterOwnerExitForQualification({
    databaseFile: input.databaseFile,
    executionId: input.executionId,
    expected: {
      generation: Number(lease.generation),
      expiresAt: lease.expires_at,
      workerId: lease.worker_id,
      workerIncarnationId: lease.worker_incarnation_id,
    },
    daemon: input.daemon,
    ownerEvidence,
  });
  return {
    ...expired,
    ownerEvidenceProvenance: ownerEvidence.provenance,
  };
};

export const startP37RecoveryDaemon = (
  fixture: ProductionFixture,
  role: "new",
  probes: P37Probe[],
  boundaries?: string,
  maxNoProgressTurns?: number,
  diagnostics = false,
  settlementExecutionId?: string,
  daemonStdoutLines?: string[],
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
      ...(maxNoProgressTurns === undefined
        ? {}
        : {
            ARBOR_P37_MAX_NO_PROGRESS_TURNS: String(maxNoProgressTurns),
          }),
      ...(diagnostics ? { ARBOR_P37_DIAGNOSTICS: "1" } : {}),
      ...(settlementExecutionId === undefined
        ? {}
        : { ARBOR_P37_SETTLEMENT_EXECUTION_ID: settlementExecutionId }),
    },
    onStdout: (line) => {
      if (daemonStdoutLines !== undefined) {
        appendSafeDaemonStdout(daemonStdoutLines, line);
      }
      try {
        const probe = JSON.parse(line) as P37Probe;
        if (probe.tag === "P37_DELIVER_PROBE") {
          const diagnosticBoundary =
            probe.boundary === "SchedulerTickEnter" ||
            probe.boundary === "SchedulerTickExit" ||
            probe.boundary === "PollConsumersEnter" ||
            probe.boundary === "PollConsumersExit" ||
            probe.boundary === "WorkspaceWakeEnter" ||
            probe.boundary === "WorkspaceWakeExit" ||
            probe.boundary === "WorkspaceResumeEnter" ||
            probe.boundary === "WorkspaceResumeExit" ||
            probe.boundary === "ActiveExecutionQueryEnter" ||
            probe.boundary === "ActiveExecutionQueryExit" ||
            probe.boundary === "PreDispatchCheckEnter" ||
            probe.boundary === "PreDispatchCheckExit" ||
            probe.boundary === "RunExecutionEnter" ||
            probe.boundary === "RunExecutionExit" ||
            probe.boundary === "P10TryClaimBegin" ||
            probe.boundary === "P10TryClaimResult";
          if (diagnosticBoundary) {
            const oldest = probes.findIndex(
              (item) =>
                item.boundary === "SchedulerTickEnter" ||
                item.boundary === "SchedulerTickExit" ||
                item.boundary === "PollConsumersEnter" ||
                item.boundary === "PollConsumersExit" ||
                item.boundary === "WorkspaceWakeEnter" ||
                item.boundary === "WorkspaceWakeExit" ||
                item.boundary === "WorkspaceResumeEnter" ||
                item.boundary === "WorkspaceResumeExit" ||
                item.boundary === "ActiveExecutionQueryEnter" ||
                item.boundary === "ActiveExecutionQueryExit" ||
                item.boundary === "PreDispatchCheckEnter" ||
                item.boundary === "PreDispatchCheckExit" ||
                item.boundary === "RunExecutionEnter" ||
                item.boundary === "RunExecutionExit" ||
                item.boundary === "P10TryClaimBegin" ||
                item.boundary === "P10TryClaimResult",
            );
            const count = probes.filter(
              (item) =>
                item.boundary === "SchedulerTickEnter" ||
                item.boundary === "SchedulerTickExit" ||
                item.boundary === "PollConsumersEnter" ||
                item.boundary === "PollConsumersExit" ||
                item.boundary === "WorkspaceWakeEnter" ||
                item.boundary === "WorkspaceWakeExit" ||
                item.boundary === "WorkspaceResumeEnter" ||
                item.boundary === "WorkspaceResumeExit" ||
                item.boundary === "ActiveExecutionQueryEnter" ||
                item.boundary === "ActiveExecutionQueryExit" ||
                item.boundary === "PreDispatchCheckEnter" ||
                item.boundary === "PreDispatchCheckExit" ||
                item.boundary === "RunExecutionEnter" ||
                item.boundary === "RunExecutionExit" ||
                item.boundary === "P10TryClaimBegin" ||
                item.boundary === "P10TryClaimResult",
            ).length;
            if (count >= 256 && oldest >= 0) probes.splice(oldest, 1);
          }
          recordP37Probe(probes, probe);
        }
      } catch {
        // The fixture retains stderr; unrelated stdout is not a P37 signal.
      }
    },
  });

export const restartP37Normally = async (fixture: ProductionFixture) =>
  fixture.restart({
    entry: p37Child,
    daemonEnvironment: { ARBOR_P37_ROLE: "new" },
  });

export const publicDeliverReplayRows = async (
  client: PublicClient,
  projectId: string,
) => {
  const attention = await readPublicAttention(client, projectId);
  return attention.rows.filter((row) => row.source === "DeliverReplayFailure");
};
