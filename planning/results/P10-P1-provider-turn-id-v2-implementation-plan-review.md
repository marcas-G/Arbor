# ProviderTurnId V2 Codec — Implementation Plan Review

Reviewed plan:
`planning/tasks/P10-P1-provider-turn-id-v2-implementation-plan.md`.

Canonical LF UTF-8 SHA-256 independently recomputed:

```text
ADD4F83D1B2F48CAFCB0A98DFB50D48F9099E1332736B62F38E3F8129A821EA2
```

Plan commit: `59e7085bbf7b0f096542195c95fb518bb3bf8592`.

Independent review: **Blocking = 0 — suitable for a separate
implementation-authorization decision.**

The reviewer confirmed the plan matches the accepted token
`ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1`, proposal SHA
`5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E`, owner
landing `b10f8eba`, and post-landing review `49779b37` (B0/B1/B2=0). The plan
covers the complete accepted V2 grammar, UUIDv7 read/replay-only behavior,
exact persistence/receipt/Manifest/P20/stream replay, strict unknown-format
rejection, the public P4/P1 pre-intent path, restart/crash matrices, and
unchanged P1 fingerprint/schema and P9 terminal behavior. The added
`contextEpoch` boundary matrix accepts 0 and `Number.MAX_SAFE_INTEGER` and
rejects negative, leading-zero, and out-of-safe-range values.

## Authorization scope disposition

The existing token
`AUTHORIZE_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_IMPLEMENTATION` was bound
to the earlier fixed plan SHA
`0E9DF0186E16AF14FDADDC4C56E1D21B737CD933CBB907A4A2EF48D8FB30B8A3`, whose
scope covers the pre-intent CandidateRead/P1/P4 bootstrap. This V2 plan adds
cross-layer Domain codec and constructor work, P20 persistence/replay,
BlockedActionRef receipt and external-command decoders, public progress
preservation, and P9 legacy recovery. The independent reviewer recommends a
separate implementation token for this material scope expansion, such as
`AUTHORIZE_P10_P1_PROVIDER_TURN_ID_V2_CODEC_IMPLEMENTATION`. This is a scope
recommendation, not an authorization decision; the coordinating root retains
that decision.

No production implementation, test run, migration, database operation,
provider qualification, release or deployment is authorized by this plan
review.
