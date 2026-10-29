# Schema-42 Adapter Fixture Convergence

Date: 2026-10-13

## Scope

Classified the SQLite adapter test migration callsites around the trusted
P38 → privileged P39 → P40/P41/P42 path. Current store/runtime consumers use
real schema-42 SQLite files. Historical P39 migration qualification continues
through the dedicated P39 maintenance entry point. No production source or
docs/design files changed.

## Changes

- Replaced work-readmission's per-case generic CURRENT_MIGRATIONS bootstrap
  with one suite-level trusted schema-42 template and independent SQLite file
  clones per case.
- Added the reusable schema-42 template factory. It builds one database by
  running actual P38, privileged P39, and standalone P40/P41/P42; closes the
  connections and checkpoints both databases before copying the primary and
  separate P39 report database into independently ACL-protected clone
  directories. Clone and factory cleanup are idempotent.
- Moved P39 recovery/reconciliation store tests and the P4 P39 invocation-store
  case onto the trusted schema-42 fixture. P41 store persistence uses the real
  P41 schema and a seeded P38 project/execution. P43 pre-migration Inbox and
  P43 store cases use a trusted schema-42 base.
- Changed the P42 migration test to seed a real P38 Project and inspect the
  schema-42 result. Removed fabricated user_version setup from the P40/P42 and
  migration-runner boundary tests.
- Changed historical P39 migration tests to prepare P38 and invoke
  runP39SqliteMaintenance, never generic runMigrations with P39.
- Increased test-support Windows ACL process timeouts to 30 seconds, retaining
  bounded failures. Added 120-second limits to the slow P39/P42 setup tests and
  kept cleanup in finally.
- Updated P41 descriptor assertions for its active registry entry and exact
  requiresUserVersion: 40 predecessor.

## Verification

- pnpm typecheck — PASS.
- Biome on the 14 affected test/support files — PASS.
- git diff --check — PASS.
- Schema-42 fixture qualification — 3/3 tests PASS (76.93s).
- Work-readmission gate — 27/27 tests PASS (103.26s).
- P39 reality/recovery, P41 storage, and P42 migration qualification — all
  passed after correcting bounded Windows ACL timeouts, test setup timeouts,
  and the active P41 registry expectation. P41 storage's final isolated rerun
  passed 5/5; the preceding four-file run had 26/27 pass with only the now-fixed
  P41 registry assertion failing.
- The other targeted files in the 12-file Adapter batch passed. The first
  batch's P39/P41/P42 failures were all covered by the focused reruns above.

These are targeted adapter qualifications, not a claim that the full
repository test suite or release checks passed.
