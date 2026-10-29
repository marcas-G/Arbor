# P17 — 05 Commands and Projections

## 1. Resume command

```ts
interface ResumeConversationResponsePayload {
  readonly messageId: MessageId;
  readonly expectedJobRevision: number;
}
```

Authenticated human, exact project/root binding. Valid only from
NeedsAttention. It clears attention/failure scheduling fields and transitions
to Queued with revision+1. It does not alter HumanMessage content or reuse an
old settled Execution. Same commandId is idempotent; stale revision rejects.

## 2. Cancel command

```ts
interface CancelConversationResponsePayload {
  readonly messageId: MessageId;
  readonly expectedJobRevision: number;
}
```

FT-DG-03: the registered strict codecs and typed internal semantic validators
derive their closed fields and ID/revision rules from these exact payloads.
Both commands remain external-origin denied unless the owning P17 contract
explicitly establishes a route; codec registration does not create one (DID
§4.1B).

- Queued/RetryScheduled/NeedsAttention → Cancelled atomically.
- Running → submits the existing StopExecution path and records cancel intent;
  final Job convergence occurs from the authoritative settlement.
- Answered/Cancelled reject terminal mutation.

Neither command is model-facing.

## 3. Status read model

```ts
type ConversationResponseStatus =
  | { state: "Queued" }
  | { state: "Running"; executionId: string; attemptNo: number }
  | { state: "RetryScheduled"; nextEligibleAt: string; safeReason: string }
  | { state: "NeedsAttention"; reason: string; canResume: true }
  | { state: "Answered"; executionId: string }
  | { state: "Cancelled"; reason: string };
```

The projection is keyed by messageId and carries Job revision for commands.
Secrets, raw provider bodies and stack traces are forbidden.

## 4. Transcript behavior

HumanConversationTurn remains projected from immutable HumanMessage. An
AssistantConversationTurn exists only for Job.Answered with its authoritative
executionId/body. NeedsAttention/Cancelled never masquerade as an empty
Assistant answer.

The Web derives no processing state from “missing Assistant turn”; it reads the
status projection. Retry deadline and Attention are visible. Resume/Cancel are
the only new controls.

## 5. Events

Application emits versioned events for JobQueued, AttemptAdmitted,
RetryScheduled, ConversationAttentionRequired, ConversationResponseAnswered
and ConversationResponseCancelled. Job mutation + event append share the
Command transaction. Operational Provider retry events remain observability,
not Domain events.

### AH19 checkpoint-owner interaction (DID v1.51)

The P14 Conversation checkpoint owner uses the immutable HumanMessage only as
message identity, root/project, FIFO ordering, and body source. Its legacy
lifecycle, claim, attempt, settlement and response columns are not scheduler or
answer truth and are not written by P17. The covered prefix may advance only
when the exact ResponseJob is `Answered` and its unique ConversationAttempt and
terminal ConversationResponseEpisode Execution prove the same
`(messageId, attemptNo, executionId)` successful response; the bounded
Assistant response body comes from the Answered Job. A current raw HumanMessage
body is pinned once only for its exact `Running` Job, active Attempt/Execution
and current lease, and is not covered until the Job is Answered. A Running Job
for another episode, `RetryScheduled`, `NeedsAttention`, `Cancelled`, missing
or malformed Job/Attempt is not current input; an earlier non-Answered or
other-episode Running fact blocks later coverage. Compaction preserves the
current ResponseJob and Attempt and does not create a retry or widen P17 retry
policy. P17 retains ownership of Job/Attempt answer and settlement truth; P14
owns the checkpoint frontier.
