# P4 / P12 Shell Sandbox Environment Wiring

**Status:** COMPLETE

## Change

`createShellExecutor` now sets the shell subprocess `env` to
`sandboxEnvironment(process.env)` from `@arbor/ports`. The shared projection
preserves only `SANDBOX_ENV_ALLOWLIST`; ambient secrets and other unlisted
variables are not passed to the shell process.

The P4 shell test injects a fake `spawnSync`, so it does not require either
PowerShell or Bash to be installed. It verifies an allow-listed value is
inherited, `SECRET` and `API_KEY` are excluded, every passed key belongs to the
shared allow-list, and the existing cwd, timeout, and UTF-8 encoding options
remain present. The same test is independent of the host shell selection.

Source inspection found no other product-level sandboxed subprocess call
sites. Other `child_process` uses are confined to test, build, or qualification
helpers.

No OS sandbox mechanism or permission semantics changed.

## Verification

- `pnpm exec biome check packages/tool-runtime/src/tools/shell.ts packages/tool-runtime/test/p4-shell.test.ts` — PASS
- `pnpm typecheck` — PASS
- `pnpm exec vitest run packages/tool-runtime/test/p4-shell.test.ts` — PASS (1 file, 28 tests)
- `git diff --check` — PASS
