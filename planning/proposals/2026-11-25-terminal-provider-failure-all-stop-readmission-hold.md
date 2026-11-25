# Terminal Provider failure all-Stop readmission hold

**Version:** v1 fixed proposal

**Status:** accepted by the project owner on 2026-11-25 as “方案 A”.

## Decision

Extend the exact Work-revision readmission gate so that every non-cancelled
Provider failure with a complete durable chain ending in:

```text
ExecutionSettlement = Failed(ProviderFailure:<kind>)
ProviderAttempt = TerminalFailure
retry_decision = Stop
```

creates `TerminalProviderFailureSettlement` for the exact
`(projectId, workspaceId, workId, workRevision)`.

The covered failure kinds are:

```text
AuthenticationFailed
AuthorizationFailed
RateLimited
QuotaExceeded
ProviderUnavailable
TransportFailed
StreamInterrupted
RequestRejected
ContextLimitExceeded
ProtocolViolation
UnknownProviderFailure
```

`Cancelled` remains on the existing controlled-interruption path and is not
converted into a terminal Provider failure hold.

## Recovery semantics

- Provider retry policy remains Turn-local. A `Retry` decision still creates
  another Attempt in the same Provider Turn.
- A final `TerminalFailure + Stop` is never allowed to create another
  Producer Execution for the same Open Work revision.
- Work remains `Open`; the hold is not a Work failure, cancellation or
  completion.
- Restart, polling, queue acknowledgement and time passage do not release the
  hold.
- An authorized `SteerWork` that advances the Work revision is the existing
  v1 recovery path.
- The source chain remains immutable audit evidence.
- P10 may present the bounded failure kind, but never becomes admission
  authority.

## Scope

This is an additive readmission-source change. It introduces no table, marker,
timer, synthetic WorkWait, automatic retry command or migration. The existing
exact Step/Turn/Attempt/Manifest proof and transaction-time admission recheck
remain mandatory.

## Required evidence

The implementation must prove:

1. each covered kind can produce one exact source;
2. incomplete or conflicting chains fail closed;
3. repeated historical Executions select one stable earliest source;
4. repeated scheduler ticks and restart produce zero second same-revision
   Execution;
5. revision advance releases only the old revision;
6. `Cancelled` and non-Provider failure paths retain their existing behavior.
