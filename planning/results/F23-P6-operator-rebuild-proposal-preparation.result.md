# F23 P6 Operator Rebuild Proposal Preparation

Status: **ACCEPTED DESIGN LANDED — IMPLEMENTATION NOT AUTHORIZED; INDEPENDENT REVIEW PENDING**

## Baseline and artifacts

- Main candidate: `C:\Users\ThinkPad\.codex\worktrees\p4-final-release-fixes\Arbor`
- Baseline commit: `5724895727c5d7bda180547ba87a603233f469d1`
- Existing gap evidence: `planning/results/F23-P6-owner-route-and-rebuild-design-gap.md`, raw SHA-256 `C0EA9161835308CACC2CB35CEB62E7E996891D4D6956497809AB9C0FAD5F170B`.
- Fixed P8/P6 implementation plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
- New proposal: `planning/proposals/F23-P6-operator-inbox-rebuild-and-route-move-na-draft.md`, raw SHA-256 `B6A542973768D1C0D7C8ACB644988D1C957B7020F73206C335D73FF7FE0C833E`.
- New recommendation: v1 owner/Parent route-move command is N/A only because no canonical mutation command exists; production P6 rebuild remains required as an operator-only offline surface using schema 48, P39 `MaintenanceExclusive`, manifest/audit, a single transaction and the existing repository helper.
- Recommended manual acceptance token: `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`.
- Accepted: `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA` on 2026-10-18. Owning-document landing: `planning/results/F23-P6-operator-rebuild-and-route-move-na-acceptance-and-landing.record.md`.
- Independent post-landing review: pending. Implementation authorization required after that review: `AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION`.

## Scope and verification

The independent proposal review was incorporated. The accepted proposal now distinguishes the
P39 blocker-report SQLite `--p39-sidecar` from the JSONL operation `--manifest`,
states P39's pre-permit `openSync(..., "wx", 0o600)` creation race (creation-only,
not a maintenance permit), SQLite initialization effects for both report
sidecar and writer-lock DB, and defines winner/loser, fail/preserve/retry/crash
boundaries. If RuntimeShared blocks the lock, these P39 infrastructure artifacts
may remain, but the primary and JSONL manifest are untouched and no P6 row
changes. It also specifies providing the exact P39 continuation primary
SqlClient object to both the existing TransactionPort and
RetryVerificationOriginRepository; the TransactionPort alone supplies
TransactionScope and transaction boundaries, with no second connection/nested
transaction. The proposal retains schema-48 validation, hash-chained audit,
crash/restart recovery, idempotency, current-route authorization, v1
route-command N/A and P6 `00` landing. P8 `06` Story H landing language marks
only command-level route-move/crash qualification N/A for v1 while retaining
same-key transaction helper, old/new visibility and future-command rejection
requirements. P10 Attention is not repurposed.

Proposal preparation initially changed only the two planning files listed
above. The accepted manual landing changed only the owning `docs/design/**`
files and governance/planning records; it did not change code, tests, migration
registries, or any database, and performed no deployment/release action. No
production implementation authority is implied. The next step is independent
post-landing review; only after it passes may the separate implementation token
be considered.
