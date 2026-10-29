# P12 — 08 Runtime Safety Envelope Completion (G7)

**Authority:** DID v1.20（继承 v1.14 G7，并含 AHT-1/AHT-5）；§8.16A, §3.4；SD v1.3 §7.7, §14 No.54/58；P2 `02` §5/§3A, P3 `08`, P9 `03`/`07`。
**Status:** DRAFT.

## 1. Six dimensions (frozen, DID §8.16A)

```text
D1  max transient retries per operation
D2  max repeated identical action fingerprints
D3  max tool recursion / chaining depth
D4  max consecutive turns without durable progress
D5  provider / tool concurrency ceilings
D6  rate / runaway protection
```

P2 owns execution-wide gating at the `ExecutionDriverPort` boundary; P3 reports activity at
each ProviderTurn / ToolInvocation / Specialist boundary. P2 gating ownership is **not
reopened**; the only P2 port change is the declared inherited `admitActivity` observation
channel (§7A, N-12). P12 completes the mechanism as cross-phase closure (P12 completion
blocker #3).

## 2. Completion gate (frozen)

P12 **cannot close** until every dimension D1–D6 has mechanically evidenced:

```text
observation source
state semantics
reset semantics
evaluation rule
configurable threshold / policy
violation action
restart / durability behavior
tests
```

## 3. Per-dimension contract (frozen shape)

| Dim | Observation source | State | Reset | Rule | Policy | Violation | Restart / durability |
|---|---|---|---|---|---|---|---|
| D1 | ProviderAttempt boundary (`retryCount`, §7/§7A) | per-op retry counter | operation success / new op | `retryCount` ≥ max | maxRetries | `Interrupted(RuntimeSafetyStop)` | in-process; reset on restart |
| D2 | semantic activity fingerprint | per-fingerprint count | shared `durableProgress` / new semantic fingerprint | count > max | maxRepeatedFingerprints | same | in-process; reset on restart |
| D3 | tool invocation nesting (`chainDepth`, §7) | recursion depth | tool return / new chain | depth > max | maxRecursionDepth | same | in-process; reset on restart |
| D4 | new ProviderTurn boundary + shared `durableProgress` signal (§5, §7/§7A) | consecutive no-progress turns | same shared `durableProgress: true` that clears D2 | turns > max | maxNoProgressTurns | same | in-process counter; reset on restart |
| D5 | concurrent provider/tool calls (`inFlight` gauge + `leaseGeneration`, §7/§7A) | in-flight counters keyed by `(executionId, leaseGeneration)` | call completion | in-flight > ceiling | concurrencyCeiling | same | in-process; reset on restart |
| D6 | request rate (`observedAt` + `rateWindowMs`, §7/§7A) | rate window | window expiry | rate > limit | rateLimit, rateWindowMs | same | in-process; reset on restart |

- Thresholds are **configurable** via `RuntimeSafetyPolicy` (§6); mechanism/state/reset/rule/violation/tests must not be missing.
- **Restart / durability behavior (RG-11)**: every dimension's counter state is
  **in-process** and **reset on daemon restart**; a resumed Execution continues
  with fresh counters. This **maintains** the P2-frozen gate semantics and the
  P9 `03` §4 note — P12 records **no** upgrade to durable state
  (`agent_execution_state` is **not** used for gate counters). Changing this
  requires an explicit P9 contract change, not a P12 implementation choice.

## 4. Violation action (frozen)

```text
Execution → Interrupted(RuntimeSafetyStop(reason))
Work remains Open
Attention emitted
Safety Envelope MUST NOT auto-Cancel Work
```

## 5. Shared durable-progress signal (P12-DG-01; replaces E-02 source rule)

One `durableProgress` observation is the shared reset signal for D2 and D4.
Since the preceding new ProviderTurn boundary it is true iff at least one of
the following was committed:

1. a control or executable AgentAction reached a successfully terminal,
   durably sourced outcome; or
2. an attributable authoritative application/canonical mutation was committed.

The producer is the P3 driver/action path, which has the durable-source and
commit evidence; P2's gate still has no durable-read capability
(`admitActivity` `R = never`, P2 `02` §5). The gate only consumes the existing
boolean observation. A true value clears D2's repeated-fingerprint history
and resets D4's consecutive no-progress counter to zero at that new
ProviderTurn boundary. A false or absent value leaves D2 history intact and
increments D4. The count/threshold rules remain `count > max` and
`turns > max`; Work stays Open on `RuntimeSafetyStop` (§4).

The following are **not progress by themselves**: ProviderResult/Attempt
journaling; AssistantMessage/ModelOutput or other sourced Session text;
monotone AgentLoopStep/action cursor or state progression; P9 replay,
reconciliation, recovery links, receipts, or handoff bookkeeping; and a
persisted unsuccessful result. Typed Failed, Denied, Rejected, Interrupted, or
OutcomeUnknown outcomes remain durably sourced/model-visible as applicable,
but do not clear D2 or reset D4. An idempotent replay of an existing row is not
a new successful terminal outcome. If a replay path itself commits a new
qualifying action outcome or attributable authoritative mutation, that new
commit may contribute to the next new ProviderTurn boundary; old P9 evidence
does not.

The same rule applies to compaction/checkpoint and other ProviderTurn
operations: a Session/ContextEpoch/checkpoint commit alone is not shared
progress. Their operation-specific safety bounds remain in force. P9's
unresolved/unknown-side-effect gate retains precedence over safety-stop
settlement; this change does not downgrade `OutcomeUnknown` or authorize replay.
Evidence is durable, but D2/D4 counters remain in-process and reset on daemon
restart per §3 / RG-11.

## 6. Policy injection surface (E-03)

Thresholds are configuration, not contract (P2 `02` §5: "Numeric thresholds
are implementation/configuration, not contract"). P12 fixes the injection
surface:

```ts
interface RuntimeSafetyPolicy {
  readonly maxRetries: number;               // D1
  readonly maxRepeatedFingerprints: number;  // D2
  readonly maxRecursionDepth: number;        // D3
  readonly maxNoProgressTurns: number;       // D4
  readonly concurrencyCeiling: number;       // D5
  readonly rateLimit: number;                // D6
  readonly rateWindowMs: number;             // D6 window (R-06)
}

RuntimeSafetyGateLive(policy: RuntimeSafetyPolicy): Layer<RuntimeSafetyGate>
```

- The policy is supplied at composition; no dimension may be silently
  defaulted to "unlimited".
- Test: `{ maxRetries: 1 }` stops on the **second** attempt (`retryCount 0` →
  `Continue`, `retryCount 1` → `Stop`); `{ maxRetries: 3 }` does **not** stop
  through three attempts.
- Test (R-06): `{ rateLimit: N, rateWindowMs: W }` — N calls with `observedAt`
  inside `W` → `Continue`, the (N+1)-th call inside `W` → `Stop`; after `W`
  expires the window resets and calls `Continue` again.

## 7. Observing D1/D3/D4/D5/D6 through the P2 gate (E-04, DF-03, R-05, NEW-4, NEW-7)

The frozen `ExecutionActivity` is exactly
`{ ProviderTurn | ToolInvocation | SpecialistAction, fingerprint }` (P2 `02`
§5); it carries **no** attempt/retry token, durable-progress fact, lease
generation or rate timestamp. Only D2 (identical `fingerprint`) is fully
observable from the activity stream; D1/D3/D4/D5/D6 each need an explicit
signal. P12 adds an **additive, optional** observation channel — the frozen
two-argument `admitActivity(executionId, activity)` call remains valid and
semantically unchanged. Widening the P2 port with the optional third argument
is a **declared inherited P2 evolution**, not a silent reopen (§7A):

```ts
interface RuntimeSafetyObservation {
  readonly retryCount?: number;                // D1: 0-based retry ordinal (0 = first attempt)
  readonly durableProgress?: boolean;          // P12-DG-01: shared D2/D4 progress since previous new ProviderTurn boundary
  readonly chainDepth?: number;                // D3: tool recursion / chaining depth
  readonly inFlight?: "begin" | "end";         // D5: lease-scoped in-flight gauge
  readonly leaseGeneration?: LeaseGeneration;  // D5: lease generation the gauge is scoped to
  readonly observedAt?: string;                // D6: rate-window timestamp
}

admitActivity(
  executionId: ExecutionId,
  activity: ExecutionActivity,
  observation?: RuntimeSafetyObservation,
): Effect<SafetyDecision>;
```

- **D1 (N-02/R-05)**: the driver reports `retryCount` at each `ProviderAttempt`
  boundary. Provider retry never creates a new `ProviderTurn` (DID §6A.9), so
  this signal is the only observation channel for transient retries. The gate
  stops when `retryCount >= maxRetries`; `{ maxRetries: 1 }` yields
  `retryCount 0` → `Continue` (attempt #1) and `retryCount 1` → `Stop`
  (attempt #2).
- **D2/D4 (P12-DG-01).** The same `durableProgress` observation drives both
  reset effects. P3 reports true only for the committed success/authoritative
  mutation evidence in §5; ProviderResult, ModelOutput, step/cursor progression,
  unsuccessful sourced outcomes, and P9 replay/handoff are not progress. False
  or absent means D2 is not cleared and D4 increments. P2 counts the boolean
  and never reads durable state.
- **D2 ProviderTurn fingerprint (P12-DG-01).** For each new ProviderTurn
  operation, P3 compiles the exact portable request and obtains that path's
  existing stable opaque request hash before admitting it to the provider.
  Fingerprints are operation-kind namespaced. Inference uses its existing
  `compiledRequestHash` (FNV-1a over request plus tool routes); Summary/Native
  compaction and Conversation checkpoint paths reuse their existing
  SHA-256-based request identity. No single hash algorithm or authority hash is
  claimed. ProviderAttempt retries reuse the admitted ProviderTurn and do not
  create another D2/D4 admission.
- **D2 ToolInvocation fingerprint (P12-DG-01).** The semantic action identity
  binds route kind, tool/action name and canonical semantic arguments; it
  excludes callRef and other per-invocation/step identities. The exact helper
  remains subject to its accepted equivalence qualification (reordered object
  keys equal; materially changed arguments distinct); it is not a persisted
  or P4 recovery-binding codec.
- **D3**: the driver supplies `chainDepth` at each `ToolInvocation` /
  `SpecialistAction`; depth resets on tool return / new chain.
- **D5 (NEW-7)**: the driver brackets every provider/tool call with
  `inFlight: "begin"` / `"end"` together with the current `leaseGeneration`; the
  gauge is **lease-scoped** — keyed by `(executionId, leaseGeneration)` — and
  resets on call completion.
- **D6 (R-06)**: `observedAt` feeds a sliding `rateWindowMs` window (§6); expiry
  resets it.
- Tests assert a retry violation, a depth violation, an in-flight ceiling
  violation, a no-progress violation, and a rate violation each → `Stop` →
  `Interrupted(RuntimeSafetyStop)`, Work Open.

## 7A. Inherited P2 evolution — `admitActivity` observation channel (v1.14 G7, N-12)

The frozen P2 `RuntimeSafetyGateService.admitActivity` (`P2 02` §5,
`packages/ports/src/execution.ts`) is exactly two-argument. The six-dimension
completion (§8.16A / G7) requires D1/D4/D5/D6 signals that the frozen
`ExecutionActivity` does not carry, so P12 declares the following **inherited
P2 port evolution** — the only P2 gate change (see §9):

```ts
// packages/ports/src/execution.ts — P12 evolution
readonly admitActivity: (
  executionId: ExecutionId,
  activity: ExecutionActivity,
  observation?: RuntimeSafetyObservation,
) => Effect.Effect<SafetyDecision>;
```

- The change is **additive and optional**: an existing two-argument caller
  compiles and behaves identically; no existing P2 gate semantics change.
- `RuntimeSafetyObservation` is defined in §7; `leaseGeneration` uses the P2
  `LeaseGeneration` (`packages/ports/src/execution.ts`).
- P2 ownership is unchanged: P2 owns execution-wide enforcement at the
  `ExecutionDriverPort` boundary, P3 reports, and numeric thresholds remain
  configuration (P2 `02` §5).
- This is filed like `06` §3's lease-incarnation evolution: the P2 port shape
  changes, the ownership/semantics do not.

## 7B. AgentLoopStep write and scheduling obligations (DID v1.20)

- Every AgentLoopStep/action/Session handoff mutation is a short transaction that
  validates `(workerId, workerIncarnationId, generation)` and lease expiry with
  the write. A pre-write renewal is optional optimization only.
- Provider event consumption, decode, action reconstruction and reconciliation
  loops must remain cooperatively schedulable. A loop of immediately resolved
  effects may not monopolize the runtime past the lease TTL; it yields often
  enough for the TTL/3 renewal fiber to commit.
- Lease loss stops the current writer. It does not convert a settled Provider
  success to failure and does not authorize another request; P9 `07` resumes
  from the durable AgentLoopStep.
- A P9 settled-result replay is not a new ProviderTurn/D2/D4 boundary and makes
  no Provider request. ProviderResult, OutputAccepted, Step/cursor and handoff
  records alone do not set the shared progress signal. Only a newly committed
  qualifying action/effect during replay can accumulate progress for the next
  new ProviderTurn boundary.
- `ReconciliationPending` is checked before safety-stop settlement. A runtime
  safety Stop cannot downgrade unknown side effects to ordinary Interrupted;
  the P3/P4/P9 reconciliation/OutcomeUnknown rule wins.
- Mechanical evidence includes a dense immediately-ready Provider stream whose
  wall time exceeds one renewal interval and asserts at least one durable
  renewal before result handoff.

## 7C. SCRC compaction / overflow safety observations (DID v1.22)

- One productive compaction that advances ContextEpoch is a durable
  continuation/checkpoint outcome and is not by itself a repeated-compaction
  or doom-loop violation. It does not independently set the shared D2/D4
  `durableProgress` signal; that remains governed by §5.
- Repeated compaction with no meaningful reduction, unchanged frontier, or a
  second provider overflow is a bounded safety failure and stops the current
  Execution with typed failure/Attention; it never loops indefinitely.
- Overflow recovery is allowed only before durable assistant output or
  Tool/Control effect in that logical step.
- Runtime safety Stop cannot turn ordinary `NeedsCompaction` into a user-facing
  manual retry requirement, and cannot bypass the unresolved-side-effect gate.

## 8. Invariants

```text
CI-4  D1–D6 each have the eight evidenced facets
safety counters never auto-Cancel Work
P2 gating ownership unchanged (P3 reports; P2 decides)
the only P2 gate port change is the declared optional observation argument (§7A)
gate counters are in-process and reset on restart (RG-11; P9 `03` §4)
AgentLoopStep transitions are fenced P9 recovery evidence, not shared D2/D4
progress by themselves; AgentAction itself remains process-local.
RuntimeSafety Stop cannot bypass the unresolved-side-effect gate
productive epoch advance is bounded continuation, not shared D2/D4 progress by
itself; repeated no-gain compaction is bounded
```

## 9. Must Not Decide

- No P2 gating-ownership change; the only P2 port-contract change is the
  declared inherited `admitActivity` observation channel (§7A).
- No auto Work cancellation; no user-budget coupling.
- No durable persistence / upgrade of gate counters (P9 `03` §4; RG-11).

## 10. Verification

```text
per dimension: a test drives the violation → Interrupted(RuntimeSafetyStop), Work Open
per dimension: reset on the stated trigger
restart/durability behavior asserted (E-01):
  construct RuntimeSafetyGateLive, drive to max-1, dispose/reconstruct,
  assert the counter value per the declared in-process reset behavior
D1 retry signal (N-02/R-05):
  retryCount reported at ProviderAttempt boundary (no new ProviderTurn);
  {maxRetries:1}: attempt #1 Continue, attempt #2 Stop
shared D2/D4 signal (P12-DG-01):
  false/absent at a new ProviderTurn boundary preserves D2 history and increments
  D4; one true signal clears D2 and resets D4 together
  successful terminal sourced AgentAction / attributable authoritative commit → true
  Failed/Denied/Rejected/Interrupted/OutcomeUnknown, output-only, step-only, or
  P9-only replay/handoff → false
  semantic ProviderTurn hash is compiled before gate/network; Stop → zero Provider calls
  semantic AgentAction hash ignores callRef and compares canonical argument meaning
policy injection (E-03):
  {maxRetries:1} stops on the second attempt; {maxRetries:3} does not
D3/D5/D6 observation (E-04/NEW-7/R-06):
  chainDepth violation, in-flight ceiling violation, rate violation each Stop
D5 lease scope (NEW-7):
  in-flight gauge is keyed by (executionId, leaseGeneration); a stale
  leaseGeneration's gauge does not count against the live lease
D6 rate window (R-06):
  {rateLimit:N, rateWindowMs:W}: N calls in W Continue, N+1-th in W Stop;
  after W expires the window resets and calls Continue
```
