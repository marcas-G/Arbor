# P9 architecture wiring guard

Status: **PASS**

The P9 regression guard previously expected the `architecture` package script
to contain `tests/architecture`. That path belongs to
`vitest.architecture.config.ts`; the script correctly invokes Vitest with that
config. The guard now verifies `pnpm check` has a standalone `pnpm architecture`
step before a standalone `pnpm test` step. It resolves the architecture script's
`--config` path, checks realpath containment within the repository, then reads
the config's literal include/exclude arrays. Vitest's installed `picomatch`
implementation checks every recursively discovered architecture test file.
Computed include/exclude arrays fail closed.

Negative checks cover a missing core-test step hidden by a Web-test command, the
wrong step order, a nested architecture test path, dynamic include syntax, an
exclude pattern, and a config path outside the repository.

## Evidence

- P9 acceptance tests: **11/11 PASS**, one worker.
- Architecture boundary target: **4/4 PASS**, one worker.
- `pnpm typecheck`: PASS.
- Biome and `git diff --check`: PASS.

No full test suite was run.
