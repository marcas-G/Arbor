# P39–P42 Schema Activation Implementation Plan

Status: **Implementation-closure plan for already accepted design; not an
authorization to register, execute, upgrade, start, or release.** This plan
records the bounded code/test work needed to close the accepted P39–P42
implementation seam. It does not amend any frozen design contract. If
implementation evidence reveals a semantic conflict with an accepted contract,
stop and record a Design Gap with the failing evidence; do not choose new
semantics in this plan or in code.

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
entry point (for example `schema:upgrade`) with an explicit mode and distinct
database/report paths; do not overload normal daemon startup. The public modes
are `fresh`, `copy`, and `resume-copy`. `fresh` and `copy` always create a new
target. `resume-copy` is the only mode that may open an existing target, and it
accepts only an explicitly selected, previously-created disposable copy. No
mode upgrades or replaces its source.

### Mode and path contract

- `fresh --database <new-target>` has no source argument. The target and its
  SQLite sidecars/lock artifacts must not exist. Create it with exclusive
  create semantics, bootstrap only the ordinary migration prefix through P38,
  then proceed to P39. P39 cannot be invoked at version 0.
- `copy --source <existing-db> --database <new-target>` opens the source
  read-only, validates its expected version (36–38), and creates the target
  exclusively using SQLite's online backup API. This captures a consistent
  SQLite snapshot including WAL-visible committed state. Do not use a raw file
  copy, rename, checkpoint-and-copy shortcut, or write-capable source handle.
  The source stays read-only for the entire command and is verified unchanged
  afterward; all migrations are applied only to the new target.
- `resume-copy --database <existing-disposable-copy>` is an explicit operator
  choice to continue a prior interrupted/blocked copy. It never accepts the
  source as target and never creates/replaces a source. Revalidate target
  identity and schema-prefix evidence before applying anything. The original
  source remains read-only and is not needed for migration execution.
- Resolve canonical paths before opening files; compare both canonical path
  and stable file identity (device/volume plus inode/file ID) for every existing
  database. For new destinations, resolve the real parent and reserve the final
  name with exclusive creation before opening SQLite. Reject source/target/report
  aliases, hard links, symbolic links, junctions/reparse points at any path
  component, non-local/network filesystems, and unsupported ACL/locking
  profiles. Apply P39's established protected-path and OS-identity checks to
  the primary, lock, and report database. In `fresh`/`copy`, the report path
  must be a distinct new sidecar; in `resume-copy`, an existing report is
  accepted only after its path, file identity, P39 schema, and report rows are
  validated, and a new report path is still created exclusively. No report
  path may alias the source, target, writer-lock DB, or any protected
  application store. Fail closed on identity/path uncertainty.
- Never delete, truncate, overwrite, or silently substitute a conflicting
  source, target, report, or lock file. Alias/path validation failure leaves
  all caller-owned inputs untouched. Generated targets/reports are operator
  artifacts; cleanup is a separate explicit operation after review.

### Ordered execution and lock lifetime

1. Require the source to be offline: the operator has stopped every daemon and
   no writer is active. In copy mode, open it read-only and take the backup API
   snapshot. Verify the source version and capture its canonical path/file
   identity before creating the target.
2. Open the new target and verify the exact supported prefix. For `fresh`, run
   the ordinary P1–P38 prefix before the privileged maintenance phase. For
   `copy`, accepted input is exactly version 36, 37, or 38. `resume-copy` accepts
   only a fully committed prefix state listed below. Unknown versions, missing
   predecessors, mixed/partial migration state, schema-signature mismatch, or
   descriptor-hash mismatch fail closed before the next migration.
3. Acquire one P39 `MaintenanceExclusive` permit for the target, using the
   existing cross-process writer-lock protocol. Hold this exact permit
   continuously from before P39 preflight through 0039, 0040, 0041, 0042,
   final integrity checks, and final no-op verification. Do not release and
   reacquire between P39 and the suffix. Refactor the P39 orchestration boundary
   to accept/use the opaque acquired lease while preserving all existing
   acquisition, process exclusion, identity, release-on-all-exits, and primary
   reservation rules. P39's `BEGIN IMMEDIATE` primary reservation remains
   scoped to its existing P39 chain; the maintenance-exclusive permit remains
   held after that reservation closes. The 0040–0042 transactions are each
   separate, and execute under that same still-held permit.
4. Invoke the trusted `runP39SqliteMaintenance` behavior for the exact
   0037→0038→0039 chain. Do not call
   `runMigrations([P39_RECONCILIATION_MIGRATION])` from runtime or CLI, and
   make generic `runMigrations` reject any descriptor with ID 39 before it
   reads/applies a pending chain. Preserve P39's WAL requirement, manifest/hash
   checks, blocker preflight and report read-back, rollback, foreign-key check,
   and typed refusal behavior. A blocker report is a separate immutable audit
   artifact, not a backup or a reason to force migration; the target remains
   resumable only if it still matches an eligible fully committed prefix.
5. After P39 commits at 39, apply exact descriptors 0040, 0041, and 0042 in
   order, each in its own transaction with a per-step predecessor check and
   no fabricated migration-history rows or SQL/fingerprint bypass. Keep
   runtime startup refused throughout versions 38–41.
6. Verify `user_version=42`, empty `PRAGMA foreign_key_check`, P39/P40/P41
   guards and stores, P41 NULL-fact rejection and marker behavior, and P42
   `resource_source_json NOT NULL` plus explicit `LegacyUnknown` attribution for
   every pre-existing Project. Reopen the target under the same maintenance
   permit and prove the 42 path is a no-op before releasing the permit. The
   permit is released exactly once on success or failure; release failure is
   surfaced as failure and never reported as successful activation.

### Exact restart states

The CLI must distinguish a complete committed prefix from an intra-step or
tampered state. A `resume-copy` may continue only at these exact boundaries:

| `user_version` | Required fully committed chain | Only permitted next work |
|---:|---|---|
| 39 | exact P39 0037→0038→0039 prefix | 0040→0041→0042 |
| 40 | exact P39 prefix plus exact 0040 | 0041→0042 |
| 41 | exact P39 prefix plus exact 0040→0041 | 0042 |
| 42 | exact P39 prefix plus exact 0040→0041→0042 | verify/no-op only |

For each row, verify the version and an approved schema signature derived from
the exact pinned descriptor SQL plus the migration-owned object/column/index/
trigger shape and required data sentinels. Verify the already committed
descriptor hashes against the plan's pinned values before continuation. This
is validation of existing committed state, not a new migration ledger or a
new semantic contract. The single-transaction version bump makes each
descriptor boundary atomic; any observed mixed state, incomplete P39 chain,
missing/extra object, altered descriptor, inconsistent sentinel, or
unverifiable file identity is an intra-step/tampered state and must stop with
no repair, downgrade, cleanup, or automatic source replacement. Do not infer
completion from `user_version` alone. Pin and compare these SQL SHA-256 values
from the isolated cumulative qualification:

| Descriptor | SHA-256 |
|---|---|
| 0039 `ah7_reconciliation_attempts` | `6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec` |
| 0040 `tool_observation_replay_evidence` | `3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa` |
| 0041 `p41_submitted_decision_binding_attention` | `d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed` |
| 0042 `project_resource_source_attribution` | `a0294a5db440e402a6c32b5a2b596502e059642431157eadcb6be7212224e5aa` |

An exact repeated `resume-copy` against the same unchanged copy must be
idempotent: at 39/40/41 it applies only the remaining exact suffix; at 42 it
performs verification and no migration writes. Repeating after a failed
transaction is allowed only if the reopened copy verifies as the preceding
complete boundary. A blocker report leaves the target at its original 36/37/38
version because the P39 chain rolls back. It does not qualify as a 39-prefix
resume state; rerun P39 preflight on the same target only after the operator
has resolved the blocker and explicitly resumes.

Proposed command shape (illustrative only; no such command exists yet):

```text
pnpm build
node apps/single-workspace/dist/schema-upgrade.js --mode copy --source <offline-source.db> --database <new-copy.db> --p39-report-db <new-separate-report.db>
node apps/single-workspace/dist/schema-upgrade.js --mode resume-copy --database <same-disposable-copy.db> --p39-report-db <same-separate-report.db>
```

The CLI must also expose `--mode fresh --database <new-target.db> --p39-report-db
<new-separate-report.db>` explicitly. It must reject ambiguous defaults and
must never treat an arbitrary existing database as an empty database.

## Implementation and qualification file boundary

The later authorized implementation is limited to the following production
owners and their direct package wiring:

- `adapters/persistence-sqlite/src/migrate.ts`: generic ID-39 refusal and
  per-descriptor predecessor validation.
- `adapters/persistence-sqlite/src/p39-maintenance.ts`,
  `adapters/persistence-sqlite/src/p39-maintenance-adapter.ts`, and
  `adapters/persistence-sqlite/src/p39-writer-lock.ts`: preserve existing P39
  invariants while allowing the one opaque maintenance lease to span the
  complete 0039→0042 command.
- `adapters/persistence-sqlite/src/migrations.ts` and the P40/P41/P42
  descriptor modules: separately authorized registration/target constants and
  unchanged accepted descriptor SQL/fingerprints.
- `apps/single-workspace/src/schema-upgrade.ts` (new) and
  `apps/single-workspace/package.json`: explicit operator CLI/modes and package
  command.
- `apps/single-workspace/src/composition.ts`, `apps/single-workspace/src/main.ts`,
  and `apps/single-workspace/src/health.ts`: schema-42 admission/readiness and
  proof that startup hooks do not run an upgrade first.

The qualification boundary is limited to:

- `adapters/persistence-sqlite/test/migrate.test.ts` for generic ID-39 refusal
  and omitted/interleaved-prefix cases;
- `adapters/persistence-sqlite/test/p39-42-cumulative-prefix-qualification.test.ts`
  for descriptor transactions, lock continuity, exact prefix resumption,
  rollback, tamper/intra-step refusal, and final no-op;
- `adapters/persistence-sqlite/test/p39-reality-proof-migration.test.ts` and
  a new CLI test for source immutability, SQLite-backup consistency, target
  exclusivity, path/file-identity alias denials (including hard links,
  symlinks/junctions and network filesystems), report alias denial, and explicit
  mode validation;
- a centralized
  `adapters/persistence-sqlite/test/fixtures/schema-42.ts` fixture (new) as the
  sole standard post-activation test setup. Migrate consumers that currently
  fabricate version 42 or independently apply partial P39–P42 prefixes to
  this fixture; retain genuinely version-specific migration tests at their
  owning boundary;
- `adapters/persistence-sqlite/test/p42-project-resource-source-migration.test.ts`
  and a new schema-upgrade CLI test for fresh/copy/resume boundaries; and
- `apps/single-workspace/test/p38-runtime-schema-boundary.test.ts` plus direct
  and `--once` startup cases proving version 42 migration hook no-op, startup
  success at 42, and startup refusal at each of 38, 39, 40, and 41 before any
  scheduler/consumer/recovery/Web transport starts.

Add/modify only these direct production owners, their narrowly required
fixtures/tests, and the result evidence. Do not edit `docs/design/**`, migration
SQL semantics, unrelated runtime/product behavior, deployment configuration,
or preserved/live databases. If a listed test consumer cannot use the central
42 fixture without changing its intended version-specific assertion, document
that exact exception in its test; do not weaken the fixture boundary.

## Authorization boundary and verification scope

The combined governance record explicitly excluded registration/activation,
existing-database upgrade, and release. The cumulative qualification approval
did not widen that scope. This plan closes the implementation steps for the
already accepted design; a new user authorization should cover only:

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
