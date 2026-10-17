# AH7 Windows taskkill helper cleanup budget

Date: 2026-10-17

Status: **PASS for the requested cleanup-budget correction and focused AH7 case.**

The default Windows taskkill helper cleanup/reap budget now matches the
taskkill operation budget (10 seconds, previously 1 second). This gives a
delayed helper time to exit and be reaped so the second tree-kill attempt can
run. Tree cleanup still requires the taskkill/tree outcome to prove success;
direct-child exit alone does not establish that descendants were removed. The
existing 500ms cleanup-seam case continues to assert that an unreaped helper
leaves tree cleanup unproven.

Added a lifecycle regression case where the first helper exits after 1.25
seconds, with no cleanup-budget override. The helper is reaped, the second
taskkill attempt runs, and the test observes both target exit and descendant
removal.

## Verification

- `pnpm typecheck` — PASS.
- Biome on the two changed lifecycle files — PASS.
- `git diff --check` — PASS.
- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS.
- Focused lifecycle tests (delayed helper, existing 500ms unproven case, and
  independent taskkill timeout) — PASS, 3/3.
- `recovers Occurred across AH7BeforeActionResultCommit` — PASS, 1/1, 133.783s.

An initial unfiltered lifecycle-file attempt was stopped after unrelated real
daemon startup cases failed with HTTP 503 because the Web distribution had not
yet been built. After building Web, the three lifecycle cases relevant to this
change passed. The AH7 case was run after both builds and passed.
