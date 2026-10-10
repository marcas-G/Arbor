# AH7-DG-03 implementation L2 result

Status: **L2 module scope PASS; overall AH7-DG-03 remains open.**

L1 is committed as `fa732378e32e8949d39fa68b637418c2b6939e99`. L2 follows the
accepted contract landed at `5cab270642f3a738f1da3dcb846ce734d477f8b2` and the
L1 P36 storage boundary. Work remains isolated to
`C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor`.

## RED → GREEN

The deterministic approval re-entry test was extended to assert that an
effect-admission gate runs before the Executor and that intent recording and
approval consumption share a transaction identity. Before the runtime wiring,
the focused test failed because the effect-admission call count was zero (the
old runtime did not call `admitEffect`).

After implementation, focused P4 adapter/migration and ToolRuntime tests pass:

```text
Test Files  9 passed (9)
Tests       28 passed (28)
```

The new pipeline assertions cover:

- pre-consumption resource and missing-approval denials produce stable typed
  Denied results, write a no-effect terminal record, and do not consume approval
  or enter effect admission;
- a valid approval is claimed with its intent before the separate effect gate;
- a post-claim effect-gate denial settles as
  `ApprovalNoLongerAuthorized`, keeps the approval bound to the exact
  invocation, and never opens the Executor;
- same-invocation approval re-entry records intent and consumes only once in
  one transaction scope, then gates each attempt before execution.

The focused SQLite store/migration tests additionally verify same-transaction
claim rollback/competition and that Denied persists its typed code with the
version-1 projection identity. The runtime maps stored Denied to a fixed
version-1 bounded observation rather than mutable current policy text.

## Implemented L2 boundaries

- `ToolRuntime` wraps intent plus conditional approval consumption in one
  transaction; a lost CAS rolls back the intent before writing the separate
  no-effect Denied record.
- Authority and approval are re-read/rechecked before fenced effect admission.
  `NotAdmitted` may become `MayHaveStarted` only through that gate, before
  Sandbox/Executor. Stop after claim converges to P4 Interrupted; stop before
  claim leaves no P4 row. A prior terminal Denied replays its stored code;
  `MayHaveStarted`/`LegacyUnknown` is never rewritten as no-effect Denied.
- `ExecutableToolHandler` carries fixed Denied/ExecutionStopping dispositions.
  AgentLoop records no-effect Denied as `TerminalRejected` and advances the
  action cursor; Interrupted uses the P3 stop settlement path, skips remaining
  actions and proposes `Interrupted(StopRequested)`.
- P4 Denied JSON carries `projectionVersion: 1` alongside the closed reason
  code.

## Gates and remaining qualification

Passed:

- `pnpm --filter @arbor/persistence-sqlite... build`
- `pnpm --filter @arbor/tool-runtime build`
- `pnpm --filter @arbor/agent-runtime build`
- `pnpm --filter @arbor/single-workspace build`
- targeted Biome check on the changed TypeScript files
- `git diff --check`

No full `pnpm check`, full functional suite, real two-process test, crash/restart
matrix, push, or merge was run. Those are not L2 evidence. L3 AgentLoop durable
projection qualification and L4 P9 real-process/crash recovery remain gated and
open. No new contract gap was identified in this layer.
