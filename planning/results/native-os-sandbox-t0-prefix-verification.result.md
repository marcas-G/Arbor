# Native OS Sandbox T0 Prefix Verification

**Candidate:** `20b4e6470ce6865880505949a898bad4bbfa507f`
**Fixed plan:** `native-os-sandbox-schema48-rebase-fixed-implementation-plan.md`
**Fixed plan SHA-256:** `3EAD84A15267DD00AF754C2FC2B5DCE98FDBDBC7C5CB305A99055646571A8F62`
**Result:** prefix identifiers are available, but migration implementation is blocked by an unresolved P43 prefix contradiction.

## Checks

- `CURRENT_SCHEMA_VERSION` is 48 and `CURRENT_MIGRATIONS` ends at migration 0048.
- Migrations 0049 and 0050 are not registered in `adapters/persistence-sqlite/src/migrations.ts`; no 0049/0050 migration implementation or decision/fact tables are present in the SQLite source tree.
- The fixed-plan SHA-256 matches the authorized plan. All 34 owner file SHA-256 values in `native-os-sandbox-schema48-design-landing.manifest.md` match the checked-in files.
- The exact 0047/0048 descriptors require versions 46/47 respectively and settle at schema 48.

## Design Gap: P43 prefix interpretation

The fixed plan and accepted landing records state that the dormant P43 Blocked WorkEpisode descriptor is not registered, that its draft schema must be rejected as a 0049/0050 prefix, and that the descriptor must be sequenced after schema 50. The current candidate contradicts that premise:

- `adapters/persistence-sqlite/src/migrations.ts` registers `P43_MIGRATION` in `CURRENT_MIGRATIONS`, followed by P44; the registry reaches schema 48.
- `P43_BLOCKED_WORKEPISODE_MIGRATION` creates `work_blockers` and `inbox_workspace_sequences` at 42→43.
- `planning/results/P43-P44-schema-activation-qualification.result.md` records P43/P44 activation and qualification; the current release blocker matrix also lists the schema-44 prefix as active.
- The accepted P1 schema contract requires 0049 to accept the complete ordered 001–0048 prefix, while the plan/P10 acceptance also says the P43 schema is rejected.

No code, migration registry, prior migration, or `docs/design/**` file was changed. Governance must clarify whether “dormant P43 draft” denotes a different schema than the already-applied P43 migration, or revise the preflight contract through the owning design documents before 0049/0050 can be implemented.

## Qualification

No database was modified and no migration was run. T1 implementation and tests were not started because the exact 0049/0050 preflight behavior depends on resolving this design conflict.
