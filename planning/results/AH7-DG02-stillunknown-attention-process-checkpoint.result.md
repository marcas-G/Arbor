# AH7-DG-02 StillUnknown ActionResult process checkpoint

Status: **Static checkpoint only. No process qualification PASS is claimed.**

Added two StillUnknown-specific real-process cases for the interval after the
P9 `ReconciliationEscalated` event commits and around the P3 ActionResult
commit:

- `AH7BeforeActionResultCommit`: P9/P10 evidence must already be visible while
  the P3 Action remains Pending and has no ToolResult; kill and restart must
  then converge P3/P2 without a second P9 event or P10 row.
- `AH7AfterActionResultCommit`: P9/P10 evidence and the P3
  `ReconciliationPending` / `OutcomeUnknown` ToolResult must be durable before
  kill; restart must retain one identity of each and settle the Execution as
  OutcomeUnknown.

Both cases assert the P4 StillUnknown fact remains a single unsettled P4
invocation, the P39 fact and P9 fingerprint are unique, P10 has one
ActionRequired row on the exact owning Workspace, the final P3 action and
ToolResult are unique, and external executor/effect counts are zero. They are
separate from the P4 terminal-settlement matrix.

## Static evidence

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS; Vite emitted `apps/web/dist/index.html`
  and the hashed JS/CSS assets.
- Confirmed generated `packages/execution-runtime/dist/recovery.js`,
  `packages/agent-runtime/dist/agent-loop-actions.js`, and Web dist assets are
  present.
- `pnpm typecheck` — PASS before these static builds.
- Biome on the modified functional test — PASS.
- `git diff --check` — PASS.

The first attempted existing StillUnknown restart qualification failed before
scenario execution: production daemon readiness returned HTTP 503 for 60
seconds and the child exited with code 1 and empty captured stderr. No process
case is marked passing. The next run must collect complete child stdout,
stderr, and exit diagnostics if startup fails again, then stop.
