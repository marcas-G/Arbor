# P10 — 00 Contract Index

**RAI-DG-01 amendment (DID v1.37 §8.18A.1):** P10 `02`/`04`/`07` own
same-snapshot canonical Work-revision filtering for the four Work-bound
Attention sources, active-query/rebuild behavior and its typed projection
integrity failure. Projection state and queue ACK are never readmission
authority.

**Accepted Blocked WorkEpisode amendment:** P10 `01`/`02`/`04`/`05`/`07` own
the read-only `WorkEpisodeBlocked` source, current `WorkBlocker`-ledger
projection/rebuild, active-vs-attention severity, Work Detail DTO, and
qualification. P10 cannot clear blockers, invoke recovery or change canonical
Work/Inbox state.

**Authority:** DID v1.13 §11 P10 (G1–G8), §5.4, §6.1/§6.2 (L6), §10.4/§10.4.1 (projection-runtime; api-contracts), §7.2 (ProjectionQueryPort); SD v1.3 §7.4/§7.5, §10.1 D, §12 全章, §13.9/§13.10, §14 No.37/38/40/45/56; S1/S2/S4; P1 `05`/`06`, P2 `01`/`06`, P3 `04`, P4 `07`, P6 `00`/`04`/`05`, P7 `00`/`05`, P8 `00`/`05`, P9 `00`/`05`; `planning/gaps/P7-GAP-01.md`; GQ1–GQ7 裁决（2026-09-22，本轮会话）.
**Status:** FROZEN — DID v1.17 D-1 additive read-model successor adopted (TR-WPU-B/C/D; no P10 phase reopen).

## AH10 Deliver P10 storage addendum (DID v1.38)

Accepted addendum SHA-256:
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
Deliver replay Attention uses the source-specific marker/FK and P9-fact query
union in `02`, with atomic fact-snapshot/marker-seed/P1-offset rebuild in `04`
and qualification in `07`. Existing AssignWork projection storage and rows,
F21 rebuild-refusal semantics, and accepted AH7/P36 rules are unchanged.
Proposed migration 0037 requires P36 integration; it is not independently
implementable/releasable.

## Accepted owner amendment — EA-DG-01 (DID v1.39)

Fixed proposal SHA-256:
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
acceptance record `planning/results/EA-DG-01-governance-acceptance.md`.
P10 `01`/`05` add the read-only Inbox Executable approval target projection
from P6 `eap:` admission and the proven P4 ActionApproval row. It returns the
exact review fields with bounded schema-redacted argument preview, filters by
Workspace and fails closed if exact human review data cannot be constructed.
P10 never decides/consumes approval or writes the Inbox. Control `cap:` and
CAPA remain unchanged. Qualification requirements are in
`planning/results/EA-DG-01-contract-landing.result.md`.

## Accepted owner amendment — AH7-DG-02 Attention projection (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted P39 physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P10 `02` owns the projection of the existing P9
`ReconciliationEscalated{executionId,invocationRefsFingerprint,refs}` event as
`ActionRequired`, targeted to `executions.workspace_id`, deduplicated by
`reconciliation-escalated:<executionId>:<invocationRefsFingerprint>`, with
the accepted fixed path-free summary. `04` owns atomic marker/offset rebuild
within P1's retained event horizon; `05` only reflects the existing source in
the frozen DTO when necessary. P10 does not create or mutate P9 facts, infer
external reality, or promise indefinite Attention after journal pruning.
P39 implementation and source migration remain separately gated.

## Accepted AH7-DG-01 / P39-P40 replay-evidence Attention source (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
RNO compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.
P10 `02` owns the `ToolObservationReplayEvidenceFailure` source mapping and
source-specific marker relation; `04` owns its shared Attention offset,
retention-horizon reset/rebuild; `05` owns the closed AttentionSource/API query
union; `07` owns the future crash/rebuild acceptance matrix. P9 emits only
missing/corrupt-evidence facts; P10 never projects ordinary valid RNO outcomes
or mutates P39/P4/P3 canonical state. Failure code is internal-only; the fixed
path-free summary is the only public detail.

## Accepted AH10 Submitted DecisionEpisode binding Attention (DID v1.42)

Fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.
P10 `02`/`05` add the `SubmittedDecisionBindingFailure` source without DTO
field or route changes; `04` owns the source marker reset, P9 fact snapshot and
P1 offset rewind in one transaction (including reconstruction after event
pruning); `07` Story P owns retention, duplicate-delivery, crash and concurrent
fact/rebuild qualification. P9 fact/event remains immutable; P10 does not
clear it. Migration 0041 is conditional on integrated/qualified 0036–0040 and
is not authorized for implementation by this design landing.

## FT-DG-02 additive contract amendment (2026-10-08)

The accepted `work-detail` read-only View is added to P10's authoritative
inventory and query contract. Absent and cross-project/workspace target
identities share `projection/work-not-found` / `not-found` without revealing
existence. This does not reopen P10 or authorize implementation. Audit:
accepted proposal SHA-256
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`, landing
package SHA-256
`266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`;
decision record `planning/results/FT-DG-02-governance-acceptance-and-landing.review.md`.

## DID v1.17 successor record — D-1 Product UI Contract Closure

TR-WPU-B/C/D evolve only the public read-model surface in `05`: Tree nodes carry the canonical
`parentWorkspaceId`; all current-work summaries carry canonical `Work.revision`; a selected
Verification carries its frozen `targetWorkRevision` paired with `verificationId`. The projection
rejects malformed hierarchy inputs before deterministic preorder traversal and omits absent Tree
`currentWork` rather than producing a null/dummy wire value. No view request, ViewId, command,
event, DDL, authority, transport, canonical semantic, or P10 phase ownership changes. Existing
ordered/list consumers remain compatible by ignoring additive fields.

## Governance decisions (DID v1.13)

| GQ | Decision (v1.13 clause) | Contract placement |
|---|---|---|
| GQ1 | SD view inventory is authoritative (Search/Summary/Overview/Inbox all P10); WorkspaceStatus labels frozen from SD text | `01`, `02` |
| GQ2 | EffectiveFacts = the single shared canonical-state-derived projection (P10 owns def/materialization/freshness/query; P3 consumes) | `03`, `04` |
| GQ3 | P10 owns Attention read-model (source→severity→target→bubbling→dedup); upstream produces facts only; never auto canonical mutation | `02`, `04` |
| GQ4 | External Stop authority resolver = P12 (inherited clarification of P2 `01`); P10 exposes control surface only | `05` |
| GQ5 | Freshness = monotonic watermark + observable lag + explicit FreshnessRequirement barrier; no implicit RYW | `03` |
| GQ6 | P10 = programmatic projection/query + UI-facing view semantics; P12 = transport shells (no reinterpretation) | `05` |
| GQ7 | HumanInterventionApplied durable audit fact {actor, targetWorkspaceId, summaryRef, occurredAt, kind}, emitted in the same semantic transaction by human-originated canonical commands; P6 WorkSteered path back-filled as inherited evolution | `06` |
| GAP-01 | WaitingOnVacantProducer canonical-state-derived Attention view; zero runtime mutation | `02` |

**P12 TR propagation (documentation reconciliation; no P10 semantics change):** TR-5 — `UsageReq.cost` is the P12 `UsageCost` ADT (unknown ≠ 0) (`05` §1; `P12 04` §3.2); TR-8 — external Stop/Admit authority is produced by the P12 Authority Resolver (`05` §2; `P12 02` §4).

## Documents

| Doc | Owns |
|---|---|
| `01-view-inventory.md` | Authoritative view list (SD full inventory), per-view derive inputs & query shapes, WorkspaceStatus exhaustive label map |
| `02-attention-readmodel.md` | Attention source→severity→target→bubbling→dedup→read-model contract; accepted Deliver-specific marker/FK/query union, FT-DG-01 OPEN-3, and GAP-01 view |
| `03-effectivefacts-freshness.md` | EffectiveFacts shared projection (def/materialization/query); freshness watermark/lag/barrier contract |
| `04-rebuild-atscale.md` | Business-projection at-scale rebuild (GQ2 handover from P9): checkpoints, projection-side retention (P1 `04` horizon untouched), orchestration, Deliver fact-snapshot/marker/offset atomicity and query correctness |
| `05-surface-actions-transport.md` | ProjectionQueryPort/api-contracts DTOs; Query(P14 consume)/Steer/Stop/Governance-Change surfaces; P12 transport boundary |
| `06-humanintervention-fact.md` | HumanInterventionApplied payload, emission points, WorkSteered back-fill (inherited evolution) |
| `07-acceptance.md` | Stories + mechanical assertions, including DeliverReplayFailure source-specific projection, migration ordering, rebuild and restart |

## Implementation baseline (from scope extraction)

Generic projection/offset/rebuild infra (P1, P9-hardened) ready; all canonical data sources present; only InboxProjectionStore exists as a business projection; all views zero-presentation; HumanInterventionApplied/WorkSteered events are unequipped shells (fixed by `06`); session_entries has no production read path; usage aggregation zero.

## Boundaries (out of P10)

- Transport shells (HTTP/WS/CLI/web/auth/deployment) — P12 (GQ6); P12 must not reinterpret view semantics.
- External Stop authority resolver — P12 (GQ4; P2 runtime semantics unchanged).
- Journal retention horizon — P1 `04` (projection-side retention only, `04` here).
- Canonical mutations from Attention — never (GQ3).
- Memory/Decisions store (SD §12.4 ⑥) — later phase; Workspace Detail shows audit timeline from domain_events instead.

## Accepted AH10 DeliverReplay outbox amendment (DID v1.43)

The fixed v5+v6 hashes, B0 review and delegated decision are in
`planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.
P10 `02` owns fact-marker/outbox projection and typed failure behavior; `04`
owns rebuild seed plus queue ACK; `07` owns added deterministic acceptance
cases. P1 `05` owns the raw-event predecode and atomic poll contract; P9 `07`
owns the durable fact/outbox. P37 remains ordered after P36/0036 and no
migration/runtime implementation is authorized by this design amendment.

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | → DID v1.13/SD/P1–P9/GQ rulings | PASS after fixes (R1 Stop emission marked resolver-preconditioned/dormant-until-P12, wire-only in acceptance; R2 Query surface made message-mediated, external AdmitExecution resolver-gated like Stop; R3 human-principal wording re-anchored to AuthenticatedHuman provenance; R4 deadlock severity branch noted as non-existent by frozen gate; R5 maxLag marked as contract-level extension of the GQ5 barrier) |
| Dependency / coverage | view inventory × docs; B-list | PASS after fixes (R6 per-view request/response cores frozen in `05` §1; R7 Inbox rebuild/retention face = state reconciliation, Story E; R8 GovernanceDecision emission set = all four human-originated mutating governance commands; R9 retired terminal status; R10 index routing corrected) |
| Executability | stories mechanical | PASS after fixes (Story F now asserts steer/governance-decision emissions + the dormant-branch declaration instead of an impossible human-stop mutation; Story G asserts the message-mediated query path) |
| Risk / gaps | boundary leaks | PASS (zero crossings: no P12 transport/resolver, P14 consume-only, journal horizon untouched, no implicit RYW) |

Review round 1 (independent): 3 Blocking (High) + 8 material findings — all fixed above.
**Blocking = 0.**

**Status:** FROZEN — P10 phase-scoped contracts; review Blocking = 0 (P10 FORMALLY CLOSED).

## Accepted Native OS Sandbox read-model amendment

P10 `02`/`05`/`07` project the P9 durable `SandboxProviderUnavailableFactV1`
into the existing Attention and Workspace Detail surfaces. No new endpoint,
ViewId, query parameter or Attention DTO field is introduced. Rebuild reads
the durable P9 fact directly; the event is only a wakeup.

## Accepted V5 queue/rebuild owner amendment

P10 `02` owns the durable `sandbox_provider_unavailable_attention_queue`
claim/consume state machine and P9-fact-keyed Attention marker;
`04-rebuild-atscale.md` owns the atomic source-snapshot, queue re-arm, marker
reset and offset rewind; `07` owns V5 qualification. The queue survives
Consumed and event pruning; the P9 fact remains the source of truth.

## Accepted V21 derived RecoveryBinding Attention

P10 `02`/`05`/`07` derive the non-persisted
`SandboxRecoveryBindingFailure` source per authorized query from immutable P4
invocation/binding rows. P9 creates no replay fact/event/marker for this
condition. The fixed safe summary, stable canonical identity, immutable
`intent_at` timestamp and fail-closed corruption behavior are specified in
those owners. This does not alter the V5 provider-unavailable fact queue,
marker, or rebuild contract.
