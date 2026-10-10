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

**Direct-child AssignWork exception (AH10 binding contract).** The prior
`Committed` lookup remains first. For a direct-child AssignWork only, recovery
may converge the same logical action only when the exact CommandId has one
proof-complete `AssignWorkTargetBinding` and matching receipt, Work/provenance,
`WorkAssigned` event, Parent edge, source action, and authority evidence as
defined by System Design §4.11 and DID §6A.16. Recovery does not resolve the
stale opaque selector again. Missing, malformed, duplicate, or mismatched
evidence records the P9 `AssignWorkBindingAttentionFact`, leaves the Action
Pending, emits no Observation, and cannot fall through to a new-generation
Command. This is the sole exception to item 1; it does not change Command
resolution or reinterpret a receipt as FencingRejected. Existing
`FencingRejected` takeover eligibility is unchanged. Historical Committed
receipts have no fabricated binding and are handled by the same fail-closed
exception. See P9 `07` for durable fact/recovery order and P10 `02`/`07` for
projection/qualification.

### Prior-generation receipt decoding

The Application receipt-first consumers used by generation takeover (for
example AssignWork, AcceptResult, SendMessage, SelectCurrentWork,
DeclareDependency, and ProduceDeliverable) read the prior immutable CommandId
directly; they are not Gateway submissions and do not compare a candidate
fingerprint/schema/algorithm tuple. Before decoding raw receipt JSON, the
consumer validates the prior row's exact CommandId and expected ProjectId.
It then selects the strict Committed result or TerminalRejected decoder using
the trusted command type of that runtime action route and the corresponding
Handler schema version from the Composition-owned handler/decoder registry.
Stored `schemaVersion` is checked against that trusted descriptor and cannot
choose an arbitrary decoder. An unsupported historical schema fails closed;
there is no fallback to another command's schema or an inferred legacy shape.

Current action-route binding (schema versions are read from the registered
Handler, currently `"1"` for each row):

| AgentAction route | Registered CommandType |
|---|---|
| AssignWork | `AssignWork` |
| AcceptResult | `AcceptWorkOutcome` |
| SendMessage | `SendMessage` |
| SelectCurrentWork | `SelectCurrentWork` |
| DeclareDependency | `DeclareDependency` |
| ProduceDeliverable | `ProduceDeliverable` |

For a non-direct-child prior receipt, invalid JSON/shape is a
`PersistenceCorruption<"CommandStore">` operational failure, not
`AgentActionRejected`; it produces no successful Observation, no replayed
handler/Gateway Command, and no row repair. It does not create the special P9
AssignWork binding fact.

For the direct-child AssignWork exception, a Committed receipt is a component
of the proof-complete effect binding, not sufficient evidence by itself.
Identity is checked before decode; every proof component must be verified
before Applied/Observation. A raw JSON syntax failure retains an internal
`PersistenceCorruption<"CommandStore">` classification but is routed through
the existing P9 `ReceiptMismatch` fact/event transaction and finishes as
`AgentActionRecoveryBlocked`, not `AgentActionOperationalFailure` or
`ControlActionHandlerRejected`. A JSON-parseable wrong result shape (A2) and
structurally valid receipt/binding/effect mismatch (B) remain the existing
P9 `ReceiptMismatch` or other exact failure-code path. None may replay the
handler, create a new Command, repair the old row, append an Observation, or
mark the Action Applied. P9's fact/event transaction, dedup identity and
before/after-commit crash convergence remain unchanged.

`AgentActionRecoveryBlocked` carries only `executionId` and `logicalActionId`;
it does not carry the decoder cause. The P9 fact stores only its fixed
`failureCode` and identity, never raw receipt JSON or parser text. No existing
observable logging/diagnostic sink is implied by this contract. A separately
operator-visible diagnostic requires an independently governed port and is
not part of P1 `07`.

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
