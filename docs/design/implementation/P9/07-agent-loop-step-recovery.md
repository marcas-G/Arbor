# P9 — 07 AgentLoopStep Recovery and Legacy Adoption

**Authority:** DID v1.20 AHT-1…AHT-8；P3 `08`；人工治理裁决
`planning/proposals/provider-result-handoff-governance-decision.md`。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。

## 1. Recovery order extension

P2's nine-step recovery order remains. During “reconcile external reality” and
“settle deterministic outcomes”, P9 adds the following per-Execution order:

```text
1. reconcile Provider success evidence locally
2. load / adopt the unique AgentLoopStep
3. replay pinned decode for settled Provider success
4. converge idempotent Session output
5. converge action ledger + immediate Observations
6. apply unresolved-side-effect gate
7. ensure the persisted successor OR submit the persisted settlement proposal
8. converge settled Execution → HumanMessage / projections
```

Recovery obtains a current lease before any Execution-originated runtime write.
RecoveryController authority remains the only unfenced path for canonical
settlement and cannot execute Agent actions.

## 2. State disposition matrix

| Durable state | Recovery action | Provider request |
|---|---|---|
| Turn unsettled + complete success evidence | atomically complete Attempt/Turn locally | forbidden |
| Turn unsettled + no complete success evidence | existing P9 same-Turn safe retry | allowed by retry policy |
| Turn terminal failure / repair exhausted | persist/read settlement proposal | forbidden |
| settled success + `Prepared`/`ProviderResultAvailable` | read events, pinned decode, advance handoff | forbidden |
| `OutputRejected(Retry(successor))` | `ensureSuccessor`; resume exact record | only successor's first execution |
| `OutputRejected(Exhausted(settlement))` | advance to persisted `SettlementProposed` | forbidden |
| `OutputAccepted` | rebuild decoded calls, verify hashes, continue at action cursor | forbidden |
| `ActionsInProgress` | query each LogicalActionId; converge or execute next Pending | forbidden |
| any `ReconciliationPending` | reconcile, Attention, or OutcomeUnknown | blind replay forbidden |
| `StepEffectsCommitted` | persist one next-turn successor or settlement | only new successor |
| `NextStepReady(successor)` | `ensureSuccessor`; resume exact record | only new successor |
| `SettlementProposed` + Active Execution | new-generation SettleExecution Command | forbidden |
| settled Execution | converge linked runtime/message state only | forbidden |

## 3. Legacy adoption

Migration `0017_agent_loop_step_handoff` is forward-only and additive. Its adoption
job enumerates Active Executions without an `AgentLoopStepRecord` and builds an
evidence set from Manifest, ProviderTurn/Attempt, sourced SessionEntry,
ToolInvocation, Application Command receipts and Execution state.

An AgentLoopStep is synthesized only when all of these are unique and consistent:

```text
executionId + logicalStepNo + repairAttempt + providerTurnId
Execution / Session / ContextEpoch / model / Manifest binding
decoder version or a governed legacy-decoder mapping
action/effect disposition (or proof that no action exists)
```

Disposition:

- existing sourced ModelOutput → bind its sequence and adopt at
  `OutputAccepted`;
- complete successful Provider result, no ModelOutput, no actions/effect
  ambiguity → adopt at `ProviderResultAvailable`;
- incomplete/contradictory identity, unknown repair attempt, or unprovable
  action side effect → durable Attention/ReconciliationRequired; no Provider
  request, action, Session append or direct settlement;
- a repeated adoption run returns the same record or Attention and never
  advances a step without new authoritative evidence.

The DOGFOOD-DG-01 equivalent fixture is explicitly authorized for the second
case: one settled successful Turn, complete canonical events, matching
Execution/Session/Manifest, no tool/control actions, and no sourced
ModelOutput. This is design authorization for a future migration test, not
permission to modify the preserved database now.

## 4. Crash-injection matrix

Kill before and after every commit boundary, restart on the same durable DB:

| ID | Boundary |
|---|---|
| AH1 | complete terminal events → ProviderAttempt Success |
| AH2 | ProviderAttempt Success → ProviderTurn settled |
| AH3 | ProviderTurn settled → AgentLoopStep ProviderResultAvailable |
| AH4 | Provider terminal failure / repair exhaustion → SettlementProposed |
| AH5 | decode complete → sourced ModelOutput SessionEntry |
| AH6 | SessionEntry → AgentLoopStep OutputAccepted |
| AH7 | each action intent/effect/settlement/Observation/cursor transition |
| AH8 | action A committed; before B, ControlBasis becomes stale |
| AH9 | action proposes settlement; remaining actions not yet marked skipped |
| AH10 | old-generation FencingRejected receipt → new-generation takeover |
| AH11 | Observation append → StepEffectsCommitted |
| AH12 | SettlementProposed → SettleExecution |
| AH13 | Execution settled → HumanMessage convergence |
| AH14 | legacy adoption first run → identical second run |
| AH15 | Inbox Session append ↔ Inbox consumed |
| AH16 | Tool settlement ↔ sourced ToolResult append |
| AH17 | Compaction completed checkpoint ↔ epoch advance |
| AH18 | Provider overflow first recovery ↔ second terminal overflow |
| AH19 | ProviderNative binding match ↔ mismatch portable rebuild |

AH18 uses the DID v1.23 ordinal-0 ProviderTurn chain. Recovery ensures links
idempotently and never rewrites the failed inference Manifest. A replacement
overflow creates no second ordinal.

Every injection asserts stale-generation writes are rejected, stable identities
prevent duplicate Session entries/external effects, and the state transition
matches its result branch. Branch-specific assertions:

| Branch | Required result |
|---|---|
| complete Provider success exists | no new request for that Turn; successful convergence yields one logical reply |
| authorized transport retry | same Turn/new Attempt; no duplicate accepted output/effect |
| repair/next-turn successor | exactly one stable new Turn; predecessor decision not recomputed |
| Completed | no extra request; HumanMessage Answered with one bounded reply |
| Interrupted | no automatic retry; HumanMessage Answered with null body |
| Failed / OutcomeUnknown | original Execution creates no fake reply; P14 may release a new conversation attempt |
| ReconciliationPending / Attention | no blind request/action/ordinary settlement; no duplicate reply |
| insufficient legacy evidence | durable Attention; no request and no forced answer |

NonIdempotent/Reconcilable injection must include “external effect occurred,
settlement missing”: no blind replay and no ordinary completion until the tool
contract supplies reconciliation evidence; otherwise Attention or
OutcomeUnknown. The dense immediately-ready SSE test remains mandatory and
must show an actual TTL/3 lease renewal commit.

## 5. Completion gate

Design closure resolves `DOGFOOD-DG-01`'s unanswered recovery semantics.
Implementation completion remains separately gated and requires:

1. migration `0017` and all new stores/ports;
2. AH1–AH14 green at both sides of each boundary;
3. the original-failure equivalent fixture converges to one authoritative
   Session answer without another Provider request;
4. evidence-insufficient fixtures stop at durable Attention;
5. the preserved database remains untouched until an explicitly authorized,
   separately verified migration run.
6. AH15–AH19 pass on both sides of each commit boundary; no duplicate Inbox
   delivery, Tool effect, inference step or checkpoint occurs.

## 6. Must Not Decide

- No new Provider failure or Tool side-effect tag.
- No direct SQL repair procedure for operators.
- No implementation authorization.
