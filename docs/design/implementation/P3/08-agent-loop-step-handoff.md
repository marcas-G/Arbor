# P3 — 08 Durable AgentLoopStep Handoff

> **DID v1.30 CAPA successor:** `ApprovalRequired` is a durable pause at
> `ActionsInProgress` with the action ledger still Pending. The Execution stays
> Active, its lease is released, and no settlement is written. Human resolution
> wakes the same Execution; the existing settled ProviderTurn/action identity
> is replayed and the approved exact action is single-consumed after its
> idempotent handler attempt.

**Authority:** DID v1.20 AHT-1…AHT-8；人工治理裁决
`planning/proposals/provider-result-handoff-governance-decision.md`。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。
Accepted AH7-DG-03 amendment (2026-10-10); post-landing consistency review
pending. Source proposal SHA-256:
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

Accepted EA-DG-01 amendment (2026-10-11), fixed proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
decision `planning/results/EA-DG-01-governance-acceptance.md`.

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

For an accepted Blocked WorkEpisode, P3/P9 action evidence additionally
preserves a closed `TerminalActionDenial` with the exact denied action refs:
P4-created invocations carry the matching durable `NoEffectDenialCode`, while
a pre-P4 executable handler rejection carries only
`{ _tag: "HandlerRejected", routeKind: "Executable" }`. Native causes,
implementation error strings and free-form interruption reasons are not
accepted evidence. This type is stored with the existing exact
`AgentLoopStepActionRecord` identity and is replay-validated before a Blocked
settlement.

```ts
type TerminalActionDenial =
  | { readonly _tag: "P4NoEffectDenied";
      readonly reasonCode: Exclude<NoEffectDenialCode, "ApprovalRequired"> }
  | { readonly _tag: "HandlerRejected";
      readonly routeKind: "Executable" };
```

`P4NoEffectDenied` requires the exact paired canonical ToolInvocation row and
matching closed P4 reason. `HandlerRejected` is valid only before P4 intent or
effect admission. `ApprovalRequired` is nonterminal and cannot support a
Blocked result; MayHaveStarted remains on the existing reconciliation path.

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
- **Serial action dispatch.** For one `AgentLoopStep`, the production AgentLoop
  invokes only the action at `nextActionIndex`. It waits for that P4 invocation
  to return, then commits the action disposition, sourced Observation and cursor
  advance before it invokes the next action. It does not issue overlapping P4
  invocations for one pinned action. Recovery resumes the same pinned action
  sequentially under the currently acquired `ExecutionOrigin`.
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
- **EA-DG-01 Executable approval pause.** P4's nonterminal `ApprovalRequired`
  outcome does not append a ToolResult, change the action disposition, or
  advance `nextActionIndex`. The same Execution remains Active, the
  AgentLoopStep remains `ActionsInProgress`, the same LogicalActionId/callRef
  remains Pending, and the lease is released. The durable Executable approval
  row and Inbox entry are the pause truth; recovery does not issue a Provider
  request or reconstruct identity from Session text.
- The owning Application combines P4's resolved-intent handoff with the pinned
  Step/LogicalAction identity, performs the idempotent Pending+Inbox admission,
  and returns the existing `ExecutionDriveOutcome.ApprovalRequired` with the
  stored ApprovalId/revision. A pre-existing Pending row returns the same
  outcome; a pre-existing Approved row is injected into P4 for that exact
  action instead of pausing or creating a new request.
- After Approve, local replay of the same settled Provider result recovers the
  same LogicalActionId/ToolInvocationId and supplies the Runtime-sourced
  ApprovalId plus exact Approved revision to P4. P4 claim/consume is the
  accepted AH7 transaction; only then can the action effect run. When current
  authority passes, Rejected produces P4 no-effect `Denied(ApprovalRejected)`
  and Expired produces `Denied(ApprovalExpired)` for that same
  ToolInvocationId; an earlier P4 current-authority denial takes precedence
  and leaves the approval unconsumed. The sourced ToolResult,
  `TerminalRejected` disposition and one cursor advance commit atomically.
  Stop-cancelled approval produces the existing Interrupted/quiescence result,
  closes the current action once and applies the existing early-settlement
  rule to remaining actions.
- Historical terminal `Denied(ApprovalRequired)` rows remain terminal on
  replay. Recovery never promotes them to a Pending request. A new
  approval-required call uses the nonterminal pause above.
- A P4 no-effect `Denied` ToolResult is terminal for that `LogicalActionId`:
  persist ToolResult status `Denied`, disposition `AuthorizationDenied`,
  action state `TerminalRejected`, Observation source and cursor advance
  atomically. It does not settle/fail the whole Execution. Re-entry reads the
  P4 terminal denial for the same ToolInvocation; a new attempt requires a new
  action/invocation identity.
- `ExecutionStopping` before P4 claim creates no ToolInvocation intent. Record
  ToolResult status `Interrupted` / disposition `ExecutionStopping`, mark the
  current action `TerminalRejected` and the remaining actions
  `SkippedEarlySettlement`, advance the cursor once and persist
  `SettlementProposed(Interrupted(StopRequested))` under the current
  AgentLoopStep fence. If P4 already claimed the exact invocation but it is
  still `NotAdmitted`, its P4 `Interrupted` result converges through the same
  action/cursor transition; any approval already consumed remains bound.
- After P4 `effect_admission_state = MayHaveStarted`, StopExecution uses the
  existing unresolved-side-effect gate. Do not begin a new Executor call or
  replay; cancel, confirm or reconcile. A known outcome is recorded once;
  unresolved work remains `ReconciliationPending` or proposes
  `OutcomeUnknown(ReconciliationRequired)`.

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

### Accepted AH7-DG-02 executable recovery handoff (DID v1.40)

P3 is the sole producer of the invocation source binding from the current
pinned `PreparedModelTurn.manifest.providerTurnId`, durable
`AgentLoopStepRecord.identity` (`executionId`, `logicalStepNo`, `repairAttempt`),
exact `AgentLoopStepActionRecord.logicalActionId/actionIndex`, and pinned
decoded `ToolInvocation.callRef`. It passes the same binding through
`ExecutableInvocationInput` and Application's `ExecutableToolHandler` to both
P4 `ToolIntent` and `ToolExecutionContext`. P4 verifies equality and persists
the immutable digest; P3 never reconstructs it from arguments, Session text or
tool output. P4/P38 alone supply trusted approval subject/revision/consumer
facts.

For P4 reconciliation, `Occurred` with a reconstructable canonical result
converges one P3 ToolResult and Observation/Action/cursor from that result.
`StillUnknown` leaves the action `ReconciliationPending`, prevents normal
progression and projects only the typed unresolved outcome; it does not mean
reconciliation succeeded. `ReconciledNoEffect` carries the P4 fact ref and
maps exactly as follows:

| P4 reason | P3 ToolResult | Action/cursor | Execution |
|---|---|---|---|
| `AuthoritySnapshotChanged`, `ResourceSnapshotChanged`, `ApprovalNoLongerAuthorized` | `Denied`, disposition `ReconciledNoEffect:<reason>` | `TerminalRejected`; advance once | Continue |
| `StopRequested` | `Interrupted`, disposition `ExecutionStopping` | current `TerminalRejected`, remaining calls `SkippedEarlySettlement`; advance once | `SettlementProposed(Interrupted(StopRequested))` |
| `ReplayLimitReached` | `Failed`, disposition `ReconciledNoEffect:ReplayLimitReached`; truthful no-effect text | `Applied`; advance once | No global Failed settlement |

Each case persists the exact P4 `reconciliationFactRef` with its ToolResult.
The ToolResult `observationRef`, AgentLoopStepAction
`observation_source_ref`, and Session `source_ref` are the same unique
`observation_${executionId}_${sha256Hex(JSON.stringify({providerTurnId,callRef,resultRef}))}`
identity. Replaying the same terminal P4 invocation/fact is receipt-first and
cannot append a second ToolResult/Observation, choose another fact, or advance
Action/cursor again. Late post-terminal evidence does not roll back terminal
P4/P3 state.

### Accepted AH7-DG-01 / P39-P40 ReconciledNoEffect Observation replay (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

For the same pinned `(executionId, providerTurnId, actionIndex, callRef,
toolName, inputHash)`, P3 invokes the same P4 ToolInvocationId and accepts only
P4's fenced canonical winner Observation. P39 RNO continues to use its exact
P39 `selected_fact_id`/attempt and reason mapping. P3's existing
`ToolResult.resultRef` bounded-payload hash, `observationRef` formula, and
Session `source_ref` = ToolResult `observationRef` = AgentLoopStepAction
`observation_source_ref` remain unchanged; none is the P39 fact ID or P4
Artifact ID.

P3 commits Session ToolResult, source Observation, Action disposition and
cursor in its existing atomic handoff transaction. A kill before COMMIT leaves
all P3 writes absent while the P4/P39 terminal winner remains; restart replays
the original text/truncated once without reconciling/executing again. A kill
after COMMIT leaves all P3 facts present; restart reads the exact existing
source winner and does not append or advance again. A P3 projection loser
under a valid fence adopts the committed winner, never its local candidate.

For a pre-P40 RNO terminal row with missing P40 evidence, a still-Pending P3
action under a valid generation follows `Missing`→RecoveryBlocked/P9/P10 and
writes no ToolResult, Observation, Action disposition or cursor advance. It
does not rerun reconciliation or Executor. An already durably Applied exact
P3 source follows accepted DG01 §4 natural convergence without duplication.
Stale generations are fenced before reading/projecting either P4 or P3 winner.

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

### DID v1.23 overflow successor chain

After terminal ContextLimitExceeded with no durable output/effect, the same
AgentLoopStep may ensure exactly one ordinal-0 chain:

```text
Inference(failed) → OverflowCompaction → OverflowReplacement
```

Every link has a stable role/identity and immutable ProviderTurn/Manifest.
Replacement success resumes the existing action phase; replacement overflow is
terminal. `repairAttempt` is unchanged.

### Accepted AH10 Submitted DecisionEpisode binding failure (DID v1.42)

Fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.

For the exact DecisionEpisode `select_current_work` action, P3 validates that
the submitted DecisionRequest Workspace and the settled Provider result's own
Manifest match the authoritative Execution/Step binding before replay. Either
Workspace or Manifest mismatch returns a typed
`SubmittedDecisionBindingMismatch` classification and performs no model
context/Provider request, action handler, Gateway Command, Observation, or
ordinary Step/Action/Execution transition. P3 does not read or write P9 facts.

If the existing authorized StopExecution is durable, P3 may return a pure
stop-only close plan after revalidating the same identities and full current
unexpired lease. The unresolved P4 side-effect gate must be clear. The plan
uses the frozen early-settlement states: current Pending control Action becomes
`TerminalRejected` with disposition
`StopRequestedAfterSubmittedBindingFailure`; later Pending actions become
`SkippedEarlySettlement`; the cursor reaches the end of the complete pinned
action list; and the Step becomes
`SettlementProposed(Interrupted(StopRequested))`. No Observation is emitted.
On a Manifest mismatch, only the ProviderTurn's internally matching immutable
Manifest and pinned decoder may be read to enumerate/action-identity-check the
already persisted ledger; the mismatched Step Manifest is not accepted or
rewritten, and no decoded control may execute.

P9 Recovery/Application composition—not P3—owns the single TransactionScope
that atomically writes/reuses the durable P9 fact/event and applies this pure
P3 plan through `AgentLoopStepStore` when Stop wins before fact creation. P3
adds no state, settlement variant, event, package dependency or direct P9-store
dependency. This proposal SHA is design-only and grants no implementation
authorization.

## 11. Must Not Decide

- No Provider transport changes beyond the atomic success/store read contract.
- No new tool side-effect taxonomy; P4 remains authoritative.
- No new Execution settlement variants.
- No implementation beyond separately authorized contracts; P41 landing does
  not authorize P41 code/migration implementation or qualification.

## Accepted V21 SandboxPolicyRequired step state

Policy-required interruption adds no Step/action state and does not settle
Execution: existing Step remains ActionsInProgress, exact action is Pending,
ToolInvocation is NotAdmitted with settled_at NULL, and active Execution is
unchanged. Recovery resumes only after strict existing RecoveryBinding
verification and exact original arguments/regions/target/mount admission.
Invalid proof does not synthesize P3/P4 truth; P10 derives safe Attention
from immutable P4 rows. Real provider failure follows the existing terminal
no-effect observation and P9 fact path without a second Provider call.
