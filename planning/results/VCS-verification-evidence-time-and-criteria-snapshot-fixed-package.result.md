# VCS verification evidence fixed package — preparation result

Status: **Fixed governance proposal prepared; pending manual decision.**

- Baseline: `367fd9a3`.
- Proposal: `planning/proposals/VCS-verification-evidence-time-and-criteria-snapshot-fixed-package.md`.
- Required design-only acceptance token: `ACCEPT_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT`.
- Proposal SHA-256 (raw file bytes): `B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56`.
- Implementation authorization: **not included**; separate authorization is required after owner-document landing and review.

The package fixes `RecordVerificationEvidence.recordedAt` to the first durable
P9 ActionIntent time and requires a complete, exact `missionSnapshot` plus
`criteriaResults` snapshot for new `ConcludeVerification` writes. It defines
strict v1 historical compatibility, `Pending` / `Available` /
`NotApplicableOrphaned` / `UnavailableLegacy` status handling without inferred
historical values, including the exact G5 row/event exception
`Unknown + Orphaned + []` for both ConcludeVerification and RetryVerification.
The RetryVerification outer v1 receipt shape and IDs remain unchanged; it binds
the canonical row/event, does not copy the snapshot or generate an inner
Conclude receipt, and exact replay validates row/event before returning the
original receipt. The package requires strict v1-shape and corrupt/missing/
mismatched row-event fail-closed tests. It also defines receipt-first AH10
replay, the owner-document landing set, migration work for the separately
authorized implementation package, and an atomic crash/replay qualification
matrix. Open-row migration proof now treats the existing
`verifications.mission_snapshot` as the sole complete snapshot source and
requires strict codec, identity, Work revision and `VerificationStarted`
association checks. The event's goal/count `missionDigest` is weak consistency
only and cannot reconstruct or overwrite criteria, risk, or ordering. Missing,
malformed, or unassociated row snapshots abort preflight before writes;
all pre-migration concluded rows remain `UnavailableLegacy`. A canonical
full-snapshot digest is explicitly outside this package.

Source evidence reviewed: `planning/results/verification-evidence-replay-and-snapshot-governance.review.md`,
`tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts`,
and `tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts`.
The review records the per-invocation time/fingerprint mismatch and the missing
durable `criteriaResults` snapshot as separate failures.

This was a planning-only preparation. No design, implementation, test, or
migration files were changed; no tests were run; nothing was staged or
committed. `git diff --check` and raw SHA-256 are recorded after final proposal
write.
