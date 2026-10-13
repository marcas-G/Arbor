# Integration fixture and runtime-gate convergence

Date: 2026-10-13  
Base: `f89ff205c952b5da9a5d6d0c77aae66da5ebc23c`  
Scope: port reviewed test/environment fixes into the release integration worktree.

Integration commits:

- P39 Windows test environment and P38 boundary qualification:
  `e76f46a8b10a814bd6490a89ca5e77caf720a52e`.
- Resource fixture, P41 optional projection availability, and P1/P9 fixture
  corrections: `4908c525126a76a2475ff63400981a79c8bf0fcf`.

## Changes

- Ported the P39 private per-Vitest-file temporary root and explicit Windows
  PowerShell module path from the uncommitted P39 diagnostic worktree. The
  root DACL grants the current SID, SYSTEM, and Administrators; teardown
  restores cleanup access. Production P39 guards and migration registration
  were unchanged.
- Updated P38 boundary assertions to preserve `CURRENT_MIGRATIONS = P38` while
  checking the separately exported P39 maintenance suffix and the typed
  P39 startup refusal for schema 39. Its normal-startup test now passes the
  exact temporary database path into `runDaemonOnce`; an interruptible
  20-second Effect timeout releases the test scope before cleanup and includes
  phase/path/elapsed-time diagnostics. This test is in-process and spawns no
  daemon child.
- Updated the P12 in-memory composition expectation without weakening
  production guards. Added the F21 legacy-source fixture to P11/P12 test seed
  paths that create Projects under old test schemas.
- Added a reusable test-only valid FileTree resource boundary and resolver.
  P9 TT1–TT4 / Story E and P4 settlement-fence tests use it rather than the
  invalid `{}` boundary; P4 also provides the production WorkspaceRepository
  with its test Clock, so the test reaches the intended settlement probe.
- Updated the WorkflowSignalConsumer mock to implement sequenced Inbox upsert;
  its test models parent sequence 2→3 while preserving the existing child
  sequence 3 wake behavior.
- P10 Attention projection now reads P41 Submitted Decision rows only after
  both fact-store and marker-store availability probes report ready. A
  readiness mismatch is typed `PersistenceCorruption`; both unavailable on
  the P38 schema yields no P41 projection rows. P41 recovery/event paths remain
  fail-closed when their source is required.
- Corrected rebuild fixtures: P9 RB-1 now tests offset 0 below floor-1; P1
  directly rewinds only its isolated test DB offset to 0 because its production
  adapter is monotonic, then uses the adapter to advance/rebuild.

No `docs/design/**`, migration, `CURRENT_MIGRATIONS`, deployment, live service,
or preserved database was changed.

## Verification

- P39 persistence: 4 files / 22 tests PASS.
- P39 cross-process writer exclusion: 3/3 PASS.
- Blocked WorkEpisode restart: 2/2 PASS.
- P38 runtime schema boundary: 3/3 PASS, including normal `runDaemonOnce`
  startup on the exact test database path.
- P12 production composition: 5/5 PASS, including CreateProject and the
  ordinary responsibility-tree view on P38 without migration 0041.
- P12 transport: 12/12 PASS; P12 Story 11: 1/1 PASS.
- P11 ControlBasis: 3/3 PASS; WorkflowSignalConsumer: 3/3 PASS.
- P9 four-tier tool outcome: 5/5 PASS; P9 acceptance Story E: 1/1 PASS;
  P9 rebuild plus P1 journal consumer: combined 20/20 PASS.
- P4 settlement fence expiry: 1/1 PASS; P5 composition: 1/1 PASS.
- `pnpm typecheck`: PASS; Biome on all 15 touched TypeScript files: PASS;
  `git diff --check`: PASS.

## Final full-check result

One full `pnpm check` ran at HEAD
`2710df42bdf9a7f1a5227764318e01b55fe2cb80`; it exited 1 at root Vitest.

- Lint/Biome: PASS, 1,140 files.
- Typecheck: PASS.
- Architecture: PASS, 31 files / 159 tests.
- Root Vitest: 392 files; 371 passed, 21 failed. Tests: 2,101 passed,
  54 failed, 3 skipped. Web typecheck/build/test stages were not run because the
  check chain stopped at Vitest.
- `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT` appeared **zero** times in the
  final log (it had been the dominant prior failure). Remaining failures now
  center on older test schemas and fixtures:
  - Invalid `ProjectResourceSource` decode: 19 failure blocks across 12 files,
    including P5/P14/MAC/Wave2 and P9-related app tests.
  - `PersistenceUnavailable` in P12 acceptance/runtime-safety/secret-store and
    P5 slice acceptance: 22 blocks, chiefly tests still applying old P12
    schemas before CreateProject v2 reads/writes the F21 field.
  - F21 resource-admission: four CreateProject response/idempotency failures.
  - Additional P13/B01 public-process, Blocked restart cleanup/timeout, and
    black-box authority issues are retained with exact diagnostics in the raw
    log.

The raw log is at
`C:\Users\ThinkPad\.codex\worktrees\full-code-convergence-release\Arbor\planning\results\integration-pnpm-check-2026-10-13-final.log`.
It is ignored by the repository's `*.log` rule and was not force-added.
SHA-256: `CF2977ED9D99800C78C1DF06BF99D4787257C3983138B190F261A7B2566DC27C`
(409,036 bytes).

The test run changed only the generated timestamp/hash in
`planning/results/P12.restore-drill.json`; both were restored to the exact
pre-run values. The P39 writer test left one untracked integration-root sidecar,
`.arbor-p39-writer-650dffe795249f18518b610197aee7e4be03ac33c51c5534dae26d499e2ea7aa.sqlite`.
After confirming the test process had exited and the sidecar was a single
untracked, non-ignored file under the integration root, it was removed by
literal path. No existing DB, migration state, deployment, or live service was
changed.

## Isolated cumulative schema qualification (test-only)

Added `adapters/persistence-sqlite/test/p39-42-cumulative-prefix-qualification.test.ts`.
It starts with an isolated P38 SQLite fixture containing a legacy Project and
P38 approval row. It proves P42 is rejected at versions 38, 39, and 40; the
trusted P39 maintenance entrypoint advances only 38→39; then exact pinned
descriptors 40, 41, and 42 are applied one at a time while holding the P39
maintenance writer exclusion. Each descriptor receives an injected
transaction failure after DDL/version update, rollback verification from a
new connection, successful restart/apply, and a second no-op run.

Descriptor SQL SHA-256 pins in the test:

- 0039 `ah7_reconciliation_attempts`:
  `6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec`
- 0040 `tool_observation_replay_evidence`:
  `3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa`
- 0041 `p41_submitted_decision_binding_attention`:
  `d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed`
- 0042 `project_resource_source_attribution`:
  `a0294a5db440e402a6c32b5a2b596502e059642431157eadcb6be7212224e5aa`

The final assertions require user_version 42, clean `foreign_key_check`, P39
RecoveryBinding/effect-attempt schema and guards, P40 Observation columns and
triggers, P41 non-null fact rejection and marker projection, and P42
`LegacyUnknown` backfill with `resource_source_json NOT NULL`. The original P38
approval remains unchanged. The test also asserts `CURRENT_MIGRATIONS` still
ends at P38 and contains no 0039–0042 descriptors; this test does not register
those descriptors or touch a preserved/live database.

The final literal-pinned cumulative qualification passed 1/1 in 102.86s.

The legacy Project source repair uses the shared test-only
`ensureLegacyProjectResourceSourceFixture()` helper, which only fills NULL
source values with `LegacyUnknown`; calls for manually seeded old-schema
fixtures are after their Project INSERTs. A representative I0/P5 target passed
2/2. The full 12-file affected app batch passed serially (Vitest
`--no-file-parallelism --maxWorkers=1`): 12 files, 19 passed, 2 skipped. P12
acceptance/runtime-safety/secret-store plus P5 slice acceptance passed in the
preceding targeted batch (4 files); two high-parallel-only timeout/ACL failures
from the first attempt each passed on individual rerun and did not reproduce in
the serial app batch.

Biome checked all 17 touched TypeScript files and `git diff --check` passed.
`pnpm typecheck` (`tsc -b && tsc -p tsconfig.test.json`) passed. No full
`pnpm check` was rerun after the previously recorded failing full-check batch.
