# P3 — 08 Durable AgentLoopStep Handoff

**Authority:** DID v1.20 AHT-1…AHT-8；人工治理裁决
`planning/proposals/provider-result-handoff-governance-decision.md`。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。

## 1. Ownership and boundary

`AgentLoopStep` is the durable handoff between a Provider result and the rest of
the Agent loop. Ownership stays split:

```text
Provider Runtime   owns request / retry / canonical Provider result
Agent Runtime      owns decode / Session acceptance / action progression / proposal
Execution Runtime  owns lease / fencing / authoritative Execution settlement
Application        owns canonical Commands and their receipts
```

A lease grants write authority; it does not carry business progress. Losing a
lease stops the current writer. A later owner resumes from `AgentLoopStep`, never
from process-local variables and never by guessing from chat text.

`AgentAction` remains the v1.18 process-local control-routing ADT and is never
persisted. `AgentLoopStepActionRecord` stores only stable identity, route kind,
hashes, disposition and result references. Pending action input is reconstructed
by replaying the pinned Provider result through the pinned decoder, then must
match the stored hashes before execution.

## 2. Identity

```ts
type AgentLoopStepIdentity = {
  readonly executionId: ExecutionId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
};

type AgentLoopStepSuccessorIdentity = AgentLoopStepIdentity & {
  readonly providerTurnId: ProviderTurnId;
};
```

The primary key is `(executionId, logicalStepNo, repairAttempt)`;
`providerTurnId` is globally unique and belongs to exactly one AgentLoopStep.

```text
repair successor: logicalStepNo unchanged, repairAttempt + 1
normal successor: logicalStepNo + 1, repairAttempt = 0
```

Both successor forms persist their complete identity, including
`providerTurnId`, before the predecessor transition commits. `manifestId` is
bound once Provider Runtime creates the Manifest and can never change.

## 3. Durable state

```ts
type AgentLoopStepState =
  | "Prepared"
  | "ProviderResultAvailable"
  | "OutputRejected"
  | "OutputAccepted"
  | "ActionsInProgress"
  | "StepEffectsCommitted"
  | "NextStepReady"
  | "SettlementProposed";

interface AgentLoopStepRecord {
  readonly identity: AgentLoopStepIdentity;
  readonly predecessor?: AgentLoopStepIdentity;
  readonly providerTurnId: ProviderTurnId;
  readonly manifestId?: ManifestId;
  readonly state: AgentLoopStepState;
  readonly decoderVersion?: string;
  readonly providerFailure?: ProviderFailure;
  readonly repairDisposition?:
    | { readonly _tag: "Retry"; readonly successor: AgentLoopStepSuccessorIdentity }
    | { readonly _tag: "Exhausted"; readonly settlement: ExecutionSettlement };
  readonly successor?: AgentLoopStepSuccessorIdentity;
  readonly nextStepReason?: string;
  readonly decodedOutputHash?: string;
  readonly modelOutputSessionSequence?: number;
  readonly nextActionIndex: number;
  readonly settlement?: ExecutionSettlement;
  readonly migrationProvenance?: unknown;
  readonly revision: number;
  readonly updatedAt: string;
}
```

`decoderVersion` is fixed before `ProviderResultAvailable → OutputAccepted`.
If the pinned decoder is unavailable, recovery produces durable Attention; it
must not reinterpret output with a newer decoder.

## 4. State machine

```text
Prepared
  ├─ Provider terminal failure / timeout / safety stop
  │    └─ persist disposition → SettlementProposed
  └─ complete Provider success → ProviderResultAvailable
       ├─ invalid output → OutputRejected
       │    ├─ Retry(successor) → ensure unique successor Prepared
       │    └─ Exhausted(settlement) → SettlementProposed
       └─ valid output + idempotent Session append → OutputAccepted
            └─ action ledger → ActionsInProgress
                 ├─ every action resolved, no unknown side effect
                 │    └─ StepEffectsCommitted
                 ├─ DecisionStale → remaining SkippedStale → NextStepReady
                 └─ action proposes settlement
                      → remaining SkippedEarlySettlement → SettlementProposed

StepEffectsCommitted
  ├─ next model decision → NextStepReady(successor)
  └─ terminal proposal → SettlementProposed
```

No transition may skip a state. Each transition and its durable side effect
share one transaction, or the side effect has a stable idempotency key whose
existing result is read and verified during retry.

Provider failure and repair exhaustion do not require a `ModelOutput`.
`OutputRejected` has exactly one persisted disposition; recovery does not
re-run the repair decision or consume the repair budget again.

## 5. Provider result authority

`ProviderTurnStore` adds:

```ts
findSettledResult(providerTurnId): Effect<
  | { readonly _tag: "SettledSuccess"; readonly turn: ProviderTurn;
      readonly manifest: ModelContextManifest;
      readonly canonicalEvents: ReadonlyArray<CanonicalProviderEvent>;
      readonly finishReason: ProviderFinishReason; readonly usage: unknown;
      readonly evidenceVersion: string }
  | { readonly _tag: "SettledFailure"; readonly turn: ProviderTurn;
      readonly failure: ProviderFailure }
  | { readonly _tag: "Unsettled"; readonly turn: ProviderTurn }
  | { readonly _tag: "NotFound" },
  ProviderTurnStoreError
>;

settleSuccessAtomically(input): Effect<void, ProviderTurnStoreError,
  TransactionScope>;
```

`settleSuccessAtomically` validates the versioned complete-event rule and
commits `ProviderAttempt Success` plus `ProviderTurn settled` in one
transaction. For legacy crash windows, complete success evidence is reconciled
locally before any transport retry:

1. a latest `Success` attempt locally completes Turn settlement;
2. an `InProgress` attempt with a uniquely complete, integrity-checked terminal
   canonical sequence locally settles Attempt and Turn atomically;
3. only absence of complete success evidence enters the existing P9 safe-retry
   decision.

Every success read verifies Execution, Session, ContextEpoch, model, Manifest
and AgentLoopStep identity. A settled success is decoded locally and must never
issue another Provider request.

## 6. Idempotent Session acceptance

P2 owns the repository transaction. Agent Runtime requests:

```ts
appendEntryIdempotent(
  sessionId,
  source: { kind: "ProviderTurn"; ref: ProviderTurnId },
  entry,
  contentHash,
  fence,
): Effect<{ sequence: number; inserted: boolean },
  SessionRepositoryError | LeaseFencingRejected,
  TransactionScope>;
```

The same transaction validates the full lease-holder triple, inserts or reads
the unique `ModelOutput`, verifies `contentHash`, and advances
`ProviderResultAvailable → OutputAccepted` with the Session sequence and
`decodedOutputHash`. Same source + same hash returns the existing sequence;
same source + different hash is an invariant conflict and produces Attention.

## 7. Action ledger and unresolved-side-effect gate

```ts
type AgentLoopStepActionState =
  | "Pending"
  | "Applied"
  | "SkippedStale"
  | "SkippedEarlySettlement"
  | "TerminalRejected"
  | "ReconciliationPending";
```

Each decoded call receives a stable `LogicalActionId` and ordered action index.
The record stores `callRef`, route/action kind, input hash, disposition,
result/settlement/reconciliation refs and Observation source ref; it never
stores the process-local `AgentAction` object.

- `nextActionIndex` advances atomically with the action disposition, or after
  reading a stable existing result.
- Each successful action appends its Observation immediately with stable source
  `(providerTurnId, callRef, resultRef)`; observations do not wait for the whole
  action batch.
- `DecisionStale` marks remaining actions `SkippedStale` and persists one
  `NextStepReady` successor.
- An action settlement marks remaining actions `SkippedEarlySettlement` and
  persists `SettlementProposed`.
- `FencingRejected` applies to one generation-scoped Command; the logical
  action remains Pending for P1 `07` receipt-first takeover. In contrast,
  `ExecutionStopping` admits no new normal action across generations and enters
  quiescence/reconciliation.

`ReconciliationPending` is not a normal terminal action state. Before
`StepEffectsCommitted`, `NextStepReady`, or ordinary
Completed/Interrupted/Failed, every runtime uses the same gate:

```text
ReadOnly / Idempotent  → query or replay only under the existing P4 rule
Reconcilable           → reconcile first, then resolve the action
NonIdempotent unknown  → no replay; Attention/reconciliation or
                         OutcomeUnknown(ReconciliationRequired(refs))
```

Stop cannot bypass this gate. `OutcomeUnknown` may settle while the action
record remains `ReconciliationPending` as evidence; it does not pretend that
`StepEffectsCommitted` occurred.

## 8. Settlement and successor handoff

`SettlementProposed` stores the full `ExecutionSettlement` before the driver
returns. Execution Runtime submits `SettleExecution` only after reading the
proposal and checking the unresolved-side-effect gate. It uses the
generation-scoped identity rules in P1 `07` and the current authoritative
fence. If the Execution is already settled, recovery only converges linked
runtime/conversation state and executes no new action.

`ensureSuccessor(predecessor, successor)` is idempotent:

1. absent → create the exact `Prepared` successor;
2. existing with identical predecessor, identity and established Manifest
   binding → return it;
3. any mismatch → stop with durable Attention;
4. predecessor-committed/successor-absent and successor-created/predecessor-
   convergence windows both call this operation; neither recomputes a decision
   nor creates a second ProviderTurn.

## 9. Ports and package boundary

`ports` owns `AgentLoopStepStore` / `ProviderTurnStore` / idempotent Session
contracts. `agent-runtime` owns orchestration and pure decode. The SQLite
adapter implements the stores; Composition Root wires them. No package or
allowed-dependency edge is added:

```text
agent-runtime → ports
adapters/persistence-sqlite → ports
execution-runtime → ports + agent-runtime
```

## 10. Invariants

1. One successful ProviderTurn belongs to one AgentLoopStep identity.
2. A ProviderTurn with complete success evidence is never requested again.
3. One ProviderTurn produces at most one semantically identical ModelOutput
   Session entry.
4. AgentLoopStep transitions are monotone and fenced.
5. Lease loss never makes a durable Provider result unreachable.
6. A settled Execution has no AgentLoopStep eligible for new actions.
7. LogicalAction success occurs once; CommandId identifies one generation-
   scoped Application request.
8. `ReconciliationPending` blocks normal turn and settlement progression.
9. Each repair/next-turn predecessor identifies exactly one successor.
10. Process-local `AgentAction` is never persisted.

### SCRC v1.22 Compaction identity rule

Compaction does not add a `Compacting` business/AgentLoopStep state. It is a
separate explicit ProviderTurn plus an atomic Session checkpoint/epoch
transition. The pending AgentLoopStep keeps the same
`(executionId, logicalStepNo, repairAttempt)` across successful compaction.

Recovery binds that pending identity to the latest completed epoch/frontier.
Started-but-incomplete compaction leaves the old epoch active. A successful
checkpoint never permits replay of already resolved action-ledger entries. The
related compaction ProviderTurn/Manifest refs provide audit correlation without
creating a second semantic Agent step.

## 11. Must Not Decide

- No Provider transport changes beyond the atomic success/store read contract.
- No new tool side-effect taxonomy; P4 remains authoritative.
- No new Execution settlement variants.
- No implementation or migration authorization.
