# P39 Windows ACL test environment

Date: 2026-10-13
Source fix base: `f56dd8691a08d6cd4d05cda3ac52777150ff3933`
Integrated fix commit: `8d23d150` (`test: fix P39 Windows ACL qualification fixtures`)

## Change

The test harness explicitly supplies Windows PowerShell's system
`PSModulePath`, including `Microsoft.PowerShell.Security`, to root and
functional Vitest processes and to P39's spawned lock-holder process. The
shared disposable-directory helper creates DACLs granting FullControl only to
the current SID, SYSTEM, and Administrators. Cleanup grants the current SID
recursive FullControl with `icacls.exe` before deleting test-owned directories;
this edits DACLs only and does not require `SeSecurityPrivilege`.

P39 migration ACL qualification cases, the writer-lock process suite, and the
Blocked restart qualification skip explicitly when Windows PowerShell cannot
load `Get-Acl`. SQL-only P39 tests remain enabled. The hard-link fixture now
checks its protected-store alias case before creating a hard link to the
primary; that keeps the cases independent. The hard-link denial asserts the
implementation's typed `P39_UNSUPPORTED_DEPLOYMENT` result, while a separate
protected-store alias continues to assert `P39_REPORT_DB_PATH_INVALID`.

No production guard, migration registry, database, design document, or live
service was changed.

## Verification

- P39 persistence targets: 4 files, 22 tests passed. This includes all four
  Windows ACL-dependent migration cases and the P39 SQL/store cases.
- P39 cross-process writer exclusion: 3/3 passed; no teardown `EPIPE` errors.
- Blocked WorkEpisode restart qualification: 2/2 passed.
- `pnpm typecheck`: passed.
- Biome on all seven changed TypeScript/config files: passed.
- The writer test left one untracked artifact in the integration worktree root:
  `.arbor-p39-writer-650dffe795249f18518b610197aee7e4be03ac33c51c5534dae26d499e2ea7aa.sqlite`.
  It was confirmed test-generated, not tracked or ignored, and removed after
  the test process exited; the worktree is clean.

These targeted results address the Windows ACL environment failures and do
not establish a full release check; the integrated branch full check is run
separately after this record is committed.
