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

## Post-integration lint correction

After the first `pnpm check` at the P5-integrated HEAD, lint reported one
`organizeImports` issue in
`tests/p40-p9-p10-production-recovery.test.ts`. Biome's safe fix moved the
schema-42 fixture import to its sorted position; the diff contains import
ordering only. Biome recheck of that file and `git diff --check` pass. No
heavy tests or full gates were rerun.

## Architecture boundary filename correction

The first full check at the P5-integrated HEAD found one architecture failure:
the P12 path-segment guard classified the operator test's former filename as
transport-related because it contained the segment `cli`. Renamed it to
`schema-upgrade-operator.test.ts`; Git confirms a 100% content-preserving
rename. A repository search found no other references to the former filename,
so no command or result references needed adjustment. The offline
schema-upgrade operator implementation remains in its existing
non-transport location, and the architecture rule was not changed.

Focused verification: `pnpm exec vitest run
tests/architecture/p10-boundaries.test.ts -t "P12 boundary"` — 1 passed, 3
skipped; Biome on the renamed test — PASS; staged `git diff --check` — PASS.
No additional tests or full gates were run.

## Post-full-check fixture and timeout repairs

Cherry-picked `99d6af06`, `f1388a4b`, and `41baaafe` in that order. The
current-runtime fixtures now cover P34 daemon wiring, P5 registry, provider
configuration, P7 wake pipeline, and the S1–S4 public black-box suite with a
schema-42 template and isolated per-case databases. The S1–S4 scenarios create
Projects through the public API; the recorded evidence includes a hard restart
in S4. Historical P4 adapter fixtures use the complete P36 prefix and valid
foreign-key parent rows before migration assertions. Slow schema-42 suites use
bounded template/case timeouts; the cumulative P39–P42 test has a 300-second
case bound. The P39 reality-proof tests stay on a real schema-39 fixture where
P40 would change the constraint under test.

These commits applied without conflicts. The imported records are
`schema42-current-runtime-fixtures.result.md`,
`P36-historical-migration-prefix-fixture-repair.result.md`, and
`schema42-slow-test-timeout-repair.result.md`. Their focused evidence is
retained with its limits: S1–S4 is 4/4 PASS; the P36 repair is 5 files / 14
tests PASS; the adapter batch is reported as 6 files / 34 tests PASS, but the
complete P39 reality-proof file was not rerun after its schema-39 fixture
correction (the corrected case passed, with 18 other cases filtered out). P5 yield/wake
is 1 test PASS at 51.25 seconds. The source records these as focused results,
not full-suite qualification. No test suites were rerun during this
integration.

Validation after these three commits: `pnpm typecheck` PASS; Biome on the 18
changed TypeScript/JavaScript/JSON files PASS; `git diff --check` PASS. No
Vitest or full check was run during this integration update.

## Offline operator preview-template optimization

Imported `9f9ac34a` on top of the integration branch. The exact-prefix test now
reuses one immutable `SchemaUpgradePreviewTemplate` across its recovery
attempts. Runtime test hooks accept that template only after checking the live
target's source version and logical digest; a version 39–42 target also needs
the exact prepared prefix signature. The maintenance-lock check compares
against the appropriate source/prefix digest. The ordinary CLI path still
builds its own preview. The operator child-process timeout remains bounded at
30 minutes, and the existing operator test filename is preserved.

The branch's qualification report records focused `resumes exact prefixes`
PASS (1/1, 804.77 seconds) and the complete operator file PASS (10/10,
1,250.75 seconds), plus typecheck, build and Biome PASS. These expensive
qualifications were not rerun on this integration branch. The cherry-pick
applied without conflicts.

Integration validation after this update: `pnpm typecheck` PASS; Biome on the
changed operator source/test files PASS; `git diff --check` PASS. No heavy
tests or full repository gates were run.

## P4/P12 sandbox environment projection

Cherry-picked `f1759a5b` onto the current integration HEAD without conflicts.
The P4 shell executor now passes `sandboxEnvironment(process.env)` to its
subprocess, so only the shared sandbox allow-list reaches the shell. The
injected-spawn regression test checks allow-listed inheritance, secret
exclusion, and preservation of cwd, timeout, and encoding. No OS sandbox or
permission semantics changed. The source qualification reports the P4 shell
suite at 28/28 PASS; it was not rerun during this integration.

Integration validation: `pnpm typecheck` PASS; Biome on the shell source and
test files PASS; `git diff --check` PASS. Heavy tests were not run.

## Final CLI and core timeout updates

Cherry-picked `172841ab` followed by `e70947bb` onto the sandbox-integrated
HEAD. The CLI copy/reopen qualification reuses the validated P38 preview
template when available, retains the digest/signature checks and self-contained
preview fallback, and raises that case's bound to 1,200 seconds. The operator
child-process cap remains 1,800,000 ms (30 minutes). No changes were made to the
shell's shared sandbox environment projection.

The core timeout repair gives the affected P5/MAC/P13/P14 suites and cleanup
hooks bounded 120-second limits, the P40 schema-42 template setup a 300-second
limit, and bounded retries for scratch-directory cleanup. Assertions and
production semantics are unchanged. Both cherry-picks applied without
conflicts.

Imported result reports record the CLI copied-target reopen case PASS (1/1,
157.74 seconds), the complete operator test file PASS (10/10, 1,334.69
seconds), and focused core timeout qualifications PASS (10 files / 16 tests).
These source-branch runs were not repeated on the integration branch and do
not claim a full repository check.

Integration validation: `pnpm typecheck` PASS; Biome on all 11 changed
TypeScript/JavaScript/JSON files PASS; `git diff --check` PASS. No tests were
rerun.

## Web attention fixture revision correction

The full check at the final-timeout HEAD had one Web test failure: the
forbidden-control source scan flagged a bare numeric `targetWorkRevision` in
the attention page fixture. Reused the existing typed `workDetailCurrent`
fixture's revision instead. The source-scan rule and coverage were left intact,
and no command or production behavior changed.

Focused verification: `no-forbidden-controls.test.tsx` — 8/8 PASS; Biome on
`apps/web/src/pages/attention/fixtures.ts` — PASS; Web typecheck — PASS;
`git diff --check` — PASS. No full check was rerun.

## Scientific functional-test infrastructure and P4/R3 qualification

Cherry-picked the requested functional schema-42 baseline and cleanup
(`639a5fb7`, `1ce7ffc7`), scientific test-tier proposal (`99adab0f`), unified
P4 store-crash qualification (`acc848b9`), exact R1 runner chain
(`8b06d24c`, `c59a4c17`, `dbedf73d`), R2 port-safe fixture chain
(`f96aee24`, `c79d2d19`), and R3 lease qualification chain
(`8ce7cc48`, `275ea886`). The proposal, result records, test manifest and
runner documentation are retained. No sandbox governance dirty landing was
included.

Functional process fixtures now start from the shared schema-42 template and
private clones with owned startup/cleanup. The R2 handshake uses child PID,
nonce and actual reported port; restarts require the old child to exit and
reject a custom child that reports a different requested port. R3 replaces
most real-time lease-expiry waits with an owner-bound exact-tuple CAS while
retaining the specified natural-expiry sentinels and the P9 dense-SSE
wall-clock case. The P4 process-crash test now covers unified approvals.

Cherry-pick conflict resolution: only
`tests/functional/support/production-fixture.ts` conflicted during R3 P37
diagnostic integration. Kept R2's requested-port parameter and rejection
check, and merged R3's bounded stdout-line/lifecycle-marker diagnostics. The
existing fixture stdout listener already forwards callback lines, so the
incoming duplicate `onLine` callback was omitted to avoid duplicate diagnostic
capture while preserving safe handshake evidence.

Focused validation on this integration branch:

- `pnpm typecheck` — PASS.
- Biome on changed TypeScript/JavaScript/JSON files — PASS (47 files
  processed).
- `pnpm test:manifest` — PASS, 6/6; manifest validator reports **48**
  functional Vitest files and **6** UI files. The first attempt caught the
  newly added R2 handshake file missing from the manifest; the runner startup
  probe then exited during manifest validation before launching its fake
  package-manager process. Added the file to the smoke and full inventory,
  updated the validator/test count to 48, and the complete manifest self-test
  passed on rerun.
- Lease/helper unit tests — PASS, 2 files / 9 tests.
- R2 production fixture port handshake — PASS, 1 file / 6 tests in 123.60s.
- P4 unified-approval process-crash case — PASS, 1 file / 1 test in 58.79s.
- `git diff --check` — PASS after the result and manifest updates.

The source result retains the R3 RAI-DG-01 red findings; these focused results
do not establish full 48-file functional or release qualification.
