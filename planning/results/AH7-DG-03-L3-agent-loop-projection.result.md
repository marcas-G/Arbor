# AH7-DG-03 L3 AgentLoop projection result

Status: **L3 local persistence qualification PASS; AH7-DG-03 remains open.**

This layer follows accepted P3/P4/P9 contracts and stays in the independent
`ah7-approval-atomicity` worktree. It does not include L4 process recovery or
real daemon qualification.

## RED → GREEN and durable convergence

Four focused cases use the P3 AgentLoop driver over real SQLite stores:

- **Before action-result commit:** the local transition fault fires after the
  sourced ToolResult append but before the TerminalRejected action/cursor
  transition. The enclosing transaction rolls back: no ToolResult, action is
  Pending and cursor remains 0. Re-driving the same ProviderTurn/callRef reuses
  the simulated already-consumed approval on the same ToolInvocation identity,
  then commits exactly one ToolResult, TerminalRejected action, observation
  source, result ref and cursor 1.
- **After action-result commit:** the existing `AH7AfterActionResultCommit`
  probe interrupts after commit. Re-driving replays the durable result without
  calling the executable handler again; ToolResult count, Action refs and
  cursor remain exactly one.
- **NotAdmitted Interrupted:** a two-action batch returns Interrupted for the
  first executable call. AgentLoop persists `Interrupted(StopRequested)`,
  TerminalRejected for the first action, SkippedEarlySettlement for the second,
  two sourced ToolResults, and cursor 2; it does not invoke the second handler.
- **Control Denied compatibility:** Control Denied remains `Applied` with its
  existing ControlResult status/disposition and the batch continues. Only
  executable no-effect Denied becomes TerminalRejected. Before the route-aware
  fix, this assertion was RED because Control Denied was incorrectly marked
  TerminalRejected.

The AgentLoop harness simulates the already-consumed exact approval binding;
the SQLite/P4 real approval claim and source-revocation evidence remains in
`AH7-DG-03-implementation-l1.result.md` and
`AH7-DG-03-L2-authority-source-fence.result.md`.

## Gates

- Focused P3 driver selection: **1 file / 7 tests PASS** (34 unrelated tests
  skipped by test-name selection).
- `@arbor/agent-runtime` and `@arbor/single-workspace` builds PASS.
- Targeted Biome and `git diff --check` PASS.

No full suite, real two-daemon/crash test, L4 P9 recovery matrix, push or merge
was run.
