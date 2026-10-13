# Schema 42 stable integration

Date: 2026-10-14
Base: `4e093afb9be038576f1d0e8a8628c32e502b2f57`
Plan: `b3322b735996664d19cd2bf9643909bef6704bfb`
Accepted plan SHA-256: `7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`

## Integrated scope

Kept the existing schema-42 runtime and migration-registry activation from the
base. Added the stable offline P39–P42 schema-upgrade CLI through `e9aa8c1c`,
including the hash-chained manifest, resumable copy/upgrade reconciliation,
serialized provenance/report handling, bounded Windows security queries, and
post-migration target reopen behavior.

Added the invocation-wide protected P39 test root and isolated Vitest setup
from `cafa95e9` / `fa04f315`, the cached Windows SID cleanup, and the 30-second
security-process bounds. Added schema-42 template cloning, adapter fixture
callsite migrations and timeout/result updates through `18948e0f`, then the
stable single-workspace MAC fixture, per-case clone, timeout and result changes
through `78d06a43`.

The result now includes the CLI, runtime/registry activation, schema-42 factory
and clones, P39 global test root/SID/security bounds, and adapter plus MAC
fixtures. The P12/F21 extension below imports only the requested fixture and
focused boundary-test work; no P5 branch or pending red reproduction was
cherry-picked. No `docs/design/**`, live database, or deployment was changed.

## Cherry-picks

- CLI: `9056b3ca`, `cafa95e9`, `fa04f315`, `a5dcb8bf`, `e80f189b`,
  `2253e0f3`, `251ef294`, `b7a32b58`, `e9aa8c1c`.
- Adapter: `54fd6815`, `c5d788ad`, `eaa710b1`, `0105706f`, `1c7afad8`,
  `18948e0f`.
- MAC: `3ed3b218`, `f73b25a2`, `efc3d6c1`, `78d06a43`.
- P12/F21: `8d7be0bb`, `9d9a937e`, `ce5fd7ad`, `655ea71d`, `141c7530`,
  `b6af3e61`, `e48811fc`, `a8d94e04`.

All cherry-picks applied without conflicts. Git performed automatic merges in
the cumulative migration qualification and adapter callsite files; no manual
semantic conflict resolution was needed. The P12/F21 cherry-pick auto-merged
`tests/support/p39-windows-deployment-test.ts`. One inherited Markdown
hard-break space was removed so `git diff --check` passes.

## P12 / F21 fixture extension

Integration date: 2026-10-14.

Imported the P12 current-composition, transport, daemon, F21, pending-view, and
B01 capability fixture migration. App-backed cases use a schema-42 suite
template, independent SQLite clones, 120-second bounds, and per-case cleanup;
the two documented adapter-only P38 transport cases remain unchanged. The F21
tuple-conflict checks assert the current HTTP 409 contract. The pending view
qualification now exercises authenticated non-loopback requests and verifies
an unconfigured wildcard listener is rejected before serving traffic. P39
test cleanup refuses to remove the invocation TEMP root or an ancestor.

Did not replay source commits already represented in the stable branch:
`6e1e10ee` duplicated the isolated schema-42 factory from `54fd6815`,
`f579f24e` duplicated cached SID cleanup from `e80f189b`, and `75ae9fba`
duplicated the P39 Windows security timeout from `251ef294`. Cherry-picking
`ec5c0afb` produced an empty patch because the stable branch already had the
30-second bounds for all P39 ACL helper subprocesses; it was skipped. The
source branch's duplicate global-root setup commits were also omitted. P5
fixture/diagnostic commits were not selected.

The imported focused evidence is recorded in
`schema42-p12-fixture-migration.result.md`. It reports focused PASS for F21,
B01, pending view auth (2 cases), and the P39 Story 9 D2–D4 cases after the
timeout fix. It also records that the broader P12/F21 batch was not entirely
green in one run and that several app-backed/capability cases were not rerun;
this integration does not claim a full P12/F21 gate pass.

## P5 production wiring and fixture extension

Imported the P5 current-schema fixtures for all seven P5 suites. Each suite
builds one schema-42 template, clones a separate SQLite file per case, uses a
120-second setup/test bound, and cleans up its clone. The migration call-site
classification is retained at
`schema42-current-migration-callsite-classification.result.md`.

The production single-workspace layer now provides both
`P39RecoveryEvidenceStoreLive` and `ToolObservationEvidenceStoreLive` from its
existing SQLite infrastructure layer. ToolRuntime derives the RecoveryBinding
SHA-256 projection with `toolDefinitionIdentityDigestV1` while retaining the
stable tool-definition token. P5 acceptance verifies successful shell
settlement, bound P39 evidence, and canonical P40 observation persistence; an
architecture test guards the production wiring.

Imported the final P5 changes in `a5a39f95`, `a39f2726`, `e0925ef6`,
`f115c627`, `8ead3d8f`, `02701de7`, `1184dd7a`, `b7059c12`, `11715d28`,
`c84bd460`, `ebe3f6b4`, `b46de477`, and `fdfed38d`. The intermediate P5
diagnostic commits were carried in order so the final test cleanup applies
against its reviewed source state.

Skipped duplicate P39/shared fixture commits: `3fd48a3f` and `aff60a5b`
(global test setup already present from `cafa95e9` / `fa04f315`), `99bd8549`
(schema-42 clone factory already present from `54fd6815`), `f6b0b0de`
(cached SID already present from `e80f189b`), and `bdeda0a1` (P39 Windows
security timeout already present from `251ef294`). No P5 production design or
schema change was made.

The imported source result records focused PASS for the RecoveryBinding
vectors, ToolRuntime digest projection and P5 slice (3 files / 7 tests); all
seven migrated P5 suites (7 files / 7 tests); and the P39/P40 composition
architecture checks (2 tests). It also records successful typecheck, Biome
and whitespace checks. The supplied independent review status was
Blocking/B1/B2 = 0.

## Verification

- `pnpm typecheck` — PASS after the P5 integration.
- Biome on 13 files changed by the P5 integration — PASS. The preceding
  P12/F21 integration had checked 54 changed TypeScript/JavaScript/JSON files.
- `git diff --check` — PASS after the whitespace cleanups.
- Static search confirmed the shared global P39 setup is registered in all
  five configured Vitest entrypoints; schema-42 factory cloning is used by the
  adapter readmission suite and all 12 migrated single-workspace suites; the
  P12/F21 app fixtures have 120-second bounds; and P39 security plus ACL helper
  subprocess limits are 30 seconds. Static search also confirmed the TEMP
  cleanup guard, the F21 409 expectation, and the pending auth boundary.
- Vitest and repository-wide gates were not run, as scoped for this integration.
