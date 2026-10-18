# F23 P6 Operator Rebuild Proposal Preparation

Status: **PREPARATION COMPLETE — PROPOSAL NOT ACCEPTED; NO IMPLEMENTATION AUTHORITY**

## Baseline and artifacts

- Main candidate: `C:\Users\ThinkPad\.codex\worktrees\p4-final-release-fixes\Arbor`
- Baseline commit: `5724895727c5d7bda180547ba87a603233f469d1`
- Existing gap evidence: `planning/results/F23-P6-owner-route-and-rebuild-design-gap.md`, raw SHA-256 `C0EA9161835308CACC2CB35CEB62E7E996891D4D6956497809AB9C0FAD5F170B`.
- Fixed P8/P6 implementation plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
- New proposal: `planning/proposals/F23-P6-operator-inbox-rebuild-and-route-move-na-draft.md`, raw SHA-256 `E6C86659880C3964733A048F809109B8E5877F5E96477F2A560EAC25C9EEE700`.
- New recommendation: v1 owner/Parent route-move command is N/A only because no canonical mutation command exists; production P6 rebuild remains required as an operator-only offline surface using schema 48, P39 `MaintenanceExclusive`, manifest/audit, a single transaction and the existing repository helper.
- Recommended manual acceptance token: `ACCEPT_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_AND_V1_ROUTE_MOVE_NA`.
- Separate implementation authorization required after manual acceptance and owning-document landing: `AUTHORIZE_F23_P6_OPERATOR_UNBOUND_LEGACY_REBUILD_IMPLEMENTATION`.

## Scope and verification

The proposal specifies exact CLI/API names and arguments, P39 lock/authorization
boundary, schema-48 validation, protected hash-chained manifest, SQLite/audit
crash recovery, idempotency, current-route authorization, N/A handling for
future owner-mutation commands, and a TDD/process-crash/competition matrix. It
retains the existing `rebuildUnboundLegacyInboxProjections(updatedAt)` helper
as the sole route mutation implementation and does not repurpose P10 Attention.

This preparation changed only the two new planning files listed above. It did
not change code, migration registries, `docs/design/**`, or any database; it
performed no deployment/release action. No proposal acceptance or code
authorization is implied. The next step is manual review/acceptance, followed by
the owning-document landing and independent consistency review; only then may
the separate implementation token be considered.
