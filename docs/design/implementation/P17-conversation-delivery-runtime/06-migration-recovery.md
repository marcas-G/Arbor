# P17 — 06 Migration and Recovery

## 1. Startup order

```text
migration 0021
→ legacy backfill/reconciliation
→ Session invocation reconciliation
→ ResponseJob/Attempt recovery sweep
→ breaker recovery
→ eligibility scheduler
→ consumers / Web availability
```

Provider inference is forbidden before the context and Job recovery gates are
ready.

## 2. Backfill

For each legacy HumanMessage:

- Answered with response → Job.Answered, preserve response/execution/reasoning.
- Pending → Job.Queued with nextAttemptNo=legacy attemptNo.
- Claimed + Active Execution → Job.Running and an open Attempt.
- Claimed + Settled Execution → insert/settle Attempt, then run the frozen
  recovery decision.
- Declined/closed-project → Job.Cancelled(ProjectClosed).
- Answered(null) with Interrupted legacy execution → Job.Cancelled(
  ControlledStop), not Answered.

Backfill records migration provenance and never deletes HumanMessage,
Execution, ProviderTurn or Session history.

## 3. Re-entrancy and crash boundaries

Migration and backfill use unique identities and CAS/upsert semantics. Tests
inject crash before/after: Job insert, Attempt insert, Execution lookup,
Attempt settlement, Job transition and event append.

After any restart there is one of:

- no Job yet → deterministic insert;
- Job Running with active Execution → resume same run;
- Job Running with settled Execution → settle Attempt + derive transition;
- settled Attempt with old Job revision → replay same policy decision;
- terminal Job → no-op.

No recovery path invokes Provider before proving that the previous run lacks a
recoverable state/settled turn.

## 4. Rollout compatibility

During migration, reads may fall back to legacy rows only when no Job exists.
After the backfill completion marker commits, all writes and scheduler queries
use Job/Attempt stores. `rollbackForRetry` is then unreachable and removed in
the same phase; a long-lived dual-write mode is forbidden.

## 5. Failure envelope

Migration/backfill invariant conflict produces durable startup Attention and
keeps conversation scheduling disabled. It never repairs contradictory history
by deleting rows or resetting attempts.
