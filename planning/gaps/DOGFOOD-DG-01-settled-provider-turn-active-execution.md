# DOGFOOD-DG-01 — Settled ProviderTurn with active Execution

## Status

**RESOLVED — DID v1.20 AHT-1…AHT-8 + owning phase contracts.** Implementation,
migration and evidence remain separately gated. Do not implement replay or
mutate the preserved database without explicit implementation authorization and
the frozen acceptance evidence.

## Owning design

- `docs/design/implementation/P9/04-provider-tool-hardening.md` §2.2 defines
  recovery of an **unsettled** ProviderTurn (same Turn, new Attempt).
- `docs/design/implementation/P9/02-fault-injection-matrix.md` §2–§3 defines
  lease fencing and expiry, including rejection of a stale session append.
- DID §6A.9 distinguishes a transport retry from a new model decision.

## Observed failure

During a research-only dogfood execution, the provider emitted a successful
terminal `TurnCompleted(MaxOutputTokens)` and the ProviderTurn/Attempt were
durably settled. The worker's lease had expired before the Agent Driver could
append its output to the Session; the session append was rejected by fencing.
The Execution stayed Active and the claimed Human message had no answer. The
daemon exited and the workbench displayed the message as processing while
offline.

Evidence in the preserved ignored local `arbor-quant-v2.db`:

```text
Execution: exe_82f7a57b-f264-78e4-86ad-e86283c0a841
lease expires_at: 2026-09-29T16:01:50.958Z; no renewal persisted
ProviderTurn settled_at: 2026-09-29T16:02:08.641Z
ProviderTurn finish_reason: MaxOutputTokens
ProviderAttempt outcome: Success
Execution settled_at: NULL
HumanMessage state: Claimed; settled_at: NULL
```

`packages/provider-runtime/src/runtime.ts` looks up only an **unsettled** Turn
before attempting `startTurnWithManifest`. On redispatch, this successful
settled Turn is not a recovery candidate, while the execution/driver would
derive the same `providerTurnId`. The existing unsettled-Turn recovery rule
therefore does not specify the result of this state. A duplicate-turn insert
or an ungoverned second provider request must not silently decide it.

## Question for governance

What is the authoritative recovery disposition when a ProviderTurn is
successfully settled but its owning Execution has not accepted the output into
Session history? The ruling must define whether and how the persisted
canonical output can be replayed, the required manifest/fence validation,
idempotency of the session write, and the claimed Human message disposition
if replay is impossible. It must also cover failure after a successful
Session append but before `SettleExecution`.

The dense-stream scheduling defect that allowed lease renewal to starve has
a separate regression fix. It does not resolve this already-persisted state
or define its crash recovery semantics.

Governance proposal: `planning/proposals/provider-result-handoff-decision-draft.md`.
It recommends a durable AgentLoopStep handoff state machine, replayable settled
Provider results, and idempotent Session/action progression across every
crash boundary.

Independent review: `planning/proposals/provider-result-handoff-decision-draft.review.md`.
R1–R5 are accepted and dispositioned in the proposal's
`审阅意见处置（2026-09-30）` section. The gap remains OPEN because review and
proposal revision are not manual governance approval.

Round-two review:
`planning/proposals/provider-result-handoff-decision-draft.review-round2.md`.
R6–R8 are accepted and dispositioned in the proposal's second-round table;
unresolved side effects, deterministic successor recovery, and branch-specific
acceptance are now explicit. This still does not constitute governance approval.

Round-three review:
`planning/proposals/provider-result-handoff-decision-draft.review-round3.md`.
It verified proposal SHA-256
`BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F`, found no
new P1/P2 issue, and recommends manual governance. The immutable reviewed
version is submitted through
`planning/proposals/provider-result-handoff-governance-submission.md`.
At that checkpoint the status remained OPEN pending an ACCEPT/REVISE/REJECT
decision; the later decision and resolution are recorded below.

Governance-submission review:
`planning/proposals/provider-result-handoff-governance-submission.review.md`.
It verified submission SHA-256
`908610EE54ED33B3AA5448264E8C18A32EFB333B372D18934D97EC1993EB3A08`, found no
blocking issue, and confirmed the material is ready for a human decision. The
review explicitly is not ACCEPT and grants no design or implementation
authority.

Manual governance decision:
`planning/proposals/provider-result-handoff-governance-decision.md` records the
explicit `ACCEPT` against the immutable reviewed hashes. The ruling is landed
as DID v1.20 AHT-1…AHT-8 plus P1 `07`, P2 `02`/`04`/`06`, P3 `08`, P9 `07`,
P12 `08`, and P14 `02`/`05`.

The design question is therefore **RESOLVED**. The separate
implementation/evidence gate remains open until migration
`0017_agent_loop_step_handoff`, AH1–AH14, branch-specific assertions, and the
original-failure equivalent fixture prove exactly one authoritative reply with
zero repeat request for the already-successful ProviderTurn. The preserved
database remains read-only until that separately authorized work completes.
