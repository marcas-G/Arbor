# AH10/P10 Attention schema-51 fixture checkpoint

Date: 2026-10-23

Baseline: `1e9fb611` in the `native-sandbox-preintent-integration` worktree.

The four historical Attention cases retain their P37 event/fact setup, then
upgrade the disposable database through the supported `37 → 44 → 51` offline
chain before calling current stores, public reads, or the daemon. The helper
checks the schema-44 boundary, final `user_version = 51`, P51 activation
highwater facts/digests, and `foreign_key_check`. No production code or event
registry changed.

The daemon marker helper now captures bounded stdout/stderr and waits for the
child close event before reporting an early exit or timeout, so startup causes
are included in a marker failure.

## Verification

- Four targeted historical cases: **4/4 passed**.
- Entire `ah10-p10-attention-materialization.functional.test.ts`: **14/14 passed**.
- Schema-42/schema-44 fixture tests: **6/6 passed**.
- `pnpm typecheck`: **PASS**.
- Biome on both changed test files: **PASS**.
- `git diff --check`: **PASS**.

All changes are test fixtures, assertions, diagnostics, and this checkpoint.
