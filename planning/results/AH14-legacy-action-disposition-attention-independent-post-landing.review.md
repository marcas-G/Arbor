# AH14 legacy action-disposition Attention — independent post-landing review

Review date: 2026-10-17
Reviewed commit: `efcf04b05a99d708734d7aa7404c499a57d5f02f`
Parent baseline: `ccb34630b3d392695b6b43bdf843d2ca89541fbb`
Result: **PASS — Blocking = 0, B1 = 0, B2 = 0; accepted design package formally landed.**

## Provenance

- Acceptance token: `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`.
- Accepted proposal: `planning/proposals/AH14-legacy-action-disposition-attention-fixed-package.md`.
- Raw SHA-256 independently recomputed from the proposal blob in the reviewed commit: `71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`.
- DID landing: v1.49, superseding v1.48.
- Acceptance and landing record: `planning/results/AH14-legacy-action-disposition-attention-acceptance-and-landing.record.md`.

## Owner and invariant review

- P9 `07` limits escalation to a uniquely bound legacy successful Provider result whose decoded action disposition is unproven, using `LegacyActionDispositionUnproven`. It blocks adoption, action/output replay and canonical Step/action/Session/settlement mutation. Positive adoption and unrelated identity failures retain their existing paths.
- The failure tuple, canonical encoding, explicit Missing markers, deterministic `att_` identity, immutable first-detected time, exact event envelope and atomic current-lease-fenced fact/event write match the accepted package.
- Resolution binds the complete non-empty original action set one-for-one to stable action identities and same-action P4 evidence. Applied requires exact terminal settlement, result and Observation; NotAdmitted requires the closed terminal Denied evidence. The non-empty disposition mapping, summary/evidence digests, deterministic `alr_` ID and one-resolution rule agree with the accepted contract. Resolution commits with normal Step progression and does not alter the original failure fact.
- P10 defines exactly `LegacyAdoptionEvidenceInsufficient` at `ActionRequired`, targeting the exact `executions.workspace_id` captured in the failure fact. The public DTO uses the accepted fixed summary and `attentionFactId` deduplication without exposing Provider/action payloads. Failure and resolution envelopes are validated field-by-field against immutable P9 facts before atomic marker/offset changes.
- P10 rebuild recreates only unresolved markers from permanent P9 failure/resolution facts, including after source-event pruning. P9 facts remain retained; only the matching P10 marker is removed by evidence-proven resolution. There is no manual dismissal or timeout path.
- P1 `03`/`04` agree on transaction atomicity, fact/marker ownership and retention. P4 `06` remains reference-only; no P4 document or semantics changed. DID v1.49 and all named owner documents carry matching token/hash and cross-references. The commit changes only the seven named P1/P9/P10 owners, DID, and acceptance/review records; no upstream Problem, Scenario or System Design document is changed.

## Authorization and boundary

The landing is design-only. Migration ID remains unassigned and unreserved; exact DDL, initialization, migration qualification, production code, tests, preserved-database access, deployment and publication require separate authorization. No implementation authorization is implied by this review.

The reviewed commit has parent `ccb34630b3d392695b6b43bdf843d2ca89541fbb`; `git diff --check` is clean. No tests were run because this is a design-only landing.
