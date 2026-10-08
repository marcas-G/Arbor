# Integration validation — Provider deadline, AH19 foundation, F22

Date: 2026-10-08
Implementation HEAD: `b8edd5d850c75f280861a8081de12622968a10fe`

## Committed work

- `f6513bd` — deterministic Provider Runtime deadline test barriers.
- `882b649` — AH19 Composition Root binding-fingerprint foundation.
- `b8edd5d` — FT-DG-02 Work Detail implementation and F22 qualification.

All three commits were pushed normally to `origin/codex/functional-tests`.

## Validation

- Provider Runtime integration file: 25/25 PASS. Both deadline cases also
  passed inside the full core suite.
- AH19 unit plus architecture tests: 8/8 PASS. This is foundation evidence;
  ProviderNative match/mismatch portable rebuild and Native checkpoint recovery
  remain open.
- P10 Work Detail/API suites: 48/48 PASS.
- Web Work Detail and renderer suites: 37/37 PASS. D0 Work Detail fixture
  guardrail: 6/6 PASS; the matrix now covers all ten ViewIds with three named
  variants each.
- F22 targeted Playwright: 1/1 PASS. The browser uses real Project/Workspace
  identities from two Projects; absent, foreign-Workspace and foreign-Project
  targets return identical non-disclosing 404 Problems. Each failed deep link
  issues only `work-detail`, without requesting `workspace-detail` or
  `verification` and without rendering the target objective.
- Full `pnpm check`: PASS — Biome 960 files; architecture 31 files/158 tests;
  core 318 files/1733 passed/3 skipped; Web typecheck/build and 31 files/223
  tests.
- F20 clean committed checkout: PASS 1/1 in 45.78s when run directly, and
  PASS again in the full functional batch (50.39s).
- P9 dense SSE lease-renewal qualification: PASS in the full functional batch.
- Full `pnpm test:functional`: PASS — Vitest 30 files/81 tests, Playwright 3/3
  (F14/F15, F22, and project conversation/restart), zero retries.

## Validation corrections retained

The first full-check attempt found a Biome export-order issue in the new
Work Detail export; the export was reordered. Two subsequent Web runs caught
stale D0 guardrails after the frozen view count became ten: first the expected
ViewId list omitted `work-detail`, then the unknown-lifecycle assertion
expected `weird-state` while that fixture intentionally supplies `Paused`.
Both were corrected from the fixture contract and the final complete check
passed. No product duration or test threshold was reduced.

`pnpm check` regenerated `planning/results/P12.restore-drill.json`; it was
restored with `apply_patch` to the tracked timestamp/hash. The completed full
functional run left no tracked working-tree changes. Existing unrelated
untracked real-provider evidence artifacts were not staged.

## Scope status

FT-DG-02 design and implementation plus F22 qualification are closed. F21 and
F23 remain separate open governance gaps. AH19 remains foundation-only; Native
match/mismatch rebuild and checkpoint recovery are not qualified. No files in
`docs/design/**` were changed.
