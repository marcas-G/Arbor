# P12 — 08 Runtime Safety Envelope Completion (G7)

**Authority:** DID v1.14 G7, §8.16A, §3.4 (quiescence), §6.2; SD v1.3 §7.7, §14 No.54/58; P2 `02` §5, P9 `03` §4.
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
| D2 | activity fingerprint | per-fingerprint count | durable progress / new fingerprint | count > max | maxRepeatedFingerprints | same | in-process; reset on restart |
| D3 | tool invocation nesting (`chainDepth`, §7) | recursion depth | tool return / new chain | depth > max | maxRecursionDepth | same | in-process; reset on restart |
| D4 | turn boundary + `durableProgress` signal (§5, §7/§7A) | consecutive no-progress turns | `durableProgress: true` | turns > max | maxNoProgressTurns | same | in-process counter; reset on restart |
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

## 5. Durable progress (frozen definition, E-02)

D4's "durable progress" is defined concretely as:

```text
durable progress := a committed canonical mutation (any CommandGateway-
committed state change) OR a ToolInvocation settlement recorded in the
journal, observed at a turn boundary since the previous turn boundary.
```

- The turn boundary is the point at which the driver reports the next
  `ProviderTurn` activity to the gate.
- **Progress signal (NEW-4).** The gate itself has no durable-read capability
  (`admitActivity` `R = never`, P2 `02` §5) and `ExecutionActivity` carries no
  progress fact. The **driver** — which already holds the canonical/journal
  capability — evaluates the definition above and reports
  `durableProgress: true|false` on the observation channel (§7) at each turn
  boundary. The gate only counts the boolean; it never reads durable state.
- A turn boundary reported `durableProgress: false` (or absent) increments the
  D4 counter; a boundary reported `durableProgress: true` **resets** the D4
  counter to zero.
- N consecutive no-progress turns with `N > maxNoProgressTurns` → `Stop` →
  `Interrupted(RuntimeSafetyStop)`, Work remains Open (§4).
- The progress **evidence** is durable (canonical/journal), but the D4
  **counter** is in-process per §3 (RG-11).

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
  readonly durableProgress?: boolean;          // D4: durable progress since previous turn boundary
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
- **D4 (NEW-4)**: the driver reports `durableProgress` at a turn boundary iff a
  canonical mutation was committed or a ToolInvocation settlement was journaled
  since the previous boundary (§5); the gate counts the boolean, never reads
  durable state.
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

## 8. Invariants

```text
CI-4  D1–D6 each have the eight evidenced facets
safety counters never auto-Cancel Work
P2 gating ownership unchanged (P3 reports; P2 decides)
the only P2 gate port change is the declared optional observation argument (§7A)
gate counters are in-process and reset on restart (RG-11; P9 `03` §4)
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
durable progress (E-02/NEW-4):
  driver-reported durableProgress:false for N turns → Interrupted(RuntimeSafetyStop),
  Work Open; one durableProgress:true turn resets the counter
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
