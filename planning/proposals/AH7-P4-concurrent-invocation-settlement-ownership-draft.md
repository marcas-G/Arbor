# AH7 / P4–P2 invocation settlement seam — revised draft

Status: **Historical diagnostic candidate; the frozen P2/P9 stale-generation
requirement is implemented. Direct unleased P4 projection remains pending.**

Scope: the seam between P4 `ToolRuntime` invocation idempotency and P2/P9
execution-lease ownership, especially same-key re-entry, stale-generation
settlement, and RecoveryController takeover.

## Why this revision is narrower

The deterministic P4 RED below is a valid lower-layer counterexample, but it
does **not** prove that production can dispatch two valid Workers in the same
live lease generation. P2 leases are the execution-level concurrency gate.
The test directly assembles two `ToolRuntimeLive` callers with the same intent
and no `ExecutionOrigin`, lease holder, or fencing generation. It must not be
read as evidence that two production Workers can both own one Execution.

Production does have a distinct stale-generation case: a lease may expire
while a worker is in-flight, and a new generation can take over. P2 `03` and
P9 `02` explicitly require that every old-generation durable write, including
ToolInvocation settlement, be rejected. That is a frozen contract, not a new
“permanent intent owner” rule. The production P4 call chain currently does not
carry the worker fence to `ToolInvocationStore.settle`, so the frozen seam is
not represented by the P4 port/adapter API and needs implementation-level
closure.

## Deterministic lower-layer counterexample

The test is in
`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`:

1. Two OS processes connect to one SQLite file and rendezvous before invoke.
2. A records the unique intent and appends the external effect exactly once;
   `AH7AfterToolEffectBeforeSettlement` holds A before durable settlement.
3. B re-enters directly through P4 with the identical intent and no P2 lease
   context. The existing-prior branch writes `OutcomeUnknown` and returns it.
4. A resumes and returns `Success`, but its conditional settlement update is
   now a no-op because B already terminalized the row.
5. The RED asserts one effect, one invocation, caller outcomes A=`Success` and
   B=`OutcomeUnknown`, and canonical durable settlement=`Success`. Only the
   last assertion fails: the row is `OutcomeUnknown`.

This is deterministic at the P4 boundary. The earlier unconstrained two-process
case failed once in the full check and passed six focused reruns; that supports
the race explanation but does not establish production dispatch reachability.

Relevant code evidence:

- `packages/tool-runtime/src/runtime.ts`: existing unsettled
  `NonIdempotent` prior writes a terminal unknown settlement.
- `adapters/persistence-sqlite/src/tool-invocations.ts`: settlement is a
  `WHERE settled_at IS NULL` update, returns `void`, and does not report a
  zero-row CAS or reread canonical state.
- `apps/single-workspace/src/executable-tool-handler.ts`: production builds
  `ToolExecutionContext` without lease holder/generation; the P4
  `ToolInvocationStore` port also has no settlement-fence argument.

## Production dispatch and lease reachability

Read-only code audit plus the targeted P2 lease test establish:

- `apps/single-workspace/src/production.ts` funnels active execution attempts
  through `preDispatchCheck` and `runExecution` (`runIfDispatchable`).
- `packages/execution-runtime/src/execution-runtime.ts` acquires a lease before
  calling `driver.drive`; a live-lease acquisition failure is
  `LeaseFencingRejected` and the caller never reaches the driver.
- `adapters/persistence-sqlite/src/execution.ts` uses one lease row per
  Execution and acquires with an atomic upsert permitted only when the prior
  row is expired; successful takeover increments generation.
- `packages/agent-runtime/src/model-output-journal.ts` processes one Provider
  Turn's tool invocations in a serial `for` loop, not concurrent `Promise.all`
  dispatch.
- `adapters/persistence-sqlite/test/p2-lease.test.ts` confirms a second holder
  is rejected while the first lease is live and a later holder acquires the
  next generation. Targeted result: 1 file / 2 tests PASS.

Conclusion: a **same-generation second Worker** cannot legally enter P4 for
the same active Execution through the production dispatch path. The direct RED
is not production proof for that state.

Different generations are reachable after lease expiry/takeover. P2 `03` §3
requires authoritative same-transaction fencing for every Worker-originated
durable write, including ToolInvocation settlement. P9 `02` W3/R4 requires an
old Worker to leave the invocation unsettled and receive
`LeaseFencingRejected`. This gives an existing contract for stale-generation
settlement; no permanent-intent-owner semantic should be added. However, the
current production P4 context/store path does not carry or check that fence.
Whether `raceFirst` interruption always prevents a late P4 settlement is not
proven here; the P9 contract requires an authoritative fence even when a stale
write is attempted.

## Three-state P4/P2 contract seam requested

| State | Production reachability | Durable authority and loser result |
|---|---|---|
| **Same-generation live duplicate** | A second Worker is blocked before `driver.drive` by the live lease CAS. The direct P4 RED has no lease and is a component-level stress case, not a legal dual-Worker dispatch. | Do not infer a permanent owner from intent insertion. At P4, a duplicate must not execute the effect. If it reports `OutcomeUnknown` while the row is unresolved, the result should not terminalize the shared row ahead of the active caller; P2 remains responsible for crash/lost-owner disposition. The exact direct-P4 projection should be confirmed with the owner contract. |
| **Old generation after takeover** | Reachable when the TTL expires and a new generation acquires while the old process is still unwinding. | P2 `03` §3 + P9 `02` R4 already require a same-transaction fence on ToolInvocation settlement. Old generation must receive `LeaseFencingRejected` (or its typed P4 operational translation), must not return a successful observation from an uncommitted settlement, and must not mutate the row. New generation must not repeat a non-idempotent effect; its unresolved ref remains for reconciliation. |
| **RecoveryController takeover** | Recovery runs over durable state; it is not another Worker generation and never invokes the P4 executor. P2 `06`/P9 `01` own the disposition. | Recovery reads the canonical invocation/evidence. A committed settled success is reused by the durable AgentLoopStep handoff; an unresolved non-idempotent ref is enumerated and escalated/settled `OutcomeUnknown` only by the governed recovery path. No stale Worker authority is resurrected and no effect is replayed. |

## CAS result and canonical read

The P4 store currently returns `void` from `settle`; zero updated rows are
indistinguishable from a successful commit to `ToolRuntime`. The owning P4/P2
contracts should make the result observable:

- Worker settlement first checks the full current lease-holder triple and
  expiry in the **same transaction** as the settlement CAS. A stale generation
  gets `LeaseFencingRejected` before any canonical read or mutation.
- A successful one-row CAS returns `Applied` and the stored canonical
  settlement.
- A zero-row CAS under a still-valid authority rereads the row in the same
  transaction and returns `AlreadySettled(canonicalRecord)` only when the
  exact invocation identity is compatible. It must never return the caller's
  attempted success while the stored state says `OutcomeUnknown`.
- An authorized re-entry seeing an unresolved non-idempotent intent returns
  no-effect/unknown and leaves durable reconciliation to P2; it does not write
  a terminal result merely because another owner may have crashed. Recovery
  or the active effect owner is the only path that later changes canonical
  state.
- RecoveryController has separate authority and no worker generation; it
  rereads canonical state and applies only the P2 recovery disposition.

The first bullet is already required by P2/P9. The latter CAS/readback shape is
the minimal proposed P4/P2 port clarification. It preserves at-most-once
effects and prevents caller observation from disagreeing with the durable
canonical row.

## Existing-contract disposition

- **Not a new P2 lease semantic:** P2 already prohibits same-generation
  multi-holder and requires stale-generation fencing.
- **Former implementation gap under existing P2/P9 contract:** the P4 Worker
  call path lacked fencing data in `ToolExecutionContext` /
  `ToolInvocationStore`, although P9 R4 requires the settlement boundary to
  fence. The authorized implementation now threads the current Worker triple,
  checks it inside the SQLite settlement transaction, and reports the result
  in `planning/results/P4-AH7-tool-settlement-lease-fence.result.md`.
- **Direct-P4 RED classification remains narrow:** it proves that an
  unleased P4 duplicate can persist `OutcomeUnknown` over a live caller's
  success; whether P4 must make that re-entry non-terminal is an owner-contract
  clarification, not proof that production dispatch violates P2.
- The direct-unleased P4 projection remains deliberately quarantined as a
  pending diagnostic. It is not production lease reachability evidence and
  does not authorize a permanent intent-owner rule. Its original assertion is
  retained, not relaxed, in the skipped case in
  `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`.
- No `docs/design/**` change or new RecoveryController behavior was introduced.

## Required qualification after ruling

Keep the deterministic direct-P4 RED intact until the P4 owner resolves its
scope. Add or adapt a production-path qualification for the existing P2/P9
contract that proves:

- live generation G admits only one `runExecution` driver; a second attempt
  fails lease acquire before Provider/Tool dispatch;
- after generation G+1 takeover, G's ToolInvocation settlement is rejected in
  the authoritative transaction and leaves the invocation unsettled;
- G+1 does not re-run the non-idempotent effect, and recovery handles the
  canonical unresolved ref without resurrecting G;
- any zero-row settlement CAS rereads canonical state for an authorized
  caller, while stale authority receives fencing rejection first;
- exactly one external effect, one invocation identity, and one canonical
  settlement/observation path remain evidenced.

No assertion should be weakened to accept either `Success` or
`OutcomeUnknown` without identifying the lease generation, actual effect
owner, canonical DB row, and recovery disposition.

The required stale-generation production qualification is now evidenced by
`tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`.
The direct-unleased P4 case remains skipped/pending until the P4 owner decides
whether that lower-layer projection is a supported contract; its assertion is
still present verbatim in the diagnostic test body.
