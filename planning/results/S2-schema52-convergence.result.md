# S2 P52 schema-52 convergence result

**Status: schema-52 implementation and targeted qualification PASS.** No
existing or preserved database was opened or upgraded; every migration and
offline-copy qualification used disposable fixtures. No real Provider or S2
process journey was run.

## Landing

- P52 is registered as the current schema migration with exact predecessor 51
  and `offlineOnly`; it creates the append-only Work contract revision ledger
  and backfills one `LegacyCurrentSnapshot` for each Work's exact current
  revision without fabricating prior history.
- The functional/current-schema fixture bootstrap runs P52 after P51 with the
  offline-only gate enabled, then verifies `user_version = 52` and
  `foreign_key_check`.
- Runtime composition and readiness require exactly schema 52. P38 rejects
  schemas 38–51 before runtime/Web startup and rejects newer schema 53.
- The offline schema-upgrade coordinator now pins and previews the P52 SQL and
  backfill source, applies P52 under the existing P39 MaintenanceExclusive
  permit and manifest transaction/recovery path, verifies ledger digests,
  append-only triggers, exact current Work snapshots and foreign keys, and
  supports schema-52 read-only no-op/copy. P39's privileged 0037–0039 ordering
  remains unchanged; its continuation now targets schema 52.
- The AH10 legacy P32 oracle explicitly projects schema 52 to schema 44 while
  verifying that P52's history ledger is omitted because the historical
  schema has no representation for it.

## Evidence

- P52 adapter migration/backfill and `onApply` rollback tests: PASS (3/3 after
  final descriptor assertion); includes immutable triggers and FK check.
- Offline schema-51 → schema-52 P52 backfill, before/after commit resume, exact
  schema-52 no-op and schema-52 source-copy test: PASS (1/1).
- Full schema-48 → schema-52 pinned-prefix upgrade: PASS (1/1), with final
  schema signature and FK checks.
- P52 descriptor predecessor/hash/source KAT: PASS (1/1).
- Schema-current architecture/layering checks: PASS (4/4).
- Runtime boundary schema refusals (38–51 and newer 53): PASS (29/29).
- Schema-52 no-op and fresh `runDaemonOnce`/Web-bind startup qualification:
  PASS (2/2), using a disposable schema-52 fixture; no Provider involved.
- Persistence and single-workspace builds: PASS. Targeted Biome/diff checks:
  PASS.

Full `pnpm typecheck` remains blocked by an unrelated existing
`PortableModelRequest.inputItems` union-narrowing error in
`packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts`;
the run reported no schema-52/S2 type errors.
