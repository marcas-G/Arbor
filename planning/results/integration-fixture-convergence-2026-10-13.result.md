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

Full `pnpm check` has not yet been run on this convergence; it is the next
single full-check step after these changes are committed. The P39 writer target
left one untracked integration-root sidecar,
`.arbor-p39-writer-650dffe795249f18518b610197aee7e4be03ac33c51c5534dae26d499e2ea7aa.sqlite`.
After test completion it was confirmed to be a single untracked, non-ignored
file under the integration root with no Vitest process active, then removed by
literal path. `planning/results/P12.restore-drill.json` is unchanged.
