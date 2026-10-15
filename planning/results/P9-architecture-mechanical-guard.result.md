# P9 architecture wiring guard

Status: **PASS**

The P9 regression guard previously expected the `architecture` package script
to contain `tests/architecture`. That path belongs to
`vitest.architecture.config.ts`; the script correctly invokes Vitest with that
config. The guard now parses the script's `--config` argument, verifies the
resolved config file exists, reads its include/exclude glob patterns, and
checks that every current architecture test file is included and not excluded.
It also verifies `pnpm check` has an exact `pnpm architecture` step.

## Evidence

- P9 acceptance tests: **11/11 PASS**, one worker.
- Architecture boundary target: **4/4 PASS**, one worker.
- `pnpm typecheck`: PASS.
- Biome and `git diff --check`: PASS.

No full test suite was run.
