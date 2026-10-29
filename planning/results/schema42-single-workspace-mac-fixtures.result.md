# Schema 42 single-workspace MAC composition fixtures

Date: 2026-10-13

## Scope

Updated 12 current-composition test files under `apps/single-workspace/test/`:
Blocked WorkEpisode restart, I0 SendMessage, MAC-P1/P2/P3, P13 Web E2E, P14
conversation/history, and Wave 2 claim/completion. Each suite creates one real
P38 → P39 → P40/P41/P42 template; each case receives its own synchronous
Schema 42 database clone. P13 retains one suite-scoped clone because its live
transport tests share a daemon and conversation state.

No production code or `docs/design/**` changed. Fresh
`runMigrations(CURRENT_MIGRATIONS)` setup was removed from these files.

## Verification

- Targeted Biome on all 12 files: PASS.
- `pnpm typecheck`: PASS.
- `git diff --check`: PASS.
- Initial serialized 12-file Vitest batch: 10 files passed; 2 files failed
  under the default 30-second case deadline (23 passed, 2 skipped, 2 timed
  out). The blocked daemon calls took about 46 seconds; Wave 2 ClaimCompletion
  and DeclareDependency calls took about 48 and 44 seconds in focused reruns.
  Cleanup then encountered `EPERM` while timed-out effects still held SQLite.
- After setting 120-second deadlines and cleaning clones in `finally`, the
  blocked WorkEpisode file passed 2/2.
- Wave 2 passed 6/6 runnable tests; 2 historical cases remain skipped.
- The initial batch also reported `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT` in
  Wave 2 ProposeChildWorkspace; that reason did not recur in focused reruns.
  Template and clone ACL inspection found protected directories and
  database/report files with only the current SID, SYSTEM, and Administrators
  permitted.

The passing evidence is distributed across the initial 12-file batch and
focused reruns of the two files that exceeded the default deadline; no single
all-12 invocation completed fully green.
