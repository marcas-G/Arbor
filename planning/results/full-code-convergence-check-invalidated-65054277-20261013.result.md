# Full Code Convergence Check — Invalidated Partial Run

Date: 2026-10-13 (Asia/Shanghai)

## Disposition

This run is **INVALIDATED / INCOMPLETE**, not a completed `pnpm check` result. It began once at code HEAD `650542772452272356eb4d6d9774924bd4b6f15a` in the clean `codex/full-code-convergence` worktree. During the run, the orchestrator reported concurrent source edits/commit activity in this same worktree and directed that the check be stopped rather than used as evidence. No source changes were made by this qualification task.

The existing check session was sent Ctrl+C at the orchestrator's direction. Session 90554 returned exit code 1 from interruption; there is no terminal Core Vitest summary and no full-check verdict. Do not report the partial case output as a completed suite failure count. At cleanup, the observed HEAD was still `650542772452272356eb4d6d9774924bd4b6f15a` and the worktree was clean except for this invalidation record before it was committed.

## Partial progress observed

- Biome checked 1,111 files with no errors and one existing warning at `packages/agent-runtime/src/model-decision.ts:4070`.
- Root TypeScript build and test typecheck passed.
- Architecture Vitest printed 31 files / 159 passing tests.
- Core Vitest started and printed multiple failing case/file summaries, including the S1–S4 public API, P12, P13, P38, P39–P42 prefix, F21, Blocked, P5, and MAC/Wave 2 tests. This is only an interrupted snapshot; the suite did not reach its final summary, so no aggregate Core count is asserted here.
- Web typecheck, Web build, and Web Vitest were not reached.

The partial output included a child-process message that `Get-Acl` could not autoload `Microsoft.PowerShell.Security`. This is retained as raw diagnostic output only; no single root cause is assigned to all observed failures.

## Stop and cleanup

- The exact Vitest runner observed was PID 2976 with its children. Ctrl+C was sent through the original check session; subsequent process inventory found no remaining runner/worker for this worktree.
- `planning/results/P12.restore-drill.json` was restored to the version in the starting HEAD. Its Git object is again `94e90a8584e252300c1c8b0a80d60ffb098677b0`; restored working-file SHA-256 is `350B05B358D6B188E7317AC4F14FBE74BD82FD7D79011B4BCE8EBBF5341BE919`.
- The only untracked test database sidecar found after stopping was
  `C:\Users\ThinkPad\.codex\worktrees\full-code-convergence-release\Arbor\.arbor-p39-writer-650dffe795249f18518b610197aee7e4be03ac33c51c5534dae26d499e2ea7aa.sqlite`.
  It was created after this check started, no process still referenced it, and it was removed. No other sidecar was present. No live/preserved database, migration, deployment, or daemon service was accessed.
- The check was not rerun.

## Raw partial log

Retained at `C:\Users\ThinkPad\.codex\worktrees\full-code-convergence-release\Arbor\qualification-logs\02-check-65054277.log`.

- Length: 8,235 bytes.
- SHA-256: `4FFAF308C6C295A2A67D5F23BF9B957AF3C2A83774637C5B50E9B4CDC65425D6`.
- This file has no terminal Core Vitest summary because the session was interrupted.

This invalidation record documents the interrupted attempt; it does not qualify the current branch or supersede the prior release-gate boundaries.
