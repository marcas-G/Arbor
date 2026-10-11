# Submitted DecisionEpisode binding integrity — pending RED

Date: 2026-10-08

Status: **RED / governance decision required for terminal disposition; no
production change made.**

Test:
`tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`

## Fixture boundary

Each case begins with real public Project/Work setup and the real Scheduler
forming a DecisionEpisode. At the old daemon's `AH9BeforeTerminalActionCommit`
test gate, a read-only snapshot confirms that the original SelectCurrentWork
Command is Committed; its DecisionRequest is Submitted(B), revision 1; the
Workspace current Work is B; the Step is ActionsInProgress at cursor 0; and
the action is Pending with no Observation.

The isolated fixture then makes exactly one deliberate corruption in its
temporary database and proves the other relevant rows remain unchanged:

- Workspace binding case: changes `work_selection_decision_requests.workspace_id`
  to a second real Workspace created through public `CreateChildWorkspace`.
- Manifest binding case: changes the exact Step's `manifest_id` to another
  real `model_context_manifests.manifest_id` from the same database.

The old daemon is killed; the test waits for the actual gen0 lease expiry, then
starts an ordinary gen1 daemon. No lease, receipt, Command, Step or Action is
directly inserted or repaired.

## RED result

Command:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts
```

Result: **2 failed / 0 passed**, 94.00s. Both mismatch cases stop replay of the
pinned SelectCurrentWork ProviderTurn (its successful Attempt count stays
unchanged), issue no second SelectCurrentWork Command, and add no
CurrentWorkChanged event or target-Execution Observation. Gen1 does submit a
failed SettleExecution receipt. Both cases then reproduce the same terminal
orphan:

```text
Execution: settled_at set, settlement_kind = Failed
Step: logical_step_no=0 / repair_attempt=0 / original ProviderTurn,
      ActionsInProgress, revision=3, next_action_index=0,
      settlement_json=NULL
Action: action_index=0 / select_current_work / Pending,
        observation_source_ref=NULL
Observations for target Execution: []
```

The pre-crash snapshot and post-kill snapshot both show the valid original
Committed receipt, Submitted DecisionRequest and selected Work; only the test's
single binding field differs afterward. Gen1 obtains generation 1. No new
ActionIntent is observed for the pinned action; the failure path commits
`SettleExecution(Failed)` before leaving the Step/Action orphaned.

## Disposition

The new exact Workspace and Manifest guard is fail-closed and remains intact.
The uncovered defect is that `proposeSettlement(Failed)` persists a
`SettlementProposed` transition only for a `Prepared` Step, not an
`ActionsInProgress` Step. P3 `08`/P9 `07` prohibit returning from a live step
without coherent durable handoff, but the exact failure Action disposition or
Attention projection for a deliberately corrupted active binding is not
uniquely specified.

## P41 proposal revision for independent review (2026-10-11)

The coordinator's independent review returned **Blocking = 2**. Its review
artifact was not present in this worktree; this revision addresses the two
findings supplied in the delegation and does not claim a replacement review.
The revised proposal remains DRAFT:
`planning/proposals/agent-loop-submitted-binding-rejection-terminalization-draft.md`.
Without Stop it keeps P9 `RecoveryBlocked` plus public `ActionRequired`. It now
adds the existing authorized human `StopExecution` as the safe route to release
the otherwise occupied active slot. Stop-before-fact detection writes the P9
fact/event in the same `TransactionScope` as P3 Action/Step quiescence; if the
fact commits first, the later Stop consumes that same fact. P3 closes the
current control Action as `TerminalRejected` with a fixed Stop disposition,
closes later Pending rows as `SkippedEarlySettlement`, and persists
`SettlementProposed(Interrupted(StopRequested))` under the full current lease
fence. P2 requires no unresolved side-effect refs and settles only that
proposal through `RecoveryController`. The Committed receipt/canonical
selection remain unchanged; the P9 fact and P10 row remain public after
settlement. No automatic repair, resume, dismissal, or success claim is
introduced.

The two Blocking findings are addressed as follows:

1. **Migration/version collision:** f80ee91 is DID v1.36 / `user_version=35`
   (P35). The P36–P39 integrated design tree is
   `codex/governance-p36-p38-integration@5e5b1296f17cfa10ab90815f24d2d0f1afebcd9d`,
   DID v1.40; its result records that migration implementations/registration
   0036–0039 and qualification are not integrated. P40 is separately accepted
   in external commit `ce1cea5` with physical supplement SHA
   `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`; its
   acceptance says owner landing and cumulative migration-runner qualification
   are still blocked. The fixed allocation is **P41 / migration 0041**, after
   the ordered 0036–0040 prefix and its integration/qualification. The design
   target is DID v1.42 after unified DID v1.41. 0041 cannot be independently
   registered, implemented, run from v35, skipped, or released.
2. **Stop/quiescence:** permanent `RecoveryBlocked` alone conflicts with the
   P2 Stop path and leaves the Workspace slot occupied. The P41 package now
   requires fact-before-Stop and Stop-before-fact ordering; the latter writes
   the P9 fact/event and P3 Stop closure atomically. For a blocked selection,
   P3 closes the current Pending Action as `TerminalRejected` with a
   Stop-specific disposition, closes later Pending rows as
   `SkippedEarlySettlement`, and persists
   `SettlementProposed(Interrupted(StopRequested))` under the full lease
   fence. P2 RecoveryController may settle only after that proposal and an
   empty unresolved-side-effect source. Attention is retained and no old
   Provider/Command/action replay occurs. This pins the minimal P3 control
   Action stop-closure semantics; it does not add a new Action state or
   settlement tag.

The follow-up independent review identified one remaining Blocking: the P41
Attention source lacked P10 `04` source-specific rebuild semantics. The revised
proposal now adds this source to the P10 `02`/`05` Attention union and P10 `07`
Story O, and makes P10 `04` own a durable `submitted_decision_binding_attention_rows`
marker. Full rebuild resets the marker, takes one consistent P9 fact snapshot,
seeds one marker per fact, and rewinds the P1 Attention offset to `floor - 1`
in the same `BEGIN IMMEDIATE` / `TransactionScope`. The P9 event-id value has
no FK to the prunable journal; the P10 marker is FK-bound to the fact, so a
pruned event does not prevent fact-backed rebuild. The matrix covers retained
event replay, duplicate consumption, pruned-event reconstruction, rebuild
crashes before/after commit, and concurrent P9 fact creation before/after the
rebuild snapshot. P1 still owns the journal floor.

The same revision clarifies package ownership: P3 returns a typed mismatch or
pure Stop close plan and has no P9 store dependency. P2 RecoveryController
invokes the P9 Recovery/Application coordinator, which owns one transaction
across the P9 fact-store port and P3 `AgentLoopStepStore` mutations. The P10
rebuild/fact-snapshot and Stop/fact ordering remain proposal qualifications;
none were run here.

The fixed package also specifies a P9 post-0041 startup scan before the
settled-Execution short-circuit. It enumerates exact settled-Failed /
DecisionEpisode / `ActionsInProgress` / Pending-SelectCurrentWork rows, emits
audit-only Attention (specific mismatch code if still provable, otherwise
`SettledExecutionWithPendingDecisionAction`), and never resurrects or rewrites
them. A two-connection, two-process duplicate fact-writer race must produce one
immutable fact/event. The pending RED now invokes public `StopExecution` after
the fact-backed block and asserts that `Interrupted(StopRequested)` frees the
Execution while Attention remains. Stop-before-fact, crash boundaries, the
migration audit, and duplicate-writer qualification remain specified, not run.
The edited test was **not run**. No full functional suite or daemon was run,
and this tree changes no production or `docs/design/**` files.

Proposal SHA-256 over LF Git-clean bytes:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`.

The tests remain under `tests/functional/pending/`; do not count this expected
failure as default functional coverage or claim a green release batch. No
production or `docs/design/**` files were changed.

## Independent integration verification (2026-10-08)

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts
2 failed / 0 passed (92.73s; both failures are the expected orphan-state assertion)
```

The Workspace and Manifest cases independently reproduce the same persisted
state described above. The test is intentionally excluded from
`vitest.functional.config.ts` and the root Vitest config; it remains pending
manual disposition and is not a passing qualification.
