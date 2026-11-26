// REAL S4 fail-closed conversation recovery snapshot (B5 split): reads the
// complete durable state of a NeedsAttention ConversationResponse job after
// a hard restart, plus its conversation lease binding. Bodies are moved
// verbatim from the former monolithic public-s4-recovery.test.ts.
import { DatabaseSync } from "node:sqlite";

interface FailClosedConversationSnapshot {
  readonly job: {
    readonly messageId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly state: string;
    readonly activeExecutionId: string | null;
    readonly nextAttemptNo: number;
    readonly nextEligibleAt: string | null;
    readonly attentionReason: string | null;
    readonly lastFailureClass: string | null;
    readonly hasResponseBody: boolean;
    readonly revision: number;
  };
  readonly humanMessage: {
    readonly messageId: string;
    readonly state: string;
    readonly claimedByExecutionId: string | null;
    readonly settledAt: string | null;
  };
  readonly execution: {
    readonly executionId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly episodeKind: string;
    readonly episodeRef: string;
    readonly episodeRevision: number;
    readonly sessionId: string;
    readonly settlementKind: string | null;
    readonly settledAt: string | null;
  };
  readonly step: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly providerTurnId: string;
    readonly manifestId: string | null;
    readonly state: string;
    readonly decoderVersion: string | null;
    readonly hasSuccessor: boolean;
  };
  readonly providerTurn: {
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly manifestId: string;
    readonly settledAt: string | null;
    readonly finishReason: string | null;
  };
  readonly manifest: {
    readonly manifestId: string;
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly hasPortableRequest: boolean;
  } | null;
  readonly providerAttempt: {
    readonly attemptNo: number;
    readonly outcome: string;
    readonly providerErrorKind: string | null;
    readonly retrySafety: string | null;
    readonly retryDecision: string | null;
    readonly retryReason: string | null;
    readonly successEvidenceVersion: string | null;
    readonly observation: Readonly<Record<string, unknown>> | null;
  };
  readonly recoveryDecision: {
    readonly causeTag: string;
    readonly retrySafety: string;
    readonly retryDecision: string;
    readonly retryReason: string;
  } | null;
  readonly lease: {
    readonly generation: number;
    readonly workerIncarnationId: string;
  } | null;
  readonly consumerOffsets: ReadonlyArray<{
    readonly consumerId: string;
    readonly lastSequence: number;
  }>;
  readonly maxProjectEventSequence: number | null;
  readonly workspaceSchedulerTimerCount: number;
}

interface ConversationLeaseBinding {
  readonly executionId: string;
  readonly generation: number;
  readonly workerIncarnationId: string;
}

const readConversationLeaseBinding = (input: {
  readonly databaseFile: string;
  readonly messageId: string;
}): ConversationLeaseBinding => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT jobs.active_execution_id AS execution_id,
                leases.generation, leases.worker_incarnation_id
           FROM conversation_response_jobs AS jobs
           JOIN execution_leases AS leases
             ON leases.execution_id = jobs.active_execution_id
          WHERE jobs.message_id = ?`,
      )
      .get(input.messageId) as
      | {
          execution_id: string;
          generation: number;
          worker_incarnation_id: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error(
        "pending ConversationResponse has no active Execution lease",
      );
    }
    return {
      executionId: row.execution_id,
      generation: row.generation,
      workerIncarnationId: row.worker_incarnation_id,
    };
  } finally {
    database.close();
  }
};

const readFailClosedConversationSnapshot = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
}): FailClosedConversationSnapshot => {
  const database = new DatabaseSync(input.databaseFile, { readOnly: true });
  database.exec("BEGIN");
  try {
    const jobRow = database
      .prepare(
        `SELECT message_id, project_id, root_workspace_id, state,
                active_execution_id, next_attempt_no, next_eligible_at,
                attention_reason, last_failure_class,
                response_body IS NOT NULL AS has_response_body, revision
           FROM conversation_response_jobs WHERE message_id = ?`,
      )
      .get(input.messageId) as
      | {
          message_id: string;
          project_id: string;
          root_workspace_id: string;
          state: string;
          active_execution_id: string | null;
          next_attempt_no: number;
          next_eligible_at: string | null;
          attention_reason: string | null;
          last_failure_class: string | null;
          has_response_body: number;
          revision: number;
        }
      | undefined;
    if (jobRow === undefined || jobRow.active_execution_id === null) {
      throw new Error(
        "public NeedsAttention message has no active Execution binding",
      );
    }
    const messageRow = database
      .prepare(
        `SELECT message_id, project_id, root_workspace_id, state,
                claimed_by_execution_id, settled_at
           FROM human_messages WHERE message_id = ?`,
      )
      .get(input.messageId) as
      | {
          message_id: string;
          project_id: string;
          root_workspace_id: string;
          state: string;
          claimed_by_execution_id: string | null;
          settled_at: string | null;
        }
      | undefined;
    const executionRow = database
      .prepare(
        `SELECT execution_id, project_id, workspace_id, episode_kind,
                episode_ref, episode_revision, session_id, settlement_kind,
                settled_at
           FROM executions WHERE execution_id = ?`,
      )
      .get(jobRow.active_execution_id) as
      | {
          execution_id: string;
          project_id: string;
          workspace_id: string;
          episode_kind: string;
          episode_ref: string;
          episode_revision: number;
          session_id: string;
          settlement_kind: string | null;
          settled_at: string | null;
        }
      | undefined;
    if (messageRow === undefined || executionRow === undefined) {
      throw new Error("NeedsAttention message or its Execution disappeared");
    }
    const stepRow = database
      .prepare(
        `SELECT logical_step_no, repair_attempt, provider_turn_id, manifest_id,
                state, decoder_version, successor_json IS NOT NULL AS has_successor
           FROM agent_loop_steps
          WHERE execution_id = ?
          ORDER BY logical_step_no DESC, repair_attempt DESC LIMIT 1`,
      )
      .get(executionRow.execution_id) as
      | {
          logical_step_no: number;
          repair_attempt: number;
          provider_turn_id: string | null;
          manifest_id: string | null;
          state: string;
          decoder_version: string | null;
          has_successor: number;
        }
      | undefined;
    if (
      stepRow?.provider_turn_id === undefined ||
      stepRow.provider_turn_id === null
    ) {
      throw new Error(
        "failed ConversationResponse Execution lacks its ProviderTurn",
      );
    }
    const providerTurnRow = database
      .prepare(
        `SELECT provider_turn_id, execution_id, session_id, manifest_id,
                settled_at, finish_reason
           FROM provider_turns WHERE provider_turn_id = ?`,
      )
      .get(stepRow.provider_turn_id) as
      | {
          provider_turn_id: string;
          execution_id: string;
          session_id: string;
          manifest_id: string;
          settled_at: string | null;
          finish_reason: string | null;
        }
      | undefined;
    if (providerTurnRow === undefined) {
      throw new Error("failed ConversationResponse ProviderTurn disappeared");
    }
    const manifestRow = database
      .prepare(
        `SELECT manifest_id, provider_turn_id, execution_id, session_id,
                portable_request_json IS NOT NULL AS has_portable_request
           FROM model_context_manifests WHERE manifest_id = ?`,
      )
      .get(providerTurnRow.manifest_id) as
      | {
          manifest_id: string;
          provider_turn_id: string;
          execution_id: string;
          session_id: string;
          has_portable_request: number;
        }
      | undefined;
    const attemptRow = database
      .prepare(
        `SELECT attempt_no, outcome, provider_error_kind, retry_safety,
                retry_decision, retry_reason, success_evidence_version,
                observation_json
           FROM provider_attempts WHERE provider_turn_id = ?
           ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(providerTurnRow.provider_turn_id) as
      | {
          attempt_no: number;
          outcome: string;
          provider_error_kind: string | null;
          retry_safety: string | null;
          retry_decision: string | null;
          retry_reason: string | null;
          success_evidence_version: string | null;
          observation_json: string | null;
        }
      | undefined;
    if (attemptRow === undefined) {
      throw new Error(
        "failed ConversationResponse ProviderAttempt disappeared",
      );
    }
    const recoveryRow = database
      .prepare(
        `SELECT cause_tag, retry_safety, retry_decision, retry_reason
           FROM provider_recovery_decisions WHERE provider_turn_id = ?
           ORDER BY sequence_no DESC LIMIT 1`,
      )
      .get(providerTurnRow.provider_turn_id) as
      | {
          cause_tag: string;
          retry_safety: string;
          retry_decision: string;
          retry_reason: string;
        }
      | undefined;
    const leaseRow = database
      .prepare(
        `SELECT generation, worker_incarnation_id FROM execution_leases
          WHERE execution_id = ?`,
      )
      .get(executionRow.execution_id) as
      | { generation: number; worker_incarnation_id: string }
      | undefined;
    const consumerOffsets = database
      .prepare(
        `SELECT consumer_id, last_sequence FROM consumer_offsets
          WHERE project_id = ? ORDER BY consumer_id`,
      )
      .all(input.projectId) as Array<{
      consumer_id: string;
      last_sequence: number;
    }>;
    const maxEventSequence = database
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM domain_events WHERE project_id = ?",
      )
      .get(input.projectId) as { sequence: number | null };
    const timerCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM scheduler_timers WHERE workspace_id = ?",
      )
      .get(input.workspaceId) as { count: number };

    if (
      jobRow.project_id !== input.projectId ||
      jobRow.root_workspace_id !== input.workspaceId ||
      messageRow.project_id !== input.projectId ||
      messageRow.root_workspace_id !== input.workspaceId ||
      executionRow.project_id !== input.projectId ||
      executionRow.workspace_id !== input.workspaceId ||
      executionRow.episode_ref !== input.messageId ||
      executionRow.session_id !== input.sessionId
    ) {
      throw new Error(
        "ConversationResponse recovery binding escaped its public scope",
      );
    }
    return {
      job: {
        messageId: jobRow.message_id,
        projectId: jobRow.project_id,
        workspaceId: jobRow.root_workspace_id,
        state: jobRow.state,
        activeExecutionId: jobRow.active_execution_id,
        nextAttemptNo: jobRow.next_attempt_no,
        nextEligibleAt: jobRow.next_eligible_at,
        attentionReason: jobRow.attention_reason,
        lastFailureClass: jobRow.last_failure_class,
        hasResponseBody: jobRow.has_response_body === 1,
        revision: jobRow.revision,
      },
      humanMessage: {
        messageId: messageRow.message_id,
        state: messageRow.state,
        claimedByExecutionId: messageRow.claimed_by_execution_id,
        settledAt: messageRow.settled_at,
      },
      execution: {
        executionId: executionRow.execution_id,
        projectId: executionRow.project_id,
        workspaceId: executionRow.workspace_id,
        episodeKind: executionRow.episode_kind,
        episodeRef: executionRow.episode_ref,
        episodeRevision: executionRow.episode_revision,
        sessionId: executionRow.session_id,
        settlementKind: executionRow.settlement_kind,
        settledAt: executionRow.settled_at,
      },
      step: {
        logicalStepNo: stepRow.logical_step_no,
        repairAttempt: stepRow.repair_attempt,
        providerTurnId: stepRow.provider_turn_id,
        manifestId: stepRow.manifest_id,
        state: stepRow.state,
        decoderVersion: stepRow.decoder_version,
        hasSuccessor: stepRow.has_successor === 1,
      },
      providerTurn: {
        providerTurnId: providerTurnRow.provider_turn_id,
        executionId: providerTurnRow.execution_id,
        sessionId: providerTurnRow.session_id,
        manifestId: providerTurnRow.manifest_id,
        settledAt: providerTurnRow.settled_at,
        finishReason: providerTurnRow.finish_reason,
      },
      manifest:
        manifestRow === undefined
          ? null
          : {
              manifestId: manifestRow.manifest_id,
              providerTurnId: manifestRow.provider_turn_id,
              executionId: manifestRow.execution_id,
              sessionId: manifestRow.session_id,
              hasPortableRequest: manifestRow.has_portable_request === 1,
            },
      providerAttempt: {
        attemptNo: attemptRow.attempt_no,
        outcome: attemptRow.outcome,
        providerErrorKind: attemptRow.provider_error_kind,
        retrySafety: attemptRow.retry_safety,
        retryDecision: attemptRow.retry_decision,
        retryReason: attemptRow.retry_reason,
        successEvidenceVersion: attemptRow.success_evidence_version,
        observation:
          attemptRow.observation_json === null
            ? null
            : (JSON.parse(attemptRow.observation_json) as Record<
                string,
                unknown
              >),
      },
      recoveryDecision:
        recoveryRow === undefined
          ? null
          : {
              causeTag: recoveryRow.cause_tag,
              retrySafety: recoveryRow.retry_safety,
              retryDecision: recoveryRow.retry_decision,
              retryReason: recoveryRow.retry_reason,
            },
      lease:
        leaseRow === undefined
          ? null
          : {
              generation: leaseRow.generation,
              workerIncarnationId: leaseRow.worker_incarnation_id,
            },
      consumerOffsets: consumerOffsets.map((row) => ({
        consumerId: row.consumer_id,
        lastSequence: row.last_sequence,
      })),
      maxProjectEventSequence: maxEventSequence.sequence,
      workspaceSchedulerTimerCount: timerCount.count,
    };
  } finally {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
};

export type { ConversationLeaseBinding, FailClosedConversationSnapshot };
export { readConversationLeaseBinding, readFailClosedConversationSnapshot };
