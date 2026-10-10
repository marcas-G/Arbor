# F21/F23 architecture static-boundary migration

Status: completed on the isolated integration worktree; not pushed or merged.

## Scope

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Only the two architecture qualification files changed:

- `tests/architecture/p13-web-boundaries.test.ts`
- `tests/architecture/functional-test-boundary.test.ts`

No production code, docs/design, Web implementation, or F21 browser test body
changed.

## RED evidence

Before editing, the two original checks were rerun independently and failed as
expected:

- `p13-web-boundaries.test.ts` I3 rejected the new literal `/project-resources`
  as a non-whitelisted network URL.
- `functional-test-boundary.test.ts` F21 failed with ENOENT because it still
  referenced the old pending path
  `tests/functional/pending/ui-project-resource.spec.ts` after the test had
  moved into the default UI suite.

## Resolution

- I3 now adds only the exact `/project-resources` URL to the whitelist. The
  static assertion confirms the transport call carries Authorization and has
  no explicit method or body (the catalog request remains a GET). Other
  unknown network routes remain rejected; the existing `/commands`-only
  mutation-method and other boundary assertions are unchanged.
- The F21 boundary check reads
  `tests/functional/ui/f21-project-resource.spec.ts`. It continues to assert
  browser navigation and public client usage, explicitly recognizes its
  `/projects` and `/commands` public HTTP checks, and rejects direct SQLite,
  SQL, `SqlClient`, `DatabaseSync`, `CommandStore`, repository/application
  imports, and internal-layer shortcuts.

## Verification

- `pnpm exec vitest run tests/architecture/p13-web-boundaries.test.ts tests/architecture/functional-test-boundary.test.ts`
  — 2 files, 9/9 tests PASS.
- `pnpm typecheck` — PASS.
- Targeted Biome on both changed architecture files — PASS.
- `git diff --check` — PASS.
- No full `pnpm check` or functional run was repeated; the integration's
  full-check attempt remains blocked at Architecture pending this repair's
  independent review and the authorized next full gate.
