# AH10 AssignWork Real-Process Takeover Qualification

**Status: PASS for current-Workspace AssignWork on both sides of the old
generation's `FencingRejected` receipt transaction, plus the Committed-receipt
pre-Observation crash boundary; AH10 remains PARTIAL.** This result does not
close the remaining AH10 control-action matrix.

## Public setup and authorization

The isolated test
`tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts`
uses the production fixture and public `CreateProject`, `GrantPermission`, and
`AssignWork` commands. A scoped, expiring `WorkspaceAgent` grant binds the root
Workspace, `core.control.assign-work`, and that same Workspace as target. The
model-facing `assign_work` omits `targetWorkspaceRef`, so its runtime target
matches the grant exactly and CAPA authorizes the action before the canonical
handler. No RootConversation tool or ApprovalRequired path is used.

The test creates an initial root `WorkspaceWork` episode through public
`AssignWork`. Its real Provider decision emits a complete `assign_work` action
for the current root Workspace. Two independent production daemons share the
same database and Provider boundary; the test uses the existing AH10 child
gates and production 30-second lease. Lease and command state are never written
directly by the test.

## Crash boundaries

Both cases preserve the same ProviderTurnId, LogicalActionId, and `callRef`.
Generation 0 is paused after durable ActionIntent and at the lease-renewal
boundary. After its lease expires, generation 1 acquires the same Execution and
pauses at the same pinned ActionIntent.

- **Before receipt commit:** releasing generation 0 pauses its real
  `FencingRejected` receipt inside the Gateway transaction. An independent
  read-only SQLite connection sees no terminal receipt, target Work, or
  `WorkAssigned` event. Killing the old daemon rolls back the transaction;
  those facts remain absent. Generation 1 then commits the target Work once.
- **After receipt commit:** generation 0 commits a
  `TerminalRejected(FencingRejected)` receipt. The test observes that receipt
  while confirming the target Work and event are absent, then kills the old
  daemon. Generation 1 reads the prior receipt and commits the target Work
  under a distinct generation-specific CommandId.

## Assertions

- Both generations retain the exact ProviderTurnId, LogicalActionId, and
  `callRef`; the old attempted CommandId differs from the gen1 Committed
  CommandId.
- The final canonical state contains one target Work and one matching
  `WorkAssigned` event, caused by the unique Committed receipt.
- Before-commit has no persisted old FencingRejected receipt after the kill;
  after-commit has exactly one.
- The pinned Action is Applied, its Observation is unique, and the ProviderTurn
  has one successful Attempt. The Provider did not recompute the decision.
- The recovery daemon reports no errors.

## Committed Receipt Recovery

A separate real-process case uses the same public setup and exact CAPA grant.
The gen0 owner is released while its lease is live, allowing the canonical
AssignWork Command to commit. The existing test-only
`AH10AfterControlHandlerReturnBeforeObservationCommit` gate then pauses the
daemon after the committed receipt, target Work, and `WorkAssigned` event are
durable, while the Agent action is still Pending and has no Observation.

The old daemon is killed. After the persisted lease expires, gen1 acquires the
same Execution and reaches the same pinned ActionIntent. Receipt-first recovery
converges the existing Committed result: the CommandId, Work row, and event are
unchanged; no second canonical Command or Provider request is made. The action
becomes Applied with one Observation.

## Verification

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts
3 tests passed (3/3; 109.07s total duration)

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts -t "Committed AssignWork receipt"
1 test passed, 2 skipped (36.12s total duration)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed

pnpm exec biome check tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts
passed
```

The qualification covers current-Workspace AssignWork and the listed receipt
crash boundaries only. It does not cover direct-child placement or other AH10
control actions.

## Independent integration revalidation (2026-10-08)

On base commit `904a3f9`, the process file was independently rerun: 3/3 passed
(108.00s). Complete `pnpm check` passed with Biome 946 files, TypeScript
typecheck/build, architecture 30 files/155 tests, core 315 files/1708 passed
+ 3 skipped, and Web typecheck/build plus 31 files/216 tests. The full release
functional batch and F20 are to be rerun after this test/documentation commit;
AH10 remains PARTIAL.
