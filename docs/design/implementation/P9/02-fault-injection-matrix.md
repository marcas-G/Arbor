# P9 — 02 Fault Injection Matrix

**Authority:** DID v1.11 §11 P9 (nine injection surfaces), §6.3, §6A.5, §6A.6,
§6A.8, §6A.9, §8.16, §9.1; SD v1.3 §10, §14 No.15/16/34/35/36/37/39/46/47/48/
53/54/60; P1 `06` (C1–C11 format precedent), P1 `05` §3–§6; P2 `02` §5, P2
`03`, P2 `06`; P3 `06` §2; P4 `06` §2–§4; P7 `04`; P8 `02` §1, P8 `03`;
`planning/results/P8.result.md` (crash windows already closed deterministically);
P9 `04` (provider/tool detail), P9 `05` (consumer/rebuild detail);
GQ1/GQ2/GQ4/GQ5 adjudications (`planning/proposals/P9/00-scope-extraction.md` §3).
**Status:** DRAFT (first draft for contract review).

P9 injects faults into **existing frozen semantics** (P2 owns the recovery
mechanism; P5 owns the representative restart proof). This file freezes the
injection matrix: what is injected, where, by what means, what must be
asserted, and which guarantee class the assertion carries.

## 0. Guarantee classes (GQ5, frozen)

Every row is labeled with exactly one guarantee class:

```text
crash-injected      = fault really injected at process/daemon/worker/stream
                      level; assertion observed on the real recovery path
durability-asserted = fault not reproducible in-process (power loss, WAL
                      checkpoint); asserted via SQLite durability contract
                      (synchronous = FULL + WAL, P1 `04` §1) + declared
                      DurabilityEnvelope (DID §9.1; SD §10.7) + reopen /
                      integrity evidence (§12)
```

- **No fault-injecting SQLite adapter** (GQ5). Real crashes are injected at
  process/daemon/worker level; transaction-level operational faults continue
  the P1 adapter fault-injection discipline (§11, envelope-internal).
- **X1–X11 are superseded / non-normative archival; P9 does not reference
  them** (GQ1). Assertions cite C-series rows, §14 invariants, and frozen
  phase contracts only.
- Recovery assumed by any row below runs via startup or sweep (03 §2), never
  as a full nine-step pass per dispatch round (GQ3).
- Injection means marked *empirical* are task-level (scope-extraction §C (planning/proposals/P9/00-scope-extraction.md)); the injection
  point and the assertion are contract.

Surface → section map (DID §11 P9 enumeration):

```text
worker crash → §1    old worker resurrection → §2    lease expiration → §3
daemon crash → §4    tool outcome unknown → §5        provider disconnect → §6
consumer crash → §7 (+ §8 P7/P8 replay)               dispatch failure → §9
projection rebuild → §10 (generic face, GQ2)
```

This file is the **consolidated assertion index** for the nine surfaces.
Detail contracts `04` (recovery visibility wiring; provider/tool detail) and
`05` (offset wiring; rebuild detail) carry the same semantics at finer
granularity (e.g., 04 §1 I-1..I-3, 05 §2 CC-1..CC-6); where rows overlap, both
documents assert identical behavior — divergence between them is a defect.

## 1. Worker crash (W)

Means: terminate the worker at the named point (process kill; exact mechanism
empirical — scope-extraction §C (planning/proposals/P9/00-scope-extraction.md)). Baseline fixture: admitted Active main Execution.

| # | Injection point | Means | Durable observation & assertion | Guarantee |
|---|---|---|---|---|
| W1 | dispatch accepted, before lease acquire | kill worker | no lease row; Execution unchanged (`settled_at IS NULL`); dispatch failure never settles (P2 `02` §5); next sweep reevaluation re-dispatches | crash-injected |
| W2 | after lease acquire, before drive starts | kill worker | live lease row until TTL; Execution unchanged; no `Active → Settled` transition from crash alone (DID §6A.6; P2 `03` §1) | crash-injected |
| W3 | mid-drive (provider stream / tool effect in flight) | kill worker | dangling intents detectable (unsettled ProviderTurn / ToolInvocation → §5/§6 semantics); durable Execution state unchanged; lease lazily invalidates; new worker acquires at `generation + 1` (P2 `03` §2); resumed old attempt fenced (§2) | crash-injected |
| W4 | driver settlement proposal decided, before canonical command COMMIT | kill worker | nothing durable (writes + event + receipt share one tx, P1 `06` C3/C4); retry/re-dispatch converges; no partial state | crash-injected |
| W5 | after effectful work, before SettleExecution | kill worker | Execution stays Active; recovery settles only via durable deterministic trace (P2 `06` §4) or leaves Active for re-dispatch; unresolved side effects gate settlement (invariant 54; §5) | crash-injected |

Notes:

- Lazy invalidation is the only lease-expiry authority: no worker action is
  required for takeover; after `expires_at <= now`, acquisition CAS succeeds
  and the old fence stops validating (P2 `06` §3).
- W3 assertion must include: the takeover worker's first fenced write commits
  with the new generation, and the old worker's late write of the same
  logical content is rejected (single authoritative resolution).

## 2. Old-worker resurrection (R)

Fixture: execution re-acquired by a new worker (`generation = g+1`); the old
worker (`generation = g`) resumes and attempts durable writes across the full
fencing write surface (DID §6.3).

| # | Write surface attempted by stale generation | Expected rejection | Guarantee |
|---|---|---|---|
| R1 | Execution semantic mutation | `FencingRejected`; zero durable state change | crash-injected |
| R2 | Session append | `LeaseFencingRejected`; no entry visible | crash-injected |
| R3 | ProviderTurn settlement | `LeaseFencingRejected`; turn remains unsettled | crash-injected |
| R4 | ToolInvocation settlement | `LeaseFencingRejected`; invocation remains unsettled | crash-injected |
| R5 | Agent-produced canonical command | `FencingRejected`; terminal for that logical Command; no ordinary retry (DID §6A.5) | crash-injected |
| R6 | local uncommitted writes of the resurrected worker | invisible: never crossed a commit boundary; fence shares the mutation transaction (P2 `03` §3), so no stale write can become durable | crash-injected |

Notes:

- The fence predicate check runs in the SAME transaction as the write (P2
  `03` §3); R1–R5 assert the authoritative rejection, not the fast-fail
  pre-check.
- Neither `LeaseLost` nor `FencingRejected` fails/cancels the Work (DID
  §6A.5); assertion includes: Work lifecycle unchanged after all six rows.

## 3. Lease expiry (L)

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| L1 | TTL expires; old worker attempts SettleExecution | fence predicate `expires_at > now` fails → `FencingRejected`; settlement via `QuiescenceControlMutation` is still fenced (P2 `03` §5.1); Execution not settled by the stale worker | crash-injected |
| L2 | renewal boundary: renewal CAS succeeds (generation unchanged), commit lands before new expiry | fenced write commits; ownership continuous (P2 `03` §2) | crash-injected |
| L3 | renewal attempted after invalidation/takeover | renewal CAS fails (stale generation / no live lease); worker stops durable mutation; no ordinary retry (P2 `03` §7) | crash-injected |
| L4 | expiry observed, no takeover yet | invalidation never settles the Execution (DID §12.11; P2 `06` §3); Execution stays Active until re-dispatch or deterministic recovery settlement | crash-injected |

## 4. Daemon crash / dirty restart (D)

Fixture (all pending-state classes simultaneously): leased Active execution +
unsettled tool intent + pending wake (active WorkWait and/or unexpired
scheduler timer) + Open verification. Means: terminate the daemon (real
process kill preferred; full layer dispose/reconstruct as CI approximation —
empirical, scope-extraction §C (planning/proposals/P9/00-scope-extraction.md)); restart reconstructs the runtime from durable state.

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| D1 | restart with pending state | startup full recovery runs the nine steps (P2 `06` §2) **exactly once per startup**, in frozen order, before any new dispatch/admission (03 §2 T1) | crash-injected |
| D2 | crash during recovery, restart again | idempotent re-entry: second pass converges — no double settlement, no duplicate wake, lease invalidation monotone, no duplicate entities | crash-injected |
| D3 | unsettled tool intent in fixture | dangling detected via `ReconciliationSource.pending` (real source — B-1 wiring, 04 §1); tier semantics of §5 apply; **never** blindly settled `Interrupted` (invariant 54; 04 §1 I-1) | crash-injected |
| D4 | pending wake / timer in fixture | WorkWait survives; due timer fired by recovery/sweep drive (03 §3); not-yet-due timer row intact | crash-injected |
| D5 | Open verification in fixture | remains Open; no auto-conclude, no auto-Unknown (orphan re-drive is explicit P8 governance action, P8 `02` §3) | crash-injected |
| D6 | leased Active execution in fixture | settle-or-Active per deterministic rules only (P2 `06` §4); recovery never resurrects the old worker's authority (P2 `06` §6) | crash-injected |

## 5. Tool outcome unknown (T) — four `SideEffectSemantics` tiers

Crash injected between intent persistence and settlement (P4 `06` §2); the
dangling invocation is detected via `findUnsettled` / `ReconciliationSource`
(P4 `06` §3–§4). The `side_effect_semantics` snapshot drives classification
(DID §9.12).

| # | Tier | Crash point | Expected assertion | Guarantee |
|---|---|---|---|---|
| T1 | ReadOnly | intent persisted, effect not yet executed | dangling detected; safe retry / settle per actual outcome; no `OutcomeUnknown` required | crash-injected |
| T2 | Idempotent | after effect, before settlement | dangling detected; re-invoke converges to same external outcome (idempotent by declaration); settlement records actual outcome | crash-injected |
| T3 | Reconcilable | after effect, before settlement | reconcile against external reality (real ReconciliationSourceLive), then settle the reconciled actual outcome; never blind replay | crash-injected |
| T4 | NonIdempotent | after effect, before settlement | ambiguity → `OutcomeUnknown(ReconciliationRequired(invocationRefs))` (or stays Active/reconciling); **never automatic replay** (invariant 35; P4 `06` §4); Execution must not settle plain Completed/Interrupted/Failed (P2 `06` §5) | crash-injected |

Note: T1–T4 share the dangling-detection assertion; they differ only in the
permitted post-crash action. T4 additionally asserts no path exists from
dangling NonIdempotent intent to any settlement without reconciliation.
Expanded assertions (replay keys, no-duplicate-effect probes): 04 §3.

## 6. Provider disconnect (PD) — GQ4 mapping (zero-DID-change)

Disconnect ≜ injected scenario combination of `ProviderUnavailable` (failure
before the request is established) ∪ `StreamInterrupted` (break mid-stream).
The §6A.8 six-class model is unchanged (GQ4 option a).

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| PD1 | connection-phase failure | `ProviderUnavailable` → retryable under safe-retry policy (P3 `06` §2); retries are new `ProviderAttempt`s under the **same** ProviderTurn; `turnNo` unchanged (DID §6A.9) | crash-injected |
| PD2 | mid-stream interruption | `StreamInterrupted` → retryable; cancelled attempt ends; next attempt same Turn, `turnNo` unchanged; attempt history append-only | crash-injected |
| PD3 | terminal classes (AuthenticationFailed / RequestRejected / ProtocolViolation) | no transport retry (P3 `06` §2); Attention where required; terminal Turn failure does **not** itself settle Execution `Failed` — driver decides bounded retry/repair vs settle after exhaustion | crash-injected |
| PD4 | daemon crash leaves ProviderTurn unsettled | recovery resumes the **same Turn** with a new Attempt (`turnNo` invariant); transport retry is never recorded as an extra model round (DID §6A.9); retry boundary and exhaustion path per P3 `06` §2 | crash-injected |

Note: retry counts / backoff are empirical (P3 `06` §3 discipline); the
Turn/Attempt identity invariants above are contract. Detailed disposition
(unsettled Turn resume rules, no partial durable stream output): 04 §2
(I-4..I-7).

## 7. Consumer crash (CC)

Built on P1 `05` §3–§4 (offset + projection + dead-letter same transaction).

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| CC1 | crash mid-batch (after apply, before COMMIT) | nothing durable (offset + projection same tx) → re-delivery re-applies idempotently (key `(project_id, sequence)`) | crash-injected |
| CC2 | crash after COMMIT, before next batch | offset advanced → continue from offset; no re-processing | crash-injected |
| CC3 | poison event in batch | dead-letter row + offset advanced past it, same tx; consumer continues (no head-of-line block); operator alert (P1 `05` §3) | crash-injected |
| CC4 | P7 coordinator / P8 consumer A-B redelivery | deterministic CommandId absorbs at-least-once redelivery: existing Receipt returned / typed rejection recorded; no duplicate canonical effect (P7 `04` §2; P8 `03` §1–§2) | crash-injected |

Note: offset wiring and the expanded matrix (offset regression, poison
classification, concurrent double-dispatch) are frozen in 05 §1–§2.

## 8. P7/P8 workflow interruption replay (WF)

| # | Interruption point | Expected assertion | Guarantee |
|---|---|---|---|
| WF1 | coordinator consumption interrupted (event delivered, SatisfyDependency command not committed) | redelivery → deterministic CommandId → convergence to identical canonical state | crash-injected |
| WF2 | verifier spawn window: crash between StartVerification commit and spawn/backfill (window already closed by design, P8 `02` §1) | replay re-spawns with the same caller-preallocated executionId; AdmitExecution idempotent; no permanent "committed without Verifier" state — **P9 injects to verify the closure holds** | crash-injected |
| WF3 | consumer A / consumer B interrupted anywhere | replay converges (deterministic ids; partial unique indexes; idempotent admission); no lost wake, no duplicate Verification/Completion | crash-injected |

## 9. Dispatch failure / lost dispatch (DF)

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| DF1 | dispatch port call fails | never settles an Execution (P2 `02` §5); Execution stays Active; scheduler reevaluation re-dispatches | crash-injected |
| DF2 | dispatch accepted then lost (wake intent lost / worker never starts, incl. W1) | bottom line = next sweep reevaluation (03 §2 T2/T3) re-dispatches; single-flight conflict converges to Noop (P2 `05` §8); bounded takeover latency = sweep interval (empirical) | crash-injected |

Note: no dispatch ack surface and no new durable dispatch record (04 §4);
the observable surface is Execution state only.

## 10. Projection rebuild — generic semantics (PR, GQ2 P9 face)

GQ2 split frozen: **P9 verifies generic rebuild semantics** (this section);
**P10 implements at-scale business projection rebuild**. Semantics from P1
`05` §6.

| # | Scenario | Expected assertion | Guarantee |
|---|---|---|---|
| PR1 | consumer offset row lost (`read` returns 0) | replay from pruned floor; re-apply idempotent → converged projection, no duplicates | crash-injected |
| PR2 | explicit reset | offset reset to pruned floor = `MIN(domain_events.sequence)`; replay in `(project_id, sequence)` order | crash-injected |
| PR3 | rebuild with offset < pruned floor | refused (events already pruned); typed refusal, no silent partial rebuild | crash-injected |
| PR4 | replay idempotency | re-apply key `(project_id, sequence)`; duplicate application is no-op; projection failure never rolls back domain transactions (invariant 37) | crash-injected |

Note: reset atomicity and the expanded RB-1..RB-5 surface are frozen in
05 §3; P10 explicitly owns business-projection rebuild at scale.

## 11. Persistence-boundary faults (envelope-internal)

Continues the P1 adapter fault-injection discipline (P1 `06` §1 notes) within
the DurabilityEnvelope; no new fault-injecting adapter surface (GQ5).

| # | Fault | Expected assertion | Guarantee |
|---|---|---|---|
| PB1 | COMMIT failure injection | explicit ROLLBACK; no partial state; commands row absent; bounded retry as new CommandAttempt (P1 `06` C9) | crash-injected |
| PB2 | nested transaction attempt | typed rejection; no leaked transaction scope | crash-injected |
| PB3 | `SQLITE_BUSY` / `BUSY_SNAPSHOT` contention | `TransactionOperationalFailure` → bounded retry, no authority change (P1 `06` §2) | crash-injected |

## 12. Durability-asserted guarantees (GQ5)

Power loss and WAL-level faults are **not reproducible in-process** (P1 `06`
C10/C11). P9 does not simulate them; it records them as
**durability-asserted** with the following frozen evidence protocol:

```text
fault classes (durability-asserted, not crash-injected):
  DA1  OS/power loss after COMMIT        → committed durable
  DA2  crash during WAL checkpoint       → prior committed txs durable

evidence protocol (per daemon restart / suite run):
  1. synchronous = FULL + WAL active (P1 `04` §1; invariant 60)
  2. reopen succeeds; PRAGMA integrity_check = ok
  3. PRAGMA user_version == frozen migration baseline (P1 `06` §5)
  4. count reconciliation across core tables (executions, execution_leases,
     domain_events, commands, consumer_offsets) consistent with fixture
  5. result recorded with explicit "durability-asserted" label — never
     claimed as crash-injected
```

- Claims are bounded by the declared `DurabilityEnvelope` (DID §9.1;
  SD §10.7): storage-media loss / region loss are outside the envelope and
  are reported truthfully (P2 `06` §7).

## 13. Must Not Decide

- No recovery mechanism / settlement-rule changes (P2 `06` owns; P9 injects
  and asserts only).
- No lease CAS / lazy-invalidation / release semantics changes (P2 `03`).
- No new provider failure classifications; §6A.8 stays unchanged (GQ4).
- No fault-injecting SQLite adapter; no power-loss/WAL simulation claim (GQ5).
- No reference to X1–X11 (GQ1).
- No at-scale business projection rebuild (P10; GQ2).
- No per-dispatch full recovery (GQ3; restated in 03 §2).
- Injection infrastructure shape, crash-simulation mechanism, retry counts,
  TTL/sweep/batch numeric values: empirical, task-level (scope-extraction §C (planning/proposals/P9/00-scope-extraction.md)).
