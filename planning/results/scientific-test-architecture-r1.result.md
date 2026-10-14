# Scientific Test Architecture R1 Result

Date: 2026-10-14  
Base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`  
Scope: exact test inventory, profile definitions, validation, and serial runner. No `docs/design/**` files changed.

## Implemented

- Added `planning/testing/manifest.json` with exact, version-controlled file lists for L1 quick, S1–S4/public smoke, crash sentinels, clean-checkout package, UI, full functional Vitest, and full UI profiles.
- The manifest reconciles the configured inventory as 47 functional Vitest files (46 under `tests/functional` plus configured S1–S4) and 6 Playwright files.
- Added `scripts/testing/check-manifest.mjs`. It verifies exact config patterns, file existence, file-set equality, non-overlap between the configured Vitest and UI suites, profile group completeness, and release/all zero-retry/cache-off requirements.
- Added `scripts/testing/run-suite.mjs`. Profiles build the root and Web artifacts once, execute groups serially, stop on first failure, disable Vitest cache, set Playwright retries to zero, preserve logs, and write a machine-readable result manifest plus Markdown summary under `.test-results/`.
- Added quick, smoke, crash, package, UI, release, all, and full-Vitest process commands. `pnpm test:functional` remains the full 47 Vitest + 6 UI release inventory; `test:functional:process` and `test:functional:ui` retain their respective complete subsets.
- Added three Node manifest validator unit tests and ignored generated `.test-results/` artifacts.

The quick/smoke/crash profiles are explicit subsets of the current suites. They do not claim full release coverage. This R1 change introduces no case migration or assertion deletion and makes no runtime reduction claim.

## Verification

- `pnpm typecheck` — PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- `pnpm exec biome check package.json .gitignore scripts/testing/check-manifest.mjs scripts/testing/run-suite.mjs scripts/testing/manifest.test.mjs planning/testing/manifest.json` — PASS.
- `node --check` on the runner, validator, and manifest test — PASS.
- `pnpm test:manifest` — PASS (3/3 unit tests); validator reports 47 configured Vitest files and 6 configured UI files.
- `git diff --check` — PASS.
- Full quick/smoke/crash/package/UI/release profiles were not run in this R1 implementation task.

## Qualification boundary

This result qualifies the manifest and runner self-checks only. It does not qualify any application behavior, crash boundary, clean checkout, browser journey, or release. The release profile's `completeCoverage` is true only after both exact complete groups execute successfully during that invocation.
