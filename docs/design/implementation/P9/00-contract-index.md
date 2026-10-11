# P9 — 00 Contract Index

**Authority:** DID v1.20（含原 DID v1.11 P9 closure 与 AHT-1…AHT-8）；SD v1.3 §6.5/§7.3/§10/§14；P1 `06`/`07`, P2 `03`/`06`, P3 `06`/`08`, P4 `01`/`02`/`03`/`06`, P5 `04`/`05`, P8 `00`/`02`/`03`；GQ1–GQ5 与 2026-09-30 AgentLoopStep 治理裁决。
**Status:** FROZEN — P9 formally closed; accepted AH7-DG-03 owner amendment
(2026-10-10). Post-landing consistency review pending.

## Accepted owner amendment — AH7-DG-03 (2026-10-10)

Decision: `ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`. Accepted proposal SHA-256:
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`;
source and delegated decision record are
`planning/proposals/AH7-approval-settlement-fixed-decision-draft.md` and
`planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md`.

P9 `02` and `07` add AH7-DG-03 crash/restart qualification for atomic
intent+approval claim, P4 no-effect Denied/Interrupted records, effect
admission, lease fencing and Stop/quiescence. They inherit P4/P2/P3 semantics;
this addition does not change P9's guarantee classes, fault-injection method,
or recovery ownership.

## AH10 Deliver P10 storage addendum (DID v1.38)

Accepted addendum SHA-256:
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
P9 `07` remains the owner of the immutable Deliver failure fact/event and
exposes its project-scoped fact list for P10 rebuild. The fact's identity,
failure-code set, event payload, transaction and retry semantics are unchanged.
The source relation is in proposed migration 0037 after accepted AH7/P36
migration 0036. P36/P37/P38 owner contracts are integrated in the current
governance baseline, but migration 0036–0038 implementations/registration are
not. Migration 0037 cannot be implemented or released independently of P36.

## Accepted owner amendment — EA-DG-01 (DID v1.39)

Fixed proposal SHA-256:
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
acceptance record `planning/results/EA-DG-01-governance-acceptance.md`.
P9 `02`/`07` add process-crash boundaries for exact Executable approval
issuance, human decision, expiry/Stop cancellation, durable wake replay and
same-Step/action resume while retaining AH7 AP1–AP8 claim/effect contracts.
Implementation/process qualification remains separately gated. Ordered
migrations 0036→0037→0038 remain prerequisites; P9 does not rewrite any slot.

## Accepted owner amendment — AH7-DG-02 Reconcilable reality proof / P39 (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P9 `01`/`04`/`07` define escalation only for unresolved `StillUnknown` or
unprofiled legacy evidence, the existing `ReconciliationEscalated` event/ref
fingerprint path, replay/recovery ordering, and bounded crash/finality/Stop
qualification. P4 alone proves reality and owns append-only facts/terminal
settlement; P9 does not treat an absent ref or unknown result as proof and does
not admit an Executor replay. P39 `0039` follows owner contracts P36→P37→P38;
the source migrations are not implemented/registered by this design landing.
Attention visibility remains bounded by the accepted event-retention horizon.

## Accepted AH7-DG-01 / P39-P40 replay-evidence Attention source (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
P39/P40 RNO compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.
P9 `07` owns the current-fence RecoveryBlocked transition and immutable
`ToolObservationReplayEvidenceEscalated` fact/event keyed by
`(executionId, invocationId)`. This source reports failure to replay a terminal
Observation, not uncertain external reality; it is distinct from and does not
write `ReconciliationEscalated`. P10 owns its dedicated marker/source query and
shared-offset/rebuild mapping. Tool output/cause/paths/errors never enter the
fact/event or public summary.

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
| `07-agent-loop-step-recovery.md` | DID v1.20 Provider success local convergence、AgentLoopStep recovery matrix、legacy adoption、AH1–AH14; accepted AH10 DeliverMessage receipt priority, immutable DeliverReplayEscalated fact/event, and source-fact list for P10 rebuild |

## Scope (DID §11 P9, nine faces)

```text
worker crash / daemon crash / provider disconnect / tool outcome unknown /
lease expiration / old worker resurrection / dispatch failure /
consumer crash / projection rebuild (generic face, GQ2) /
settled Provider result handoff / AgentLoopStep crash windows / legacy adoption
```

Accepted cross-phase AH10 extension: `07` also owns DeliverMessage receipt
priority, the pre-Gateway exact-proof adoption path, and its immutable
`DeliverReplayEscalated` fact/event. This adds no tenth generic P9 fault face;
the existing P1 fence/receipt and P7 message transaction remain the owners of
their mechanisms.

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

The DID v1.22 SCRC successor adds recovery contracts for Inbox promotion,
callRef-paired ToolResult, checkpoint/epoch atomicity, bounded overflow recovery
and native-binding fallback in `04`/`07`. It is design-frozen but implementation
is not authorized and does not reopen historical P9 completion.
