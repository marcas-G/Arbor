# P9 — 00 Contract Index

**Authority:** DID v1.20（含原 DID v1.11 P9 closure 与 AHT-1…AHT-8）；SD v1.3 §6.5/§7.3/§10/§14；P1 `06`/`07`, P2 `03`/`06`, P3 `06`/`08`, P4 `01`/`02`/`06`, P5 `04`/`05`, P8 `00`/`02`/`03`；GQ1–GQ5 与 2026-09-30 AgentLoopStep 治理裁决。
**Status:** FROZEN (first draft for contract review).

## Governance decisions recorded (GQ1–GQ5; no DID catalog changes)

| GQ | Decision → contract placement |
|---|---|
| GQ1 | X1–X11 = **superseded / non-normative archival**; P9 never cites them — `02` §0 |
| GQ2 | **P9 owns generic recovery/rebuild semantics; P10 owns concrete business projections / at-scale rebuild** — `02` §10, `05` §3 |
| GQ3 | Recovery triggers = **startup full pass + periodic/event-triggered sweeps + targeted pre-dispatch fence check**; pre-dispatch never runs the nine steps — `01` §3, `03` §2 |
| GQ4 | **No new provider failure tag**; connect-phase failure → `ProviderUnavailable`, post-stream → `StreamInterrupted`; **P9 owns unsettled-ProviderTurn crash recovery**. DID v1.20 refines it: complete success evidence converges locally; only absence of such evidence permits same ProviderTurn/new ProviderAttempt, turnNo unchanged — `02` §6, `04` §2, `07` |
| GQ5 | **No fault-injecting SQLite adapter**; real process/daemon/worker crash injection; power-loss/WAL semantics proven via SQLite durability contract + DurabilityEnvelope + reopen/integrity evidence; **crash-injected vs durability-asserted guarantees explicitly distinguished** — `02` §0/§12, `05` §4 |
| — | ReconciliationSourceStub replacement is **P9 phase-scoped closure**, not a Design Gap — `01` §1 |

## Documents

| Doc | Owns |
|---|---|
| `01-recovery-visibility.md` | B-1 pre-fix (real ReconciliationSource wiring + durable escalation facts), B-2 completion-fact settle case, GQ3 trigger semantics |
| `02-fault-injection-matrix.md` | The core matrix: 10 injection faces × points × assertions × guarantee class; durability-evidence protocol |
| `03-worker-lease-hardening.md` | Lease renewal loop, trigger surface T1–T4, durable-timer re-fire, safety-gate note |
| `04-provider-tool-hardening.md` | Provider disconnect mapping + unsettled-turn recovery (GQ4), tool four-tier assertions, dispatch-failure semantics |
| `05-consumer-rebuild-hardening.md` | Consumer offset wiring + crash matrix, generic rebuild (GQ2 P9 face), P10 boundary |
| `06-acceptance.md` | Stories A–G and mechanical assertion list |
| `07-agent-loop-step-recovery.md` | DID v1.20 Provider success local convergence、AgentLoopStep recovery matrix、legacy adoption、AH1–AH14 |

## Scope (DID §11 P9, nine faces)

```text
worker crash / daemon crash / provider disconnect / tool outcome unknown /
lease expiration / old worker resurrection / dispatch failure /
consumer crash / projection rebuild (generic face, GQ2) /
settled Provider result handoff / AgentLoopStep crash windows / legacy adoption
```

P9 is hardening over existing semantics: P2 owns the mechanism, P1 owns the
command-transaction matrix, P5 owns the representative restart proof — P9
systematizes, closes the two visibility gaps, and injects.

## Explicitly out of P9

- Concrete business-projection rebuild at scale (P10, GQ2).
- Attention presentation (P10); recovery daemon/composition surface (P12).
- Environment/git (P11); new failure taxonomies; X1–X11. The original
  “no settle-rule changes” boundary remains except for the explicitly governed
  DID v1.20 AgentLoopStep successor in `07`; DID v1.21 ALS-I1 now authorizes
  its implementation.

## Implementation baseline highlights (from scope extraction)

Injectable now: TransactionPort fault hooks, fencing/lease CAS, P1 consumer
infra, generic rebuildProjection. Paper-only (P9 wires): recovery pass
driver, real ReconciliationSource binding, completion-fact settle, lease
renewal, timer re-fire, consumer offsets for P7/P8, provider-turn recovery.
Zero-based (P9 builds, task-level): process-level crash harness (layer
dispose / fiber interrupt / child process).

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | → DID v1.11/SD/P1–P8/GQ rulings | PASS after fixes (R1 GQ3 T3 wording conflated with T4 — "targeted" now reserved for pre-dispatch only; R2 GQ5 guarantee-class definition widened to cover transaction-port subclass; R3 citation version labels corrected to v1.11; R4 dangling "00 §C" refs re-pointed to the scope-extraction path) |
| Dependency / coverage | nine faces × docs; B-1..B-10 all owned | PASS (02 §1–§10 complete; 01/03/04/05 own the closure items; no orphans) |
| Executability | matrix rows mechanical; DA evidence protocol executable | PASS after fixes (R5 Story B split into clean/unclean fixtures — the unclean fixture asserted the very No.54 violation B-1 removes; R6 attention dedup key unified to executionId + invocationRefs fingerprint so repeated passes mint no new facts) |
| Risk / gaps | boundary leaks (P10/P12/taxonomy/X-series) | PASS (none found; tool-tier numbering renamed TT to free T1–T4 for the trigger surface) |

Review round 1 (independent): 6 Blocking (1 HIGH / 1 MED-HIGH / 2 MED / 2 LOW) — all fixed above.
**Blocking = 0.**

## Status

```text
FROZEN — P9 phase-scoped contracts; review Blocking = 0 (P9 FORMALLY CLOSED).
freezes; then planning/phases/P9.md, then implementation authorization.
```

The v1.20 `07` successor is FROZEN as design and implementation is AUTHORIZED
by DID v1.21 ALS-I1; it does not reopen the historical P9 completion record.
