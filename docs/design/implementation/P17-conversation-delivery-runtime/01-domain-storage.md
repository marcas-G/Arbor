# P17 — 01 Domain, Ports and Storage

## 1. HumanMessage boundary

`HumanMessage` is the immutable submitted-user fact. Its existing identity,
principal, body, project/root target, command fingerprint and createdAt remain.
Legacy `state`, `claimedByExecutionId`, `attemptNo`, settlement and response
columns may be read during migration but are not scheduler truth after P17.

Project-close rejection remains an explicit disposition; it is not a retry
state.

## 2. Response Job ADT

```ts
type ConversationResponseJobState =
  | { readonly _tag: "Queued" }
  | {
      readonly _tag: "Running";
      readonly attemptNo: number;
      readonly executionId: ExecutionId;
    }
  | {
      readonly _tag: "RetryScheduled";
      readonly attemptNo: number;
      readonly nextEligibleAt: string;
      readonly failureFingerprint: string;
    }
  | {
      readonly _tag: "NeedsAttention";
      readonly reason: ConversationAttentionReason;
      readonly failureFingerprint: string;
      readonly lastExecutionId?: ExecutionId;
    }
  | {
      readonly _tag: "Answered";
      readonly executionId: ExecutionId;
      readonly responseBody: string;
    }
  | {
      readonly _tag: "Cancelled";
      readonly reason: "HumanCancelled" | "ProjectClosed" | "ControlledStop";
    };

interface ConversationResponseJob {
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly state: ConversationResponseJobState;
  readonly nextAttemptNo: number;
  readonly policyVersion: string;
  readonly providerReasoning: ReasoningAttachment | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

`responseBody` remains bounded by the existing conversation quota. It is
stored on the Job in v1; future blob indirection is additive, not inferred.

## 3. Attempt ledger

```ts
interface ConversationAttempt {
  readonly messageId: MessageId;
  readonly attemptNo: number;
  readonly executionId: ExecutionId;
  readonly admittedAt: string;
  readonly settledAt: string | null;
  readonly settlementKind: ExecutionSettlement["_tag"] | null;
  readonly failureClass: ConversationFailureClass | null;
  readonly failureFingerprint: string | null;
  readonly retryDecision: ConversationRetryDecision | null;
  readonly policyVersion: string;
}
```

Attempts are append-only after settlement. `(messageId, attemptNo)` and
`executionId` are both unique. IDs are deterministically derived from the
pair. A recoverable pause does not create a new Attempt.

## 4. Hard invariants

1. Exactly one Job exists per admitted HumanMessage.
2. One Job has at most one Running attempt.
3. One Job reaches Answered at most once and the response is immutable.
4. Job revision is CAS-checked on every transition.
5. Attempt settlement and the Job's derived transition are recoverable by a
   deterministic sweep; repeated sweep is a no-op.
6. NeedsAttention/Answered/Cancelled are not scheduler-eligible.
7. RetryScheduled is eligible only at `nextEligibleAt <= Clock.now`.
8. A new attempt never resets transport/output-repair budgets recorded inside
   an earlier Execution.

## 5. Ports

```ts
interface ConversationResponseJobStore {
  insert(job: ConversationResponseJob): Effect<void, JobConflict, TransactionScope>;
  find(messageId: MessageId): Effect<Option<Job>, JobStoreError, TransactionScope>;
  listEligible(now: string): Effect<ReadonlyArray<Job>, JobStoreError, TransactionScope>;
  listRunning(projectId: ProjectId): Effect<ReadonlyArray<Job>, JobStoreError, TransactionScope>;
  transition(input: JobTransition): Effect<Job, JobConflict | JobStoreError, TransactionScope>;
}

interface ConversationAttemptStore {
  insert(attempt: ConversationAttempt): Effect<void, AttemptConflict, TransactionScope>;
  settle(input: AttemptSettlement): Effect<void, AttemptConflict, TransactionScope>;
  list(messageId: MessageId): Effect<ReadonlyArray<ConversationAttempt>, AttemptStoreError, TransactionScope>;
}
```

The Application owns transitions. Adapters expose no `rollbackForRetry` helper.

## 6. Migration 0021 DDL

```sql
CREATE TABLE conversation_response_jobs (
  message_id TEXT PRIMARY KEY REFERENCES human_messages(message_id),
  project_id TEXT NOT NULL,
  root_workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('Queued','Running','RetryScheduled','NeedsAttention','Answered','Cancelled')),
  active_execution_id TEXT UNIQUE,
  next_attempt_no INTEGER NOT NULL CHECK (next_attempt_no >= 0),
  next_eligible_at TEXT,
  attention_reason TEXT,
  last_failure_class TEXT,
  last_failure_fingerprint TEXT,
  policy_version TEXT NOT NULL,
  response_body TEXT,
  response_execution_id TEXT,
  provider_reasoning_json TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_conversation_jobs_eligible
  ON conversation_response_jobs(state, next_eligible_at, created_at);

CREATE TABLE conversation_attempts (
  message_id TEXT NOT NULL REFERENCES human_messages(message_id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 0),
  execution_id TEXT NOT NULL UNIQUE,
  admitted_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_kind TEXT,
  failure_class TEXT,
  failure_fingerprint TEXT,
  retry_decision_json TEXT,
  policy_version TEXT NOT NULL,
  PRIMARY KEY (message_id, attempt_no)
);

CREATE TABLE provider_deployment_breakers (
  binding_fingerprint TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('Closed','Open','HalfOpen')),
  consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
  cooldown_until TEXT,
  failure_class TEXT,
  configuration_revision TEXT NOT NULL,
  half_open_execution_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
```

Adapter/domain validation additionally enforces state-specific nullability; a
SQLite CHECK alone is not used as the semantic transition engine.
