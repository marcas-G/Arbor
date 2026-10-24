# S2-RDG-01 — Governance Acceptance and Owner Landing Record

Date: 2026-10-24
Status: **MANUALLY ACCEPTED; EXACT OWNER CONTRACT LANDING RECORDED; INDEPENDENT POST-LANDING REVIEW PENDING**
Implementation: **CONDITIONAL AUTHORIZATION GRANTED; NOT EXERCISABLE UNTIL INDEPENDENT POST-LANDING REVIEW IS BLOCKING = 0**

## Decision and fixed package identity

- Manual decision token: ACCEPT_S2_STEER_WORK_REVISION_CONTRACT_V1
- Acceptance date: 2026-10-24
- Conditional implementation authorization token: AUTHORIZE_S2_STEER_WORK_REVISION_IMPLEMENTATION_AFTER_LANDING_REVIEW
- Implementation authorization state: granted on 2026-10-24, conditional on independent owner-landing review with Blocking = 0; no implementation may begin before that condition is met.
- Fixed package source: planning/proposals/S2-steer-work-revision-contract-governance-draft.md
- Proposal SHA-256 (UTF-8/LF-normalized): C878BBF615F92ED43125C79EFDC0F021F062FEE97BF740795889B65B44394088
- Failure-evidence result SHA-256: 459EA1187E12E409FAF5605A140F4659A864AC4330B24F2686F2ED9AAD7BE1E2
- Package-manifest raw SHA-256: 97C20BA5C84469ACC36A07BA05363CCA6E2E7322432F94B6A45BD24EB6F9BCFB
- Independent fixed-package review: planning/results/S2-steer-work-revision-fixed-package.review.md; Blocking = 0; suitable to request ACCEPT. That review is not a post-landing review.
- Landing base: a2fe27a099854493a0bd71af5354040276801df6.

## Accepted semantic scope

1. DirectionGuidance and human-authored ContractAmendment are distinct typed operations; text and legacy scope="Constraint" never implicitly amend canonical criteria.
2. ContractAmendment is a complete replacement of objective, why, all constraints, completionExpectation, and structured verificationMission. No patch/merge, omitted-field inheritance, inference or server defaults.
3. Both operations require authenticated human authority on the exact Work/Workspace and expected current WorkRevision. Each accepted operation advances the Work revision exactly once; Normal/Critical share contract, authority, CAS, history, receipt and replay semantics.
4. Each Work revision has a durable immutable complete contract snapshot keyed by exact WorkId/WorkRevision, with provenance, source command, time and canonical digest. Migration may preserve only the provable current Work row as LegacyCurrentSnapshot/history unavailable; no history is inferred.
5. A new Verification uses the canonical mission for its exact current Work revision. An old Open Verification may continue and conclude against its immutable old mission/revision; its wake remains exact to the old Work/revision. Old PASS/FAIL/UNKNOWN never satisfies new-revision Acceptance/CompleteWork. No automatic cancel or relabel.
6. Critical Steer adds only the already-frozen P6/P2/P4 exact active-main Stop/quiescence path; Work remains Open. No new authority/capability is granted.

## Owner landing and revision map

| Owner document | Revision / sections landed |
|---|---|
| Scenarios | v1.6 → v1.7; S2.4.5–S2.4.8, S2.5 trace, accepted S2-RDG-01 governance addendum. |
| System Design | v1.21 → v1.22; §§3.4, 7.3, 9.4, 12.4, 15.2 and top-level governance record. |
| Detailed Implementation Design | v1.58 → v1.59; §§2.3, 3.3, 5.3, 9.3, 12.10, 12.11 and top-level governance record. |
| P1 command contracts | 01: preserves strict schema/version/receipt tuple semantics; legacy v1 is guidance only; exact schema version label and wire representation remain implementation-owned. |
| P1 transaction model | 03: one SteerWork command/TransactionScope; Work/history/events/Inbox/receipt and Critical Stop child outcome are atomic; no second Gateway/receipt. |
| P1 SQLite schema ownership | 04: records only the logical immutable per-revision snapshot and current-only legacy backfill requirement; no table/column/DDL/migration ID selected. |
| P1 event journal | 05: registers the separate versioned WorkAmended event identity; WorkSteered v1 remains DirectionGuidance; no payload fields or historical event bytes changed. |
| P6 Human Steer | 04: typed operations, complete replacement, exact authority/CAS/history, event distinction, Normal/Critical parity and reuse of existing Critical composite. |
| P6 acceptance contract | 06: adds S2-RDG-01 observable acceptance requirements for operation separation, revision history, exact verification binding and Critical parity. |
| P6 contract index | 00: updates the DID capability mapping to WorkSteered / WorkAmended. |
| P8 Verification commands | 01: new Verification mission comes from canonical exact Work revision; historical v2 snapshots remain immutable and inapplicable to newer revisions. |
| P8 chain consumers | 03: old conclusion releases only exact old Work/revision wake; no new wake condition or consumer behavior is added. |
| P10 human-intervention owner | 06: ContractAmendment uses the existing HumanInterventionApplied(Steer) fact; no new intervention kind or projection field. |
| P10 acceptance stories | 07: includes WorkAmended in the same-transaction human intervention and revision-freshness acceptance story. |

Exact landing file set:

- docs/design/01-scenarios.md
- docs/design/02-system-design.md
- docs/design/03-detailed-implementation-design.md
- docs/design/implementation/P1/01-command-contracts.md
- docs/design/implementation/P1/03-transaction-model.md
- docs/design/implementation/P1/04-sqlite-schema.md
- docs/design/implementation/P1/05-event-journal.md
- docs/design/implementation/P6/00-contract-index.md
- docs/design/implementation/P6/04-human-steer.md
- docs/design/implementation/P6/06-acceptance.md
- docs/design/implementation/P8/01-verification-commands.md
- docs/design/implementation/P8/03-chain-consumers.md
- docs/design/implementation/P10/06-humanintervention-fact.md
- docs/design/implementation/P10/07-acceptance.md
- planning/results/S2-steer-work-revision-acceptance-and-landing.record.md

Problem & Goals v1.3 is unchanged. P10/P13/P14 route, DTO, Effect-signature and UI details remain deferred to their owners and require an implementation contract after separate implementation authorization. No physical schema, new API field, exact command schema number, event payload shape, route, or migration was invented in this landing.

## Authorization boundary and audit

The ACCEPT token authorizes only the exact owner-document landing package. The separate implementation token above conditionally authorizes the S2-RDG-01 source implementation only after independent post-landing review is Blocking = 0. Until then no code, tests, migration implementation, or other implementation actions may begin. The conditional implementation authorization excludes real-Provider qualification, migration activation, deployment, and any read/write of existing or preserved databases; any later real-provider or migration-activation action requires its own explicit authorization and disposable-data scope. No tests or provider/daemon journeys were run for this design landing.

Independent post-landing consistency review is pending; the conditional implementation authorization is not yet exercisable. S2-RDG-01 must not be reported as fully review-closed until that review records its disposition.
