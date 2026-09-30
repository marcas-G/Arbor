# P1 — 07 AgentLoopStep Logical Identity and Command Attempts

**Authority:** DID v1.20 AHT-4；P1 `01`/`03` existing immutable Command rules。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。

## 1. Three identities that must not be conflated

```text
LogicalActionId       one Agent-semantic action across owner generations
CommandId             one immutable Application request under one generation
(CommandId, attemptNo) transient operational retry of that exact request
```

Settlement uses the parallel `LogicalSettlementId`.

Stable derivation (canonical SHA-256/versioned serialization; branded result):

```text
LogicalActionId = H("agent-action-v1", executionId, providerTurnId,
                    callRef, routeKind, actionKind)
LogicalSettlementId = H("agent-settlement-v1", executionId,
                        agentTurnIdentity, settlementHash)

generation-scoped CommandId = deterministicCommandId(
  "agent-command-v1", logicalIdentity, fencingGeneration, attemptOrdinal)
```

`attemptOrdinal` here is the Agent ledger's semantic-command ordinal, not the
P1 `command_attempts.attempt_no`. Operational failures of the same immutable
request reuse the same CommandId and increment only `command_attempts`.

## 2. Eligibility after takeover

Before creating a generation-scoped Command, the current owner reads the
LogicalAction/Settlement ledger and all known receipts:

1. a prior `Committed` receipt converges the ledger; no new Command;
2. a prior `TerminalRejected(FencingRejected)` terminates that CommandId, but a
   current owner may create a new CommandId only when the logical ledger remains
   `Pending`, the current ControlBasis/freshness checks pass, and no external
   effect is unresolved;
3. `TerminalRejected(ExecutionStopping)` is **not** takeover eligibility: stop
   is persistent quiescence state, so no new normal action Command is admitted;
   recovery reconciles side effects and follows the quiescence settlement path;
4. a domain-semantic terminal rejection resolves the logical action according
   to that command's existing error algebra; changing generation does not erase
   it;
5. a retryable operational failure uses the same CommandId and unchanged
   fingerprint;
6. changed semantic payload/precondition after re-evaluation uses a new
   `attemptOrdinal` and CommandId, while retaining the LogicalActionId.

The new Command's payload and semantic fingerprint use the current generation-
appropriate preconditions. Authority remains trusted context and is not added
to the fingerprint. Existing `commands` rows and receipts are never overwritten.

## 3. Settlement

`SettlementProposed` persists one `LogicalSettlementId` and settlement hash.
Each owner generation derives a distinct SettleExecution CommandId and exact-
bound authority. The current Execution settlement is read first:

- already settled with the same semantic result → converge, no command;
- Active → submit the current-generation command;
- settled differently → invariant conflict + durable Attention.

An old generation's FencingRejected receipt cannot be reused as the current
generation's request and cannot permanently block a valid takeover.

## 4. Invariants

1. Every CommandId still denotes one immutable logical Application request.
2. Same CommandId + changed fingerprint remains `IdempotencyConflict`.
3. FencingRejected remains terminal for that CommandId and old worker.
4. ExecutionStopping blocks new normal action Commands across generations.
5. A LogicalAction/Settlement may have multiple generation-scoped CommandIds,
   but at most one committed semantic effect.
6. Receipt lookup precedes every takeover attempt.

## 5. Must Not Decide

- No change to CommandResolution, CommandAttempt or receipt schema.
- No permission to retry unresolved external effects.
- No implementation authorization.
