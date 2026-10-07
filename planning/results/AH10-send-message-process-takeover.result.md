# AH10 SendMessage Real-Process Takeover Qualification

**Status: PASS for the covered SendMessage Query takeover on both sides of the
generation-0 `FencingRejected` receipt transaction and the Committed Reply
receipt recovery after Query correlation closure; AH10 remains PARTIAL.** These
cases do not close AH10 or qualify other SendMessage outcomes and crash
boundaries.

## Scenario

The isolated functional test
`tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts`
uses the production fixture, public `CreateProject`, `CreateChildWorkspace`, and
`AssignWork` commands, two independent production daemons, one SQLite database,
and the production 30-second lease. Both daemons use the existing test-only
`ah10-process-child.mjs` gates; neither the lease nor command receipt is written
directly by the test.

The child Work's single Provider decision calls `send_message` with `kind=Query`
and the exact parent Workspace as recipient. Generation 0 pauses after durable
ActionIntent and at the real lease-renewal boundary. After the persisted lease
expires, generation 1 acquires the same Execution and pauses at the same pinned
ActionIntent. The test runs two crash sides:

- **Before receipt commit:** releasing generation 0 pauses inside the real
  Gateway transaction after the fence rejection is written but before commit.
  An independent read-only SQLite connection cannot see the rejection receipt,
  Message, or Inbox entry. Killing generation 0 rolls back that transaction;
  the test confirms all three remain absent. Generation 1 then commits the
  Query once under its new generation-specific CommandId.
- **After receipt commit:** generation 0 commits the real
  `TerminalRejected(FencingRejected)` receipt. The test observes it and confirms
  there is no Message or Inbox entry, then kills the old daemon. Generation 1
  resolves that receipt before committing the Query under its own
  generation-specific CommandId.

## Assertions

- Both generations retain the exact ProviderTurnId, LogicalActionId, and
  `callRef`; the old attempted CommandId and generation 1's committed
  CommandId differ. The pre-commit case has no persisted old receipt; the
  post-commit case has exactly one.
- Exactly one canonical Query Message exists, from the child to the root, with
  a content-addressed body reference and persisted correlation ID.
- Exactly one root `Message` Inbox entry exists for `msg:<messageId>`, bound to
  the same correlation ID.
- The Action is `Applied`, there is one AgentLoopAction Observation, and the
  Provider was called once.
- The new daemon reports no daemon errors.

## Committed Reply Recovery

The Reply scenario first uses the ordinary production daemon and public
`CreateProject`, `CreateChildWorkspace`, and `AssignWork` commands to have the
child send a Query to the root. A real Provider response handles the exact root
Inbox input; the test waits until that Inbox entry is consumed and its
`InboxEpisode` settles, while the Query correlation remains open. It then kills
that daemon, restarts the same fixture with the existing AH10 child entrypoint,
and publicly assigns a root Work to reply to the one pending Query. A real
Provider response emits `send_message(kind=Reply)`.

The old owner is released while its generation-0 lease is still live. The
existing `AH10AfterControlHandlerReturnBeforeObservationCommit` gate pauses it
after the Gateway has committed the Reply Message, its `MessageSent` event,
recipient Inbox admission, and correlation closure, while the action remains
Pending and has no Observation. The old daemon is killed; after its persisted
lease expires, gen1 acquires that same Execution, reaches the same pinned
ActionIntent, and is released. Receipt-first recovery validates the old
Committed result against the canonical Reply, exact Query sender/correlation,
and closed correlation without issuing a new SendMessage command.

Assertions cover the unique Query and Reply Messages, their matching
`MessageSent` events and Command receipts, the two exact Inbox entries, one
closed correlation, Action Pending/zero Observation before the crash and
Applied/one Observation after recovery. The Reply ProviderTurn has one
successful Attempt and the real Provider is not asked to recompute that turn.

## Verification

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
3 tests passed (3/3; 114.70s total duration)

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts -t "recovers a Committed Reply"
1 test passed, 2 skipped (43.77s total duration)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed

pnpm exec biome check tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
passed
```

The Query qualification covers receipt transaction commit-before/after crash
boundaries. The Reply qualification covers the post-commit,
pre-Observation crash boundary after the Query Inbox is consumed and its
correlation closes. Other message kinds and AH10 control actions remain outside
this evidence.

## Integrated revalidation (2026-10-07)

Before this two-sided extension, the AH10 primary process file and this
SendMessage file were rerun together:
2 files / 8 tests passed in 301.41s. Full `pnpm check` also passed: Biome 943
files; TypeScript build and test typecheck; architecture 155 tests; core 1708
passed and 3 skipped; Web typecheck/build; Web 216 tests. AH10 remains PARTIAL;
this local run is not a full functional suite or phase-closure claim.

The prior `d5dca49` integration run predates this extension. The independently
rerun current SendMessage file passed 3/3 (114.70s). Current full check passed:
Biome 944 files, typecheck, architecture 30 files/155 tests, core 315
files/1708 passed + 3 skipped, and Web 31 files/216 tests. The isolated
SelectCurrentWork pending test remains a red test at gen1 lease acquisition;
the regular vitest config excludes `tests/functional/**`.

After commit `d5dca49` was pushed to `origin/codex/functional-tests`, the F20
clean-checkout test passed 1/1 (44.37s), followed by the complete
`pnpm test:functional`: Vitest 22 files / 51 tests passed (1427.87s) and
Playwright 2/2 passed (22.9s). These results include this Query case but do not
close AH10 or cover the remaining SendMessage kinds/boundaries.
