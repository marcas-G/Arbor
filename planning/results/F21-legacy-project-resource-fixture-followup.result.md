# F21 legacy Project resource-source fixture follow-up

Status: **test-fixture migration complete; production behavior unchanged.**

## Scope

Implemented in the independent `full-code-convergence-release` worktree, which
started at base `f56dd8691a08d6cd4d05cda3ac52777150ff3933`. The F21 fixture
source diff was tested at `fa8b60f7bd8fc4b439824b5f1e3f873c441d1587`, then
committed as `98f2801303baec07071dd3652da6a1778d795b28`. P41 test-layer
integration was committed afterward as
`48ba89058157bdd3661aa532e3c9614a7817ed40`.
The full-check diagnostics
identified old P38/CURRENT test schemas that omit `projects.resource_source_json`
or seed invalid historical JSON, causing the strict `ProjectRepository`
decoder to fail.

Added one shared test-only helper at
`tests/support/legacy-project-resource-source.ts`. For an isolated fixture DB,
it adds `resource_source_json TEXT` when the column is absent, then backfills
only NULL values to the canonical `{"_tag":"LegacyUnknown"}` value. Existing
non-NULL values, including explicit Profile selections and invalid values,
remain unchanged for strict repository decoding. The column is nullable and
has no default or check constraint. The helper is used from shared P1/P6/P7/P9/P10
fixture setup and the affected P2/P3/P11/P12 seed paths. Existing P1/P2/P6/P7
one-off schema patches now route through this helper.

Added `tests/legacy-project-resource-source-fixture.test.ts` covering all three
cases: NULL is backfilled, `Profile(ref, version)` survives repeated helper
calls, and an invalid non-NULL Profile encoding remains present and fails the
production `ProjectRepository` decoder.

No production decoder/repository behavior, Project source semantics, migration
registry, or `docs/design/**` files changed. Migration 0042 was not created or
registered.

## Verification

- `pnpm exec biome check` on the 25 changed test/fixture files — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Focused Vitest selection: 16 files, 113/113 tests PASS, covering the helper
  regression, P1, P2, P3-driver, P6, P7, P9 lease-expiry/provider-disconnect,
  P11, and P12 remote worker.
- `tests/p9-worker-crash.test.ts -t 'R5'` — 1/1 PASS; the ten unrelated cases
  were skipped.
- P9 worker-crash/lease-expiry/provider-disconnect/P10 attention selection —
  26/27 PASS. The remaining P9 W5 assertion observes duplicate escalation;
  the test does not fail on Project resource-source decoding.
- P10 functional full-rebuild selection — 0/2 PASS because each subprocess
  exits during the P39 Windows filesystem preflight: `Get-Acl` cannot load
  `Microsoft.PowerShell.Security`, yielding `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`.
- P3 integration was separately attempted before P41 optional-service wiring
  and was blocked by missing `RecoveryAttentionFactStore`. That fixture wiring
  was added by `48ba8905`; the P3 integration test passed in the post-port
  focused run. P12
  acceptance was blocked in its P39 filesystem-dependent cases; its
  source-fixture paths produced no `ProjectRepository/decodeResourceSource`
  failure.

Independent re-review of the B1 NULL-only backfill and regression test at
`fa8b60f7bd8fc4b439824b5f1e3f873c441d1587`: **Blocking = 0**. The reviewer
confirmed that Profile values survive helper re-entry and invalid non-NULL
values remain subject to strict decoding; review-only, with no tests run.

Post-integration verification at `48ba89058157bdd3661aa532e3c9614a7817ed40`:
the P2 driver, P41 source-absence, and domain event catalog suites pass 15/15.
The combined P2/P3/P9 touched-suite selection passes 33/34, with only the
pre-existing P9 worker-crash W5 duplicate-escalation assertion failing. The
F21 non-ACL focused selection (legacy-source fixture, P1/P2/P3/P6/P9/P11/P12)
passes 11 files / 87 tests. `pnpm typecheck` passes and Biome passes all 26
changed TypeScript files. No full `pnpm check` or functional suite was run.

The P12 restore-drill test artifact was restored to its tracked timestamp and
hash after test execution. These results qualify the fixture correction only;
they do not claim a complete `pnpm check` or functional-suite pass.
