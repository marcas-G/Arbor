# P9 architecture wiring guard

Status: **PASS**

The P9 regression guard previously expected the `architecture` package script
to contain `tests/architecture`. That path belongs to
`vitest.architecture.config.ts`; the script correctly invokes Vitest with that
config. The guard now accepts only a command beginning with `vitest run` or
`pnpm exec vitest run`, one `--config` with a non-flag value, and no shell
control syntax. It verifies `pnpm check` has a standalone `pnpm architecture`
step before a standalone `pnpm test` step, and checks config-path containment
using real paths.

The config is loaded with the installed TypeScript compiler API and inspected
as an AST. The guard requires `export default defineConfig({ test: ... })` and
unique direct `include` and optional `exclude` property assignments to static
string arrays. Comments cannot supply fields, and duplicates, computed keys,
spreads, and dynamic arrays fail closed. Vitest's installed `picomatch`
implementation checks every recursively discovered architecture test file.

Negative checks cover echo/pre-command prefixes, shell control syntax,
duplicate config flags, flag-as-config-value, a missing core-test step hidden
by a Web-test command, the wrong step order, a nested architecture test path,
comment-only fields, dynamic/computed/spread/duplicate config properties,
exclusion, and a config path outside the repository.

## Evidence

- P9 acceptance tests: **11/11 PASS**, one worker.
- Architecture boundary target: **4/4 PASS**, one worker.
- `pnpm typecheck`: PASS.
- Biome and `git diff --check`: PASS.

No full test suite was run.
