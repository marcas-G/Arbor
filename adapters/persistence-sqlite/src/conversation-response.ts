import {
  ConversationAttemptStore,
  type ConversationFailureClass,
  type ConversationResponseJob,
  type ConversationResponseJobState,
  ConversationResponseJobStore,
  ProviderDeploymentBreaker,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { repositoryFailure } from "./repository-error.js";

interface JobRow {
  message_id: string;
  project_id: string;
  root_workspace_id: string;
  state: ConversationResponseJobState["_tag"];
  active_execution_id: string | null;
  next_attempt_no: number;
  next_eligible_at: string | null;
  attention_reason: string | null;
  last_failure_class: string | null;
  last_failure_fingerprint: string | null;
  policy_version: string;
  response_body: string | null;
  response_execution_id: string | null;
  provider_reasoning_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  message_id: string;
  attempt_no: number;
  execution_id: string;
  admitted_at: string;
  settled_at: string | null;
  settlement_kind: string | null;
  failure_class: ConversationFailureClass | null;
  failure_fingerprint: string | null;
  retry_decision_json: string | null;
  policy_version: string;
}

const JOB_COLUMNS = `message_id, project_id, root_workspace_id, state,
  active_execution_id, next_attempt_no, next_eligible_at, attention_reason,
  last_failure_class, last_failure_fingerprint, policy_version, response_body,
  response_execution_id, provider_reasoning_json, revision, created_at,
  updated_at`;

const jobStoreError = repositoryFailure("ConversationJobStore", "job");

const attemptStoreError = repositoryFailure(
  "ConversationAttemptStore",
  "attempt",
);

const parseJson = (value: string | null): unknown => {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const stateOf = (row: JobRow): ConversationResponseJobState => {
  switch (row.state) {
    case "Queued":
      return { _tag: "Queued" };
    case "Running":
      return {
        _tag: "Running",
        attemptNo: Math.max(0, row.next_attempt_no - 1),
        executionId: row.active_execution_id as never,
      };
    case "RetryScheduled":
      return {
        _tag: "RetryScheduled",
        attemptNo: Math.max(0, row.next_attempt_no - 1),
        nextEligibleAt: row.next_eligible_at ?? row.updated_at,
        failureFingerprint:
          row.last_failure_fingerprint ?? "legacy:missing-fingerprint",
      };
    case "NeedsAttention":
      return {
        _tag: "NeedsAttention",
        reason: (row.attention_reason ?? "UnknownFailure") as never,
        failureFingerprint:
          row.last_failure_fingerprint ?? "legacy:missing-fingerprint",
        ...(row.active_execution_id === null
          ? {}
          : { lastExecutionId: row.active_execution_id as never }),
      };
    case "Answered":
      return {
        _tag: "Answered",
        executionId: row.response_execution_id as never,
        responseBody: row.response_body ?? "",
      };
    case "Cancelled":
      return {
        _tag: "Cancelled",
        reason:
          row.attention_reason === "ProjectClosed"
            ? "ProjectClosed"
            : row.attention_reason === "HumanCancelled"
              ? "HumanCancelled"
              : "ControlledStop",
      };
  }
};

const toJob = (row: JobRow): ConversationResponseJob => ({
  messageId: row.message_id as never,
  projectId: row.project_id as never,
  rootWorkspaceId: row.root_workspace_id as never,
  state: stateOf(row),
  nextAttemptNo: row.next_attempt_no,
  policyVersion: row.policy_version,
  providerReasoning: parseJson(row.provider_reasoning_json) as never,
  lastFailureClass: row.last_failure_class as ConversationFailureClass | null,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const encodedState = (state: ConversationResponseJobState) => {
  switch (state._tag) {
    case "Queued":
      return {
        activeExecutionId: null,
        nextEligibleAt: null,
        attentionReason: null,
        failureFingerprint: null,
        responseBody: null,
        responseExecutionId: null,
      };
    case "Running":
      return {
        activeExecutionId: state.executionId,
        nextEligibleAt: null,
        attentionReason: null,
        failureFingerprint: null,
        responseBody: null,
        responseExecutionId: null,
      };
    case "RetryScheduled":
      return {
        activeExecutionId: null,
        nextEligibleAt: state.nextEligibleAt,
        attentionReason: null,
        failureFingerprint: state.failureFingerprint,
        responseBody: null,
        responseExecutionId: null,
      };
    case "NeedsAttention":
      return {
        activeExecutionId: state.lastExecutionId ?? null,
        nextEligibleAt: null,
        attentionReason: state.reason,
        failureFingerprint: state.failureFingerprint,
        responseBody: null,
        responseExecutionId: null,
      };
    case "Answered":
      return {
        activeExecutionId: null,
        nextEligibleAt: null,
        attentionReason: null,
        failureFingerprint: null,
        responseBody: state.responseBody,
        responseExecutionId: state.executionId,
      };
    case "Cancelled":
      return {
        activeExecutionId: null,
        nextEligibleAt: null,
        attentionReason: state.reason,
        failureFingerprint: null,
        responseBody: null,
        responseExecutionId: null,
      };
  }
};

const jobValues = (job: ConversationResponseJob) => {
  const state = encodedState(job.state);
  return [
    job.messageId,
    job.projectId,
    job.rootWorkspaceId,
    job.state._tag,
    state.activeExecutionId,
    job.nextAttemptNo,
    state.nextEligibleAt,
    state.attentionReason,
    job.lastFailureClass,
    state.failureFingerprint,
    job.policyVersion,
    state.responseBody,
    state.responseExecutionId,
    job.providerReasoning === null
      ? null
      : JSON.stringify(job.providerReasoning),
    job.revision,
    job.createdAt,
    job.updatedAt,
  ];
};

export const ConversationResponseJobStoreLive = Layer.effect(
  ConversationResponseJobStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return ConversationResponseJobStore.of({
      insert: (job) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const inserted = yield* sql
            .unsafe<{ message_id: string }>(
              `INSERT INTO conversation_response_jobs (${JOB_COLUMNS})
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(message_id) DO NOTHING RETURNING message_id`,
              jobValues(job),
            )
            .pipe(Effect.mapError(jobStoreError));
          if (inserted.length === 0) {
            return yield* Effect.fail({
              _tag: "ConversationJobConflict" as const,
              messageId: job.messageId,
              reason: "AlreadyExists" as const,
            });
          }
        }),
      find: (messageId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM conversation_response_jobs WHERE message_id = ?`,
              [messageId],
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows[0] === undefined
            ? Option.none<ConversationResponseJob>()
            : Option.some(toJob(rows[0]));
        }),
      findByExecution: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM conversation_response_jobs
               WHERE active_execution_id = ? OR response_execution_id = ?
               LIMIT 1`,
              [executionId, executionId],
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows[0] === undefined
            ? Option.none<ConversationResponseJob>()
            : Option.some(toJob(rows[0]));
        }),
      listEligible: (now) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM conversation_response_jobs
               WHERE state = 'Queued'
                  OR (state = 'RetryScheduled' AND next_eligible_at <= ?)
               ORDER BY created_at, message_id`,
              [now],
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows.map(toJob);
        }),
      listRunning: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM conversation_response_jobs
               WHERE project_id = ? AND state = 'Running'
               ORDER BY created_at, message_id`,
              [projectId],
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows.map(toJob);
        }),
      listForWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<JobRow>(
              `SELECT ${JOB_COLUMNS} FROM conversation_response_jobs
               WHERE root_workspace_id = ? ORDER BY created_at, message_id`,
              [workspaceId],
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows.map(toJob);
        }),
      projectsWithWork: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<{ project_id: string }>(
              `SELECT DISTINCT project_id FROM conversation_response_jobs
               WHERE state IN ('Queued','Running','RetryScheduled')
               ORDER BY project_id`,
            )
            .pipe(Effect.mapError(jobStoreError));
          return rows.map((row) => row.project_id as never);
        }),
      transition: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const next = input.next;
          const state = encodedState(next.state);
          const rows = yield* sql
            .unsafe<JobRow>(
              `UPDATE conversation_response_jobs SET
                 project_id = ?, root_workspace_id = ?, state = ?,
                 active_execution_id = ?, next_attempt_no = ?,
                 next_eligible_at = ?, attention_reason = ?,
                 last_failure_class = ?, last_failure_fingerprint = ?,
                 policy_version = ?, response_body = ?,
                 response_execution_id = ?, provider_reasoning_json = ?,
                 revision = ?, updated_at = ?
               WHERE message_id = ? AND revision = ? AND state = ?
               RETURNING ${JOB_COLUMNS}`,
              [
                next.projectId,
                next.rootWorkspaceId,
                next.state._tag,
                state.activeExecutionId,
                next.nextAttemptNo,
                state.nextEligibleAt,
                state.attentionReason,
                next.lastFailureClass,
                state.failureFingerprint,
                next.policyVersion,
                state.responseBody,
                state.responseExecutionId,
                next.providerReasoning === null
                  ? null
                  : JSON.stringify(next.providerReasoning),
                next.revision,
                next.updatedAt,
                input.messageId,
                input.expectedRevision,
                input.expectedState,
              ],
            )
            .pipe(Effect.mapError(jobStoreError));
          if (rows[0] === undefined) {
            return yield* Effect.fail({
              _tag: "ConversationJobConflict" as const,
              messageId: input.messageId,
              reason: "RevisionOrStateMismatch" as const,
            });
          }
          return toJob(rows[0]);
        }),
    });
  }),
);

export const ConversationAttemptStoreLive = Layer.effect(
  ConversationAttemptStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return ConversationAttemptStore.of({
      insert: (attempt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const inserted = yield* sql
            .unsafe<{ message_id: string }>(
              `INSERT INTO conversation_attempts
               (message_id, attempt_no, execution_id, admitted_at, settled_at,
                settlement_kind, failure_class, failure_fingerprint,
                retry_decision_json, policy_version)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(message_id, attempt_no) DO NOTHING RETURNING message_id`,
              [
                attempt.messageId,
                attempt.attemptNo,
                attempt.executionId,
                attempt.admittedAt,
                attempt.settledAt,
                attempt.settlementKind,
                attempt.failureClass,
                attempt.failureFingerprint,
                attempt.retryDecision === null
                  ? null
                  : JSON.stringify(attempt.retryDecision),
                attempt.policyVersion,
              ],
            )
            .pipe(Effect.mapError(attemptStoreError));
          if (inserted.length === 0) {
            return yield* Effect.fail({
              _tag: "ConversationAttemptConflict" as const,
              messageId: attempt.messageId,
              attemptNo: attempt.attemptNo,
            });
          }
        }),
      settle: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<{ message_id: string }>(
              `UPDATE conversation_attempts SET settled_at = ?,
                 settlement_kind = ?, failure_class = ?,
                 failure_fingerprint = ?, retry_decision_json = ?
               WHERE message_id = ? AND attempt_no = ? AND settled_at IS NULL
               RETURNING message_id`,
              [
                input.settledAt,
                input.settlementKind,
                input.failureClass,
                input.failureFingerprint,
                JSON.stringify(input.retryDecision),
                input.messageId,
                input.attemptNo,
              ],
            )
            .pipe(Effect.mapError(attemptStoreError));
          if (rows.length === 0) {
            return yield* Effect.fail({
              _tag: "ConversationAttemptConflict" as const,
              messageId: input.messageId,
              attemptNo: input.attemptNo,
            });
          }
        }),
      list: (messageId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<AttemptRow>(
              `SELECT message_id, attempt_no, execution_id, admitted_at,
                 settled_at, settlement_kind, failure_class,
                 failure_fingerprint, retry_decision_json, policy_version
               FROM conversation_attempts WHERE message_id = ?
               ORDER BY attempt_no`,
              [messageId],
            )
            .pipe(Effect.mapError(attemptStoreError));
          return rows.map((row) => ({
            messageId: row.message_id as never,
            attemptNo: row.attempt_no,
            executionId: row.execution_id as never,
            admittedAt: row.admitted_at,
            settledAt: row.settled_at,
            settlementKind: row.settlement_kind,
            failureClass: row.failure_class,
            failureFingerprint: row.failure_fingerprint,
            retryDecision: parseJson(row.retry_decision_json) as never,
            policyVersion: row.policy_version,
          }));
        }),
    });
  }),
);

interface BreakerRow {
  binding_fingerprint: string;
  state: "Closed" | "Open" | "HalfOpen";
  consecutive_failures: number;
  cooldown_until: string | null;
  failure_class: ConversationFailureClass | null;
  configuration_revision: string;
  half_open_execution_id: string | null;
  revision: number;
  updated_at: string;
}

const BREAKER_COLUMNS = `binding_fingerprint, state, consecutive_failures,
  cooldown_until, failure_class, configuration_revision,
  half_open_execution_id, revision, updated_at`;

export const ProviderDeploymentBreakerLive = Layer.effect(
  ProviderDeploymentBreaker,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const find = (bindingFingerprint: string) =>
      sql
        .unsafe<BreakerRow>(
          `SELECT ${BREAKER_COLUMNS} FROM provider_deployment_breakers
           WHERE binding_fingerprint = ?`,
          [bindingFingerprint],
        )
        .pipe(Effect.mapError(jobStoreError));
    return ProviderDeploymentBreaker.of({
      admit: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* find(input.bindingFingerprint);
          const row = rows[0];
          if (row === undefined) {
            yield* sql
              .unsafe(
                `INSERT INTO provider_deployment_breakers
                 (${BREAKER_COLUMNS}) VALUES (?,'Closed',0,NULL,NULL,?,NULL,0,?)`,
                [
                  input.bindingFingerprint,
                  input.configurationRevision,
                  input.now,
                ],
              )
              .pipe(Effect.mapError(jobStoreError));
            return { _tag: "Admitted" as const, probe: false };
          }
          if (row.configuration_revision !== input.configurationRevision) {
            yield* sql
              .unsafe(
                `UPDATE provider_deployment_breakers SET state='Closed',
                   consecutive_failures=0, cooldown_until=NULL,
                   failure_class=NULL, configuration_revision=?,
                   half_open_execution_id=NULL, revision=revision+1,
                   updated_at=? WHERE binding_fingerprint=?`,
                [
                  input.configurationRevision,
                  input.now,
                  input.bindingFingerprint,
                ],
              )
              .pipe(Effect.mapError(jobStoreError));
            return { _tag: "Admitted" as const, probe: false };
          }
          if (row.state === "Closed") {
            return { _tag: "Admitted" as const, probe: false };
          }
          if (row.state === "HalfOpen") {
            return row.half_open_execution_id === input.executionId
              ? { _tag: "Admitted" as const, probe: true }
              : {
                  _tag: "Denied" as const,
                  failureClass: row.failure_class ?? "UnknownFailure",
                  ...(row.cooldown_until === null
                    ? {}
                    : { retryAt: row.cooldown_until }),
                };
          }
          if (row.cooldown_until !== null && row.cooldown_until <= input.now) {
            const updated = yield* sql
              .unsafe<{ binding_fingerprint: string }>(
                `UPDATE provider_deployment_breakers SET state='HalfOpen',
                   half_open_execution_id=?, revision=revision+1,
                   updated_at=? WHERE binding_fingerprint=? AND state='Open'
                   RETURNING binding_fingerprint`,
                [input.executionId, input.now, input.bindingFingerprint],
              )
              .pipe(Effect.mapError(jobStoreError));
            if (updated.length > 0) {
              return { _tag: "Admitted" as const, probe: true };
            }
          }
          return {
            _tag: "Denied" as const,
            failureClass: row.failure_class ?? "UnknownFailure",
            ...(row.cooldown_until === null
              ? {}
              : { retryAt: row.cooldown_until }),
          };
        }),
      recordSuccess: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* sql
            .unsafe(
              `INSERT INTO provider_deployment_breakers
               (${BREAKER_COLUMNS}) VALUES (?,'Closed',0,NULL,NULL,?,NULL,0,?)
               ON CONFLICT(binding_fingerprint) DO UPDATE SET
                 state='Closed', consecutive_failures=0, cooldown_until=NULL,
                 failure_class=NULL,
                 configuration_revision=excluded.configuration_revision,
                 half_open_execution_id=NULL,
                 revision=provider_deployment_breakers.revision+1,
                 updated_at=excluded.updated_at`,
              [
                input.bindingFingerprint,
                input.configurationRevision,
                input.now,
              ],
            )
            .pipe(Effect.mapError(jobStoreError));
        }),
      recordFailure: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* find(input.bindingFingerprint);
          const row = rows[0];
          const previousCount =
            row?.configuration_revision === input.configurationRevision
              ? row.consecutive_failures
              : 0;
          const count = previousCount + 1;
          const opensImmediately =
            input.failureClass === "AuthenticationFailed" ||
            input.failureClass === "RequestRejected";
          const open = opensImmediately || count >= 3;
          const cooldownUntil =
            open && !opensImmediately
              ? new Date(Date.parse(input.now) + 60_000).toISOString()
              : null;
          yield* sql
            .unsafe(
              `INSERT INTO provider_deployment_breakers
               (${BREAKER_COLUMNS}) VALUES (?,?,?,?,?,?,NULL,0,?)
               ON CONFLICT(binding_fingerprint) DO UPDATE SET
                 state=excluded.state,
                 consecutive_failures=excluded.consecutive_failures,
                 cooldown_until=excluded.cooldown_until,
                 failure_class=excluded.failure_class,
                 configuration_revision=excluded.configuration_revision,
                 half_open_execution_id=NULL,
                 revision=provider_deployment_breakers.revision+1,
                 updated_at=excluded.updated_at`,
              [
                input.bindingFingerprint,
                open ? "Open" : "Closed",
                count,
                cooldownUntil,
                input.failureClass,
                input.configurationRevision,
                input.now,
              ],
            )
            .pipe(Effect.mapError(jobStoreError));
        }),
    });
  }),
);
