# P10 — 00 Contract Index

**Authority:** DID v1.13 §11 P10 (G1–G8), §5.4, §6.1/§6.2 (L6), §10.4/§10.4.1 (projection-runtime; api-contracts), §7.2 (ProjectionQueryPort); SD v1.3 §7.4/§7.5, §10.1 D, §12 全章, §13.9/§13.10, §14 No.37/38/40/45/56; S1/S2/S4; P1 `05`/`06`, P2 `01`/`06`, P3 `04`, P4 `07`, P6 `00`/`04`/`05`, P7 `00`/`05`, P8 `00`/`05`, P9 `00`/`05`; `planning/gaps/P7-GAP-01.md`; GQ1–GQ7 裁决（2026-09-22，本轮会话）.
**Status:** FROZEN (first draft for contract review).

## Governance decisions (DID v1.13)

| GQ | Decision (v1.13 clause) | Contract placement |
|---|---|---|
| GQ1 | SD view inventory is authoritative (Search/Summary/Overview/Inbox all P10); WorkspaceStatus labels frozen from SD text | `01`, `02` |
| GQ2 | EffectiveFacts = the single shared canonical-state-derived projection (P10 owns def/materialization/freshness/query; P3 consumes) | `03`, `04` |
| GQ3 | P10 owns Attention read-model (source→severity→target→bubbling→dedup); upstream produces facts only; never auto canonical mutation | `04` |
| GQ4 | External Stop authority resolver = P12 (inherited clarification of P2 `01`); P10 exposes control surface only | `05` |
| GQ5 | Freshness = monotonic watermark + observable lag + explicit FreshnessRequirement barrier; no implicit RYW | `03` |
| GQ6 | P10 = programmatic projection/query + UI-facing view semantics; P12 = transport shells (no reinterpretation) | `05` |
| GQ7 | HumanInterventionApplied durable audit fact {actor, targetWorkspaceId, summaryRef, occurredAt, kind}, emitted in the same semantic transaction by human-originated canonical commands; P6 WorkSteered path back-filled as inherited evolution | `06` |
| GAP-01 | WaitingOnVacantProducer canonical-state-derived Attention view; zero runtime mutation | `02` |

## Documents

| Doc | Owns |
|---|---|
| `01-view-inventory.md` | Authoritative view list (SD full inventory), per-view derive inputs & query shapes, WorkspaceStatus exhaustive label map |
| `02-attention-readmodel.md` | Attention source→severity→target→bubbling→dedup→read-model contract; six fact sources; GAP-01 view |
| `03-effectivefacts-freshness.md` | EffectiveFacts shared projection (def/materialization/query); freshness watermark/lag/barrier contract |
| `04-rebuild-atscale.md` | Business-projection at-scale rebuild (GQ2 handover from P9): checkpoints, projection-side retention (P1 `04` horizon untouched), orchestration, query correctness |
| `05-surface-actions-transport.md` | ProjectionQueryPort/api-contracts DTOs; Query(P14 consume)/Steer/Stop/Governance-Change surfaces; P12 transport boundary |
| `06-humanintervention-fact.md` | HumanInterventionApplied payload, emission points, WorkSteered back-fill (inherited evolution) |
| `07-acceptance.md` | Stories + mechanical assertions |

## Implementation baseline (from scope extraction)

Generic projection/offset/rebuild infra (P1, P9-hardened) ready; all canonical data sources present; only InboxProjectionStore exists as a business projection; all views zero-presentation; HumanInterventionApplied/WorkSteered events are unequipped shells (fixed by `06`); session_entries has no production read path; usage aggregation zero.

## Boundaries (out of P10)

- Transport shells (HTTP/WS/CLI/web/auth/deployment) — P12 (GQ6); P12 must not reinterpret view semantics.
- External Stop authority resolver — P12 (GQ4; P2 runtime semantics unchanged).
- Journal retention horizon — P1 `04` (projection-side retention only, `04` here).
- Canonical mutations from Attention — never (GQ3).
- Memory/Decisions store (SD §12.4 ⑥) — later phase; Workspace Detail shows audit timeline from domain_events instead.

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | → DID v1.13/SD/P1–P9/GQ rulings | PASS after fixes (R1 Stop emission marked resolver-preconditioned/dormant-until-P12, wire-only in acceptance; R2 Query surface made message-mediated, external AdmitExecution resolver-gated like Stop; R3 human-principal wording re-anchored to AuthenticatedHuman provenance; R4 deadlock severity branch noted as non-existent by frozen gate; R5 maxLag marked as contract-level extension of the GQ5 barrier) |
| Dependency / coverage | view inventory × docs; B-list | PASS after fixes (R6 per-view request/response cores frozen in `05` §1; R7 Inbox rebuild/retention face = state reconciliation, Story E; R8 GovernanceDecision emission set = all four human-originated mutating governance commands; R9 retired terminal status; R10 index routing corrected) |
| Executability | stories mechanical | PASS after fixes (Story F now asserts steer/governance-decision emissions + the dormant-branch declaration instead of an impossible human-stop mutation; Story G asserts the message-mediated query path) |
| Risk / gaps | boundary leaks | PASS (zero crossings: no P12 transport/resolver, P14 consume-only, journal horizon untouched, no implicit RYW) |

Review round 1 (independent): 3 Blocking (High) + 8 material findings — all fixed above.
**Blocking = 0.**

**Status:** DRAFT — for contract review.
