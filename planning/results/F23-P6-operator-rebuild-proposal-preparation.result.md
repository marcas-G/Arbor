# F23 P6 Operator Rebuild Proposal Preparation

Status: **PREPARATION COMPLETE — PROPOSAL NOT ACCEPTED; NO IMPLEMENTATION AUTHORITY**

## Baseline and artifacts

- Main candidate: `C:\Users\ThinkPad\.codex\worktrees\p4-final-release-fixes\Arbor`
- Baseline commit: `5724895727c5d7bda180547ba87a603233f469d1`
- Existing gap evidence: `planning/results/F23-P6-owner-route-and-rebuild-design-gap.md`, raw SHA-256 `C0EA9161835308CACC2CB35CEB62E7E996891D4D6956497809AB9C0FAD5F170B`.
- Fixed P8/P6 implementation plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
- New proposal: `planning/proposals/F23-P6-operator-inbox-rebuild-and-route-move-na-draft.md`, raw SHA-256 `7D5F1043124F145344DD5F2132C6368747090CA0C71A622FBA263AA2C820350B`.
- New recommendation: v1 owner/Parent route-move command is N/A only because no canonical mutation command exists; production P6 rebuild remains required as an operator-only offline surface using schema 48, P39 `MaintenanceExclusive`, manifest/audit, a single transaction and the existing repository helper.
- Recommended manual acceptance token: `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`.
- Separate implementation authorization required after manual acceptance and owning-document landing: `AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION`.

## Scope and verification

The independent review was incorporated. The proposal now distinguishes the
P39 blocker-report SQLite `--p39-sidecar` from the JSONL operation `--manifest`,
states P39's pre-permit SQLite initialization effects for both report sidecar
and writer-lock DB, and defines fail/cleanup/retry/crash boundaries. If the
RuntimeShared lock blocks, these P39 infrastructure artifacts may remain, but
the primary and JSONL manifest are untouched and no P6 row changes. It also
specifies providing the exact P39 continuation primary SqlClient object to both
the existing TransactionPort and RetryVerificationOriginRepository; the
TransactionPort alone supplies TransactionScope and transaction boundaries,
with no second connection/nested transaction. The proposal retains schema-48
validation, hash-chained audit, crash/restart recovery, idempotency,
current-route authorization, v1 route-command N/A, P6 `00` landing and the TDD
matrix; it does not repurpose P10 Attention.

This preparation changed only the two new planning files listed above. It did
not change code, migration registries, `docs/design/**`, or any database; it
performed no deployment/release action. No proposal acceptance or code
authorization is implied. The next step is manual review/acceptance, followed by
the owning-document landing and independent consistency review; only then may
the separate implementation token be considered.
