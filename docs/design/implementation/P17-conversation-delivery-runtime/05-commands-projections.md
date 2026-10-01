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
