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

## DecisionRequest takeover and workflow-signal settlement (2026-10-08)

The dedicated process test now also covers `SendMessage(kind=DecisionRequest)`
with the old generation's `FencingRejected` receipt killed on both sides of
its transaction commit. Setup is through public Project creation, direct child
Workspace creation and public child Work assignment. The child Provider emits
one ProviderTurn containing two sourced model calls: `send_message` with a
DecisionRequest body and no recipient, followed by a Manual `wait`. Runtime
derives the direct Parent recipient. Both generations retain the same pinned
ProviderTurn, LogicalActionId and callRef; only the command generation changes.

At the new daemon's ActionResult test gate, the canonical DecisionRequest,
`MessageSent`, Parent Message Inbox entry, Applied Action and Observation are
durable while the same project's workflow-signals offset is still behind the
MessageSent sequence. The test releases that explicit test-only gate, allowing
the same ProviderTurn's second Wait call to run and the child WorkEpisode to
settle. It then observes the same-project offset advance through MessageSent
and exactly one Parent InboxEpisode for `msg:<messageId>`. An earlier
diagnostic run that left the test gate closed only showed the expected
pre-poll offset; after release, the consumer and Parent admission both
progressed, so this is not evidence of a production consumer gap.

Assertions also cover one Message, one MessageSent event, one Parent Inbox
entry, null correlation, the committed result's
`promotion={closesCorrelation:null,triggersReevaluation:true}`, the new
generation's unique Committed receipt, one Action Observation, one successful
Provider attempt, exactly the two sourced calls (`send_message`, then `wait`),
and no workflow-signal dead letter through the target sequence. The Wait is
persisted as mode `Any` with conditions `[{'_tag':'Manual'}]`.

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

After the DecisionRequest extension, targeted validation passed:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
1 file / 5 tests passed (184.89s)

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts -t "takes over a DecisionRequest after killing gen0"
2 passed, 3 skipped (72.74s)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed

pnpm exec biome check tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
passed
```

That was dedicated-file and test-typecheck/Biome evidence at the targeted
checkpoint. Later integrated gates are recorded below.

## Integrated validation and test-oracle history (2026-10-08)

On committed `905c566`, this SendMessage file passed all 5/5 cases; the full
`pnpm check` passed (Biome 946 files, TypeScript/build, architecture 155, core
1708 + 3 skipped, Web 216). The first full `pnpm test:functional` run on that
commit failed only in AH7 B-effect: **24/25 Vitest files, 60/61 tests**. Its
ActionResult recovery oracle combined non-transactional `durableSnapshot()`
SELECTs and observed cursor 1 alongside later-committed B action/result data;
that is not a coherent durable state. SendMessage's five cases all passed in
the full run. Vitest failure prevented Playwright from running in that attempt.

AH7's test-only oracle was corrected in `84fec08` to read the Step, B Action,
P4 invocation/result, Observation, Artifact and Attempt through one explicit
read-only SQLite transaction; it requires cursor 2 and the unique B facts in
that same snapshot. On that commit F20 clean checkout (session 52737) passed
1/1 (44.37s), and the full functional run (session 50143) passed Vitest
25/25 files, 61/61 tests (1767.41s) plus Playwright 2/2 (22.6s). The full run
included SendMessage Query receipt pre/post, Committed Reply, and DecisionRequest
receipt pre/post cases; P9 dense SSE also passed. The DecisionRequest gate
intentionally holds before Wait, so its pre-release workflow offset lag is an
expected pause; after gate release, the same ProviderTurn's Wait settles the
child and the consumer admits the Parent InboxEpisode. AH10 remains PARTIAL.

## Targeted validation on `905c566` (2026-10-08)

On committed `905c566`, this entire SendMessage file independently passed 5/5
(185.60s). Complete `pnpm check` passed: Biome 946 files, typecheck/build,
architecture 30 files/155 tests, core 315 files/1708 passed + 3 skipped, and
Web typecheck/build plus 31 files/216 tests. The F20 committed clean-checkout
test passed 1/1 (45.02s). The full functional run on this same commit is the
24/25 files, 60/61 tests failure documented above; it stopped before
Playwright because of the unrelated AH7 B snapshot race.

The corrected AH7 oracle and final full functional pass are documented above
for `84fec08`: Vitest 25/25 files, 61/61 tests plus Playwright 2/2. The
DecisionRequest ActionResult gate intentionally holds the child before its Wait
action, so the project workflow-signals offset being behind `MessageSent` at
that point is expected. After gate release, the same ProviderTurn's persisted
Wait settles the child WorkEpisode, the offset advances through the target
event, and the unique Parent InboxEpisode is present. AH10 remains PARTIAL;
other message kinds/control actions and remaining governance gaps are not
covered.
