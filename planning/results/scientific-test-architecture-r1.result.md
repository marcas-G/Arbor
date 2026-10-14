# Scientific Test Architecture R1 Result

Date: 2026-10-14  
Base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`  
Scope: exact test inventory, profile definitions, validation, and serial runner. No `docs/design/**` files changed.

## Implemented

- Added `planning/testing/manifest.json` with exact, version-controlled file lists for L1 quick, S1–S4/public smoke, crash sentinels, clean-checkout package, UI, full functional Vitest, and full UI profiles.
- The manifest reconciles the configured inventory as 47 functional Vitest files (46 under `tests/functional` plus configured S1–S4) and 6 Playwright files.
- Added `scripts/testing/check-manifest.mjs`. It verifies exact config patterns, file existence, file-set equality, non-overlap between the configured Vitest and UI suites, profile group completeness, and release/all zero-retry/cache-off requirements.
- Added `scripts/testing/run-suite.mjs`. Profiles build the root and Web artifacts once, execute groups serially, stop on first failure, disable Vitest cache, set Playwright retries to zero, preserve logs, and write a machine-readable result manifest plus Markdown summary under `.test-results/`.
- Added quick, smoke, crash-sentinels, package, UI, release, all, and full-Vitest process commands. `pnpm test:functional` remains the full 47 Vitest + 6 UI release inventory; `test:functional:process` and `test:functional:ui` retain their respective complete subsets. The curated crash-sentinels profile does not claim all AH10 handlers or all AH1–AH19 qualifications.
- Added Node manifest/runner argument unit tests and ignored generated `.test-results/` artifacts.
- The package profile's outer runner builds the current checkout once. F20 still independently clones a clean checkout, installs from the frozen lockfile, and builds/runs inside that clone; the nested install and builds remain part of the package qualification.

The quick/smoke/crash profiles are explicit subsets of the current suites. They do not claim full release coverage. This R1 change introduces no case migration or assertion deletion and makes no runtime reduction claim.

## Verification

- `pnpm typecheck` — PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- `pnpm exec biome check package.json .gitignore scripts/testing/check-manifest.mjs scripts/testing/run-suite.mjs scripts/testing/manifest.test.mjs planning/testing/manifest.json` — PASS.
- `node --check` on the runner, validator, and manifest test — PASS.
- `pnpm test:manifest` — PASS (3/3 unit tests); validator reports 47 configured Vitest files and 6 configured UI files.
- `git diff --check` — PASS.
- Full quick/smoke/crash/package/UI/release profiles were not run in this R1 implementation task.

## Independent review follow-up

- Initial JSON and Markdown artifacts are written as a staged directory and atomically renamed into the result directory before Git, pnpm, or test commands start. The runner refreshes them atomically as commands progress and records caught SIGINT/SIGTERM, uncaught exceptions, or unhandled rejections as `interrupted`, with `completeCoverage: false` and the active command's exit/signal when available.
- Windows commands now use a resolved native pnpm executable or Node plus its pnpm JavaScript CLI with `spawn` argument arrays and `shell: false`. A temporary workspace whose path contains spaces verifies argument and cwd preservation.
- When `npm_execpath` is absent, Windows resolution enumerates `where.exe pnpm` results before scanning PATH. It resolves the fnm `SET dp0=%~dp0` shim by expanding batch variables, validates the referenced `pnpm.exe`, and never invokes a shell. The Windows runner test uses the active shim to run `pnpm --version` and a Vitest help command with a spaced `--outputFile` value.
- The curated profile is named `crash-sentinels`; its description states that it does not qualify every AH10 handler or all AH1–AH19 coverage. The old ambiguous `test:crash` command was removed.
- Build log names include a monotonically increasing stage index and stage/command labels, for example `01-build-root.log` and `02-build-web.log`.
- `planning/testing/README.md` states that F20 creates a separate clean clone, installs frozen dependencies, then builds and runs inside that clone; those nested operations remain part of package qualification.
- Follow-up checks: `pnpm typecheck` PASS; targeted Biome PASS; `pnpm test:manifest` PASS (6/6, including an injected CLI failure proving both initial artifacts exist before the first pnpm command, Windows argument-array coverage using a temporary workspace path with spaces, and an active fnm shim integration); Node syntax checks and `git diff --check` PASS. Heavy profiles were not run.

## Qualification boundary

This result qualifies the manifest and runner self-checks only. It does not qualify any application behavior, crash boundary, clean checkout, browser journey, or release. The release profile's `completeCoverage` is true only after both exact complete groups execute successfully during that invocation.
