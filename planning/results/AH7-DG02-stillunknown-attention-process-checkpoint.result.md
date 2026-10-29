# AH7-DG-02 StillUnknown ActionResult process checkpoint

Status: **StillUnknown P9/P10 restart and P3 ActionResult crash qualification
PASS for the three listed process cases. AH7-DG-02 remains open.**

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

For terminal P3 `OutcomeUnknown`, `persistTerminalAction` now emits the
existing `AH7BeforeActionResultCommit` and `AH7AfterActionResultCommit`
qualification boundaries only when the action state is
`ReconciliationPending`. The Before probe runs after P9 recording and before
the terminal transaction. The After probe runs only after that transaction
successfully returns. This is test instrumentation around the existing
transaction; it does not change transaction contents or settlement semantics.

## Static evidence

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS; Vite emitted `apps/web/dist/index.html`
  and the hashed JS/CSS assets.
- Confirmed generated `packages/execution-runtime/dist/recovery.js`,
  `packages/agent-runtime/dist/agent-loop-actions.js`, and Web dist assets are
  present.
- `pnpm typecheck` — PASS after the production probe and unit-test changes.
- Biome on the modified functional test — PASS.
- `git diff --check` — PASS.

Process qualification, run serially with `vitest.functional.config.ts` and
zero retry:

- Existing StillUnknown restart: PASS, 1/1. A first run reached the Attention
  assertion but used internal source name `ReconciliationEscalated`; P10's
  frozen wire name is `RecoveryEscalation`. Correcting the view assertion made
  the targeted restart case pass.
- StillUnknown after P9 event / before P3 ActionResult commit, kill and restart:
  PASS, 1/1 (111.33 s).
- StillUnknown after P9 event / after P3 ActionResult commit, kill and restart:
  PASS, 1/1 (108.88 s).

The static checkpoint earlier in this record documents a prior daemon startup
503 before the rebuild preflight. After `pnpm build` and Web dist rebuild, all
three cases above ran to completion. No failure remains in these three cases;
they do not qualify the remaining AH7-DG-02 matrix or close AH7.
