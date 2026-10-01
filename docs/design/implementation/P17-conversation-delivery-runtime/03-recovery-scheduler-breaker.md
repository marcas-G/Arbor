# P17 — 03 Recovery Policy, Scheduler and Breaker

## 1. Failure classification

```ts
type ConversationFailureClass =
  | "TransientProviderUnavailable"
  | "AuthenticationFailed"
  | "RequestRejected"
  | "DeterministicModelFailure"
  | "ContextBlocked"
  | "ReconciliationRequired"
  | "ControlledInterruption"
  | "UnknownFailure";
```

Classification uses typed Provider/Agent/Execution evidence. It never parses
human-facing error strings when a typed source exists.

## 2. Three budgets

| Layer | Identity | Budget exhausted result |
|---|---|---|
| Provider transport | ProviderTurn | typed terminal Provider failure |
| Model output repair | AgentLoopStep | Execution Failed(DeterministicModelFailure) |
| Conversation attempt | ResponseJob | NeedsAttention(RetryBudgetExhausted) |

No layer resets or increments another layer's counter. The attempt ledger makes
the total request multiplication mechanically auditable.

## 3. Versioned policy

```ts
interface ConversationRetryPolicy {
  readonly version: "conversation-retry-v1";
  readonly maxExecutionAttempts: 3;
  readonly maxTotalElapsedMs: 900_000;
  readonly identicalFailureLimit: 2;
  readonly baseDelayMs: 2_000;
  readonly maxDelayMs: 60_000;
  readonly jitterRatio: 0.2;
}
```

The v1 values are frozen defaults and may be narrowed by project policy but not
widened above the deployment safety ceiling without later governance.

Backoff is exponential and bounded. Jitter is deterministically derived from
`sha256(messageId, attemptNo, policyVersion)` so replay computes the same
`nextEligibleAt`.

## 4. Pure decision

```ts
decideConversationRecovery(job, attempts, settlement, failure, policy, now)
  -> Answer(response)
   | RetryAt(nextEligibleAt, fingerprint)
   | Attention(reason, fingerprint)
   | Cancel(reason)
```

- Completed(QueryCompleted) with one bounded response → Answer.
- TransientProviderUnavailable within all budgets → RetryAt.
- same fingerprint reaches identicalFailureLimit → Attention.
- AuthenticationFailed/RequestRejected/DeterministicModelFailure/
  ContextBlocked/ReconciliationRequired/UnknownFailure → Attention.
- ControlledInterruption → Cancel(ControlledStop).
- OutcomeUnknown always maps to ReconciliationRequired, never retry.

The Attempt settlement and chosen Job transition are committed in one
Application transaction when both records share the local transaction boundary;
otherwise the deterministic sweep replays the same decision using recorded
policy version and timestamp anchor.

## 5. Eligibility scheduler

The daemon may admit only:

```text
Queued
OR RetryScheduled(nextEligibleAt <= now)
```

plus Project Open, no active root main Execution, ContextGate Ready, breaker
admission and current revision CAS. NeedsAttention/Answered/Cancelled are never
returned by the eligibility query.

Durable wake sources are: HumanMessage submitted, retry deadline, configuration
revision, reconciliation completion and breaker transition. Polling is a
recovery fallback, not the retry clock.

## 6. Deployment circuit breaker

Breaker key is the full ResolvedModelBinding fingerprint.

```text
Closed
  -- threshold/systemic failure --> Open(cooldownUntil)
Open
  -- time/config revision -------> HalfOpen(single probe)
HalfOpen
  -- success --------------------> Closed
  -- failure --------------------> Open
```

Authentication/RequestRejected opens until configuration revision changes or a
human explicitly resumes after correction. Transient failures use cooldown.
Only one half-open execution is admitted. Breaker state/revision is durable.

Breaker denial emits zero Provider bytes and returns a typed scheduler reason;
it does not consume a Conversation execution attempt.
