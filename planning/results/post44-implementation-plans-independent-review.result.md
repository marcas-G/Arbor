# Post-44 Implementation Plans — Independent Review

Date: 2026-10-17

Review baseline: `fdcec2e5ee8a9092dd114c71c46424f39ac7ac3e`

## Reviewed packages

| Scope | Plan | Plan SHA-256 | Accepted design basis | Requested implementation token |
|---|---|---|---|---|
| F23 P8/P6 replay origin and UnboundLegacy route | `planning/proposals/F23-permanent-replay-origin-implementation-plan.md` | `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB` | DID v1.46 / v1.47; accepted proposal hashes `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA` / `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF` | `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION` |
| VCS stable evidence time and criteria snapshot | `planning/proposals/VCS-stable-evidence-time-and-criteria-snapshot-implementation-plan.md` | `BC6BF6C6CD34FFFA1B4DAD707E8EBC388A002E7C9CF19D1E07969CAD5FFB291F` | DID v1.48; accepted proposal hash `B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56` | `AUTHORIZE_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT_IMPLEMENTATION` |
| AH14 legacy-adoption evidence Attention | `planning/proposals/AH14-legacy-adoption-attention-implementation-plan.md` | `C059F667341A6D5E10003B3D9769390F0F9EAFB3F383CBD739177EA833312D69` | DID v1.49; accepted proposal hash `71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1` | `AUTHORIZE_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_IMPLEMENTATION` |

The three plan hashes were independently recomputed from the plan files and match their respective plan records.

## Review disposition

**Blocking = 0; B1 = 0; B2 = 0.** No open semantic issue or authorization-scope conflict was found against the accepted design contracts.

The plans sequence the migrations against the reviewed schema-44 baseline: 0045 requires 44, 0046 requires 45, and 0047 requires 46. They keep prior migrations unchanged and gate each runtime/schema target increase on its separately named implementation authorization. F23's `revision=1` / `updated_at=admitted_at` initialization is consistent with the Inbox's existing logical creation time and the accepted rule that real route moves increment revision and update the timestamp atomically.

The F23 plan covers exact receipt/event/successor evidence for origin backfill, fail-closed UnboundLegacy disposition and route derivation, same-transaction route movement, and the ordinary Gateway rejection path if the move cannot commit. VCS covers strict Open-row preflight before DDL, no inferred historical criteria, stable first-intent time, versioned snapshots, and unchanged G5 outer-v1 replay. AH14 preserves the narrow ambiguous-action failure class, immutable P9 facts, field-validated P10 projection/rebuild, and evidence-only complete-action-set resolution. The listed crash/replay and public-boundary cases track the accepted P9/P10/P1 contracts.

Each named implementation token is requestable as a separate authorization. Implementation must remain sequential: VCS depends on completed 0045 work, and AH14 depends on completed 0045 and 0046 work.

All three plans limit migration qualification to fresh databases or explicitly disposable copies and offline CLI upgrade paths. They exclude preserved/dogfood database access, live/online upgrades, deployment, release, and release-readiness claims. Their stated design-document, historical-data, and semantic exclusions match the accepted packages.

## Review boundary

This was a read-only document/hash review. No code, migration, database, test, or design document was modified or executed. This record does not grant any implementation token or claim implementation qualification.
