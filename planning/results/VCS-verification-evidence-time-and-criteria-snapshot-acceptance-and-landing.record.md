# VCS verification evidence time and criteria snapshot — acceptance and landing

Status: **Accepted design package landed; implementation not authorized.**

- Acceptance token: `ACCEPT_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT`.
- Accepted proposal: `planning/proposals/VCS-verification-evidence-time-and-criteria-snapshot-fixed-package.md`.
- Accepted proposal raw SHA-256: `B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56`.
- Acceptance and landing date: 2026-10-17.
- Landing baseline: `d693ed7ebdb0928f89b5af8ccbae94718929d6fa` (DID v1.47).
- Implementation authorization: **not granted**. Migration registration, DDL,
  initialization, production code, fixture mutation and qualification require
  separate authorization.

The accepted contract sets `RecordVerificationEvidence.recordedAt` to the
Runtime-selected timestamp on the first durable P9 ActionIntent (`updatedAt`),
preserved across Pending retries and owner-generation takeover, with fail-closed
behavior when the original intent timestamp cannot be proven. New conclusions
retain the complete immutable `missionSnapshot` and exact ordered
`criteriaResults`. Snapshot state is `Pending`, `Available`,
`NotApplicableOrphaned`, or `UnavailableLegacy`. Ordinary ConcludeVerification
uses matching row, event v2, and result/receipt v2 snapshots. The G5
RetryVerification exception retains its unchanged strict outer v1 receipt and
IDs while the row/event carry `Unknown`/`Orphaned`/`NotApplicableOrphaned` and
empty results. Historical v1 records remain unchanged and strictly decoded.

Migration proof for existing Open rows uses only strictly decoded
`verifications.mission_snapshot` associated with the exact Verification, Work
revision and `VerificationStarted` event. `missionDigest` is weak consistency
only. Unprovable Open rows abort preflight before DDL or data writes; existing
Concluded rows become `UnavailableLegacy` without inferred criterion results.
Migration ID, DDL and initialization remain TBD for the separately authorized
implementation package; no number is reserved and no migration is registered.

Owner-document landing is limited to the accepted scope in:

- `docs/design/implementation/P8/04-evidence-binding.md`
- `docs/design/implementation/P8/01-verification-commands.md`
- `docs/design/implementation/P1/04-sqlite-schema.md`
- `docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md`
- `docs/design/03-detailed-implementation-design.md` (version 1.48 governance record)

Independent post-landing consistency review:
`planning/results/VCS-verification-evidence-time-and-criteria-snapshot-landing.review.md`.
