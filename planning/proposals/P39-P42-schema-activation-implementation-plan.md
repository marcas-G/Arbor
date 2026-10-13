# P39–P42 Schema Activation Implementation Plan

Status: **Planning only; not an authorization to register, execute, upgrade,
start, or release.** This plan records the implementation sequence for later
explicit user authorization. It does not amend any frozen design contract.

## Authoritative integration base and evidence

- Integration branch: `codex/full-code-convergence`.
- Authoritative HEAD when this plan was prepared:
  `899d014b400923402f4f322dd49fd715f46c2667`.
- Cumulative P38→P42 isolated qualification commit:
  `650542772452272356eb4d6d9774924bd4b6f15a` (ancestor of the HEAD above).
- Qualification record: `planning/results/integration-fixture-convergence-2026-10-13.result.md`.
- The cumulative test starts with a disposable P38 database, pins descriptor
  SQL hashes, checks rejection of P42 from versions 38/39/40, injects a failed
  transaction for each migration, then checks restart/apply/no-op and the final
  version-42 schema/data invariants. It passed 1/1. This qualifies that isolated
  migration path; it is not evidence of a live upgrade or deployment.

## Registry and version constants

The activation shape should preserve the P39 privileged-maintenance boundary:

- `P39_MAINTENANCE_MIGRATIONS` remains the only path that applies 0039, and
  remains outside ordinary `CURRENT_MIGRATIONS`.
- Once activation is separately authorized, `CURRENT_MIGRATIONS` should be the
  P38 prefix plus P40, P41, and P42, in that order. The intentional missing
  ordinary ID 39 is the privilege boundary, not a skippable migration.
- Add an explicit `CURRENT_SCHEMA_VERSION = 42`; set the supported migration
  high-water to 42. Keep the distinction between the 42 runtime schema target
  and the P39 maintenance descriptor visible in names/comments/tests.
- Register none of these descriptors before the complete activation review and
  the requested authorization. Do not alter earlier migration bodies or
  manifest hashes.

## Per-step prefix enforcement

Set the standalone descriptors' preconditions to:

| Descriptor | Required current `user_version` | Resulting version |
|---|---:|---:|
| P40 / 0040 | 39 | 40 |
| P41 / 0041 | 40 | 41 |
| P42 / 0042 | 41 | 42 |

`adapters/persistence-sqlite/src/migrate.ts` currently checks only the first
pending descriptor with `requiresUserVersion` before entering the apply loop.
Change the runner to validate each pending descriptor against the actual
current version immediately before its transaction. Add a regression proving
that a list containing 0040 and 0042 but omitting 0041 cannot advance 39→40→42.
Retain the existing 42 no-op behavior and transaction rollback guarantees.

## Startup and readiness gates

- Update the composition schema gate to require schema version 42 before
  constructing runtime services. Versions 39–41 remain maintenance/upgrade-only;
  versions below 42 report that an offline upgrade is required; versions above
  42 remain unsupported.
- Update persistence readiness to compare `PRAGMA user_version` with the
  explicit schema target 42.
- The daemon's existing migration hook may remain for idempotent compatibility,
  but on an accepted production database at version 42 it must be a no-op. The
  daemon must not opportunistically run P39 or upgrade an older database before
  the schema gate.
- Exercise direct startup and `--once` rejection at 38, 39, 40, and 41, and
  successful startup at 42. Confirm no scheduler, consumer, recovery, or Web
  transport starts before version 42 is verified.

## Offline upgrade CLI and sequence

There is no schema-upgrade CLI/package script today. Add a dedicated operator
entry point (for example `schema:upgrade`) with explicit database and P39 report
sidecar paths; do not overload normal daemon startup.

1. Require an offline target: a fresh database or a disposable, consistent copy
   explicitly selected by the operator. Validate the database path, expected
   starting `user_version`, local-filesystem/ACL support, and that the report
   sidecar does not alias the primary or another protected store.
2. For a fresh empty database only, apply the existing ordinary prefix through
   P38. P39 maintenance accepts only versions 36/37/38, so it cannot be called
   at version 0.
3. Invoke the existing `runP39SqliteMaintenance` path for P39. Do not call
   `runMigrations([P39_RECONCILIATION_MIGRATION])` from runtime or CLI. Preserve
   its cross-process maintenance-exclusive writer lock, WAL requirement,
   `BEGIN IMMEDIATE` primary reservation, ordered 0037→0038→0039 manifest/hash
   checks, blocker preflight/report read-back, rollback behavior, and FK check.
   A blocker report is a separate audit artifact, not a backup and not a reason
   to force migration.
4. Only after P39 returns successful version 39, reacquire the same P39
   maintenance-exclusive writer-lock protocol for the 0040→0041→0042 suffix.
   Apply each descriptor in its own transaction with exact predecessor checks;
   keep runtime startup refused for the entire 39–41 interval. Do not fabricate
   migration-history rows or bypass descriptor SQL/fingerprints.
5. Verify `user_version=42`, `PRAGMA foreign_key_check` is empty, P39/P40/P41
   guards and stores exist, P41 rejects a NULL fact ID and maintains its marker,
   and P42 has `resource_source_json NOT NULL` with every pre-existing Project
   explicitly backfilled to `LegacyUnknown`. Reopen the database and verify the
   migration is a no-op at 42 before allowing daemon startup.

Before making a copy from a database that has WAL enabled, stop every daemon and
release its runtime-shared permit. Use SQLite's consistent backup mechanism (or
a documented offline checkpoint-and-copy procedure); never copy only the main
`.sqlite` file while WAL writes may exist. Test the CLI against that copy, not
the source. Keep the P39 report sidecar separate from both source and copy.

Proposed command shape (illustrative only; no such command exists yet):

```text
pnpm build
node apps/single-workspace/dist/schema-upgrade.js --database <offline-copy.db> --p39-report-db <separate-report.db>
```

For a fresh database, the CLI should make its P38-bootstrap mode explicit rather
than silently treating an arbitrary existing database as new. For an existing
copy, accept only versions 36–38 for the P39 path, and fail closed for unknown,
newer, or partially applied states.

## Authorization boundary and verification scope

The combined governance record explicitly excluded registration/activation,
existing-database upgrade, and release. The cumulative qualification approval
did not widen that scope. A new user authorization should cover only:

- registering P40–P42 in the approved current registry while retaining P39 as
  maintenance-only;
- the per-step runner gates, schema-42 startup/readiness gates, and the offline
  upgrade CLI described here;
- fresh-database and explicitly disposable-copy qualification, including
  restart, rollback, no-op, FK, and runtime-refusal checks.

It must continue to exclude upgrading a preserved/live user database, running
the daemon against a partially upgraded database, deployment, and release.
Any live upgrade needs a later separate authorization after the offline
qualification and operator review.

Suggested authorization token for the user to consider:
`AUTHORIZE_P39_P42_SCHEMA_ACTIVATION_AND_FRESH_COPY_QUALIFICATION`.

No files under `docs/design/**` or production code are changed by this plan.
