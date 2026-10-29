# Cross-platform test child process cleanup

Status: **PASS — architecture oracle updated and owned process trees are cleaned up by platform**

The architecture failure was an expired source assertion. Its expected
`killWindowsProcessTree(child, timeoutMs)` call used the pre-seam signature;
the implementation now lives in `tests/functional/support/daemon-process-lifecycle.ts`
and calls the Windows cleanup with its timeout and test seam. The Windows
cleanup itself was not regressed by the recent changes: commits `d591f7ad`,
`927f251f`, `104dd381`, and `aa3ec77f` separate taskkill and target-exit
deadlines, retry failed tree kills, require evidence before accepting cleanup,
reap timed-out helpers, and preserve uncertain outcomes as failures.

Review found a separate Unix gap: stopping a child only killed its PID, while
daemon launches did not create an isolated process group. Unix cleanup now
sends SIGKILL to the owned child's process group, then polls group visibility
until `kill(-pgid, 0)` reports `ESRCH`. It completes only after both the direct
child has exited and the group is drained. Visible groups receive another
SIGKILL on each bounded poll; `EPERM` and other probe errors fail closed, and a
stable timeout error is reported if the process group remains visible.
Production fixture daemons, additional daemons, the S1–S4 daemon, and the real
tree-test parent create isolated groups on Unix;
Windows spawn behavior remains unchanged. The shared real process-tree test
now runs on both platforms. Its Unix grandchild inherits its parent's group,
while on Windows it remains a child process for `taskkill /T` to terminate.

The architecture test now checks platform cleanup mechanisms and requires the
real process-tree qualification to run without a Windows-only skip.

## Evidence

- Architecture target: **4/4 PASS**.
- Lifecycle support functional file on Windows: **30/30 PASS**, including the
  real Windows parent/grandchild cleanup test, Unix delayed-drain/ESRCH/EPERM/
  timeout/repeated-stop cases, and all taskkill timeout, retry, target-first,
  helper-reap, and fail-closed cases.
- `pnpm typecheck`: PASS.
- Biome and `git diff --check`: PASS.
- WSL Ubuntu process-group smoke: SIGKILL to the isolated group removed both
  its leader and descendant. Linux Node is not installed in WSL, so the
  cross-platform Vitest process-tree case was not executed there in this run.

No full functional or core suite was run.
