# Functional Schema 42 Bootstrap

Status: implementation and focused qualification complete; full functional
qualification is pending on the clean implementation commit.

## Changes

- Functional Vitest global setup creates one private schema-42 template from
  the real P38 → P39 → P40/P41/P42 upgrade path and publishes a validated,
  invocation-scoped manifest to workers. Playwright has a matching global
  setup. Global and worker cleanup handles normal teardown and Ctrl-C.
- Every production fixture clones independent primary and P39 report databases
  before daemon startup. Fixture databases live under an ACL-protected private
  worktree directory, and startup/stop failures clean up the clone and child
  processes. The live database is not used or modified.
- Daemon startup failures include bounded, redacted stderr diagnostics.
- Historical P32/P35/P37 production-daemon cases use exact historical
  migration prefixes and the official offline upgrade path to schema 42;
  there is no manual `user_version` assignment or daemon-side P39 upgrade.
- AH10 Query takeover starts gen1 while gen0 is actively renewing its lease,
  verifies gen1 has not acquired before expiry, then pauses gen0 renewal via a
  test-local marker. The test records the persisted gen0 expiry and verifies
  gen1's acquisition-event receive time is at or after that expiry, with
  generation 1 and the existing receipt/identity/uniqueness assertions intact.
  The outer Vitest budget is 180 seconds for this real two-daemon case; the
  actual 30-second lease and all internal probe bounds are unchanged.
- `startProductionFixture` now owns the private directory, clone and provider
  startup inside one cleanup boundary. A failure after cloning removes the
  directory; a failure after provider startup closes the listener and removes
  the directory. Provider listen errors reject startup cleanly. A test-only
  setup probe exercises both failure boundaries.
- Functional assertions continue to observe process behavior through the
  public API; SQLite reads are limited to test fixture setup/qualification
  evidence and are not used as a replacement public behavior assertion.

## P9 retained-fact / event-pruning contract

Frozen owner evidence is explicit across three layers:

- P9 `docs/design/implementation/P9/07-agent-loop-step-recovery.md` documents
  that a DeliverReplayEscalated fact's `event_id` is immutable audit identity,
  has no permanent FK to the prunable journal, and the fact retains exact
  Project, Execution, target, logical action, Message, failure code, first
  detection time and event ID. P9 validates the complete event witness when
  creating the fact.
- P10 Story M in `docs/design/implementation/P10/07-acceptance.md` and its
  Deliver rebuild contract in `docs/design/implementation/P10/04-rebuild-atscale.md`
  explicitly require pruning `DeliverReplayEscalated` while retaining the P9
  fact and proving the full rebuild still reconstructs one Attention row.
- P2 `docs/design/implementation/P2/02-port-contracts.md` §7.1 names
  `DeliverReplayFact` as a durable Work-readmission source, separately from the
  event-only `ReconciliationEscalationEvent`, and requires exact identity
  binding and fail-closed behavior for malformed/conflicting source evidence.

Together these contracts make the immutable DeliverReplayFact the durable
readmission witness after its event is pruned. This is not a design gap: the
fact/event creation transaction already verified the complete witness; when
the event remains present, the gate still validates every field and fails
closed on mismatch. Only an absent DeliverReplayEscalated event is accepted as
normal pruning; AssignWork still requires its event witness and
ReconciliationEscalated remains event-only. The gate additionally validates
the fact's Project/Execution/target/action/Message/failure identity and exact
canonical Work Episode binding, so the retained fact produces a blocking source
instead of an integrity error or `None`.

The public functional case checks Tree before pruning, then after pruning checks
both the P10 Attention row and unchanged public Tree `ActionRequired` count. A
persistence test covers the retained-fact hold and a negative test proves that
a present but conflicting event still fails closed. No event is restored, and
P2/P7 security gates are not weakened.

## Focused verification

- Exact P32 legacy-upgrade/AH10 case: 1/1 passed (124.925s test; 156.47s file).
- P10 prune/rebuild Attention case: 1/1 passed (48.6s); adjacent stale-source
  and real-daemon Attention/Tree cases: 2/2 passed (148.21s file).
- F21 exact-P35 full-rebuild cases: 2/2 passed (182.96s file).
- AH10 Query receipt takeover, both before/after receipt commit: 2/2 passed
  (246.36s invocation; test cases 110.719s and 86.147s).
- Committed Deliverable receipt-first takeover: first full diagnostic hit the
  90s outer Vitest timeout. A focused phase-timed run reached gen0 lease expiry
  at 70.96s and completed gen1 startup, lease acquire, same-Action recovery and
  all receipt/Observation/provider assertions by 88.83s; case passed at
  89.194s after setting only its outer budget to 180s. The real lease and
  internal 35s/45s/30s probe waits remain unchanged.
- Early fixture cleanup injection at `after-clone` and `provider-started`:
  2/2 passed (1.384s / 1.124s); the private directory is removed in both cases,
  and the opened provider port rejects connections after cleanup.
- After the readmission correction, persistence focused tests for retained
  fact hold and present-but-conflicting event: 2/2 passed (28.35s).
- After rebuilding dist, P10 post-prune public Attention + Tree case: 1/1
  passed (44.28s).
- Final single-worker cross-area batch: exact P32 1/1 passed (165.05s), P10
  post-prune Attention + Tree 1/1 passed (44.16s), F21 after-commit case timed
  out at its existing 90s outer budget under the preceding heavy batch load
  (92.41s observed). The same F21 after-commit case then passed standalone in
  89.426s. Earlier isolated F21 file run passed 2/2 (182.96s).
- `pnpm typecheck`: passed (`tsc -b` and test tsconfig).
- `pnpm build`: passed (`tsc -b`).
- Biome on all 16 changed implementation/test/config/result files: passed.
- `git diff --check`: passed.

## Diagnostic full run

The first full `pnpm test:functional` was launched from clean implementation
commit `639a5fb7b15ca84ed4eb60734199b02509e20624`. It was deliberately
interrupted after the AH19 file's case boundary because the run already had one
known timeout and the owner requested fail-fast sharding before another full
attempt. The one red was AH10 `recovers a committed Deliverable receipt when
its Action is still Pending` at 90.337s; focused timing and the subsequent
180s-budget focused pass above identify outer-budget exhaustion, not a behavior
assertion failure. The process teardown completed; one generated private root
left by the interrupted invocation was removed after confirming all child
processes had exited. This partial run is diagnostic only, has no qualification
counts, and did not reach Playwright.

The identified timeout passed focused after increasing only its measured outer
Vitest budget; the review's early-clone/provider cleanup gap is also closed
with two failure-injection cases. The exact non-pending functional manifest is
the 46 files matched under `tests/functional/process` and
`tests/functional/package`; `tests/functional/pending` is excluded. These files
will be run in disjoint, ordered shards on the next clean commit, with each
shard's exact file list and exit code recorded before one later complete
`pnpm test:functional` run. Neither this partial run nor the focused passes are
a release qualification.

## MAC-P4 unified approval crash-case correction

On the later clean SHA `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`, the first
G01 two-worker shard found that `agent-action-ah7-p4-store-process-crash` still
called legacy `ToolInvocationStore.consumeApproval` against the current unified
`action_approvals` ledger. The method deliberately returns false when that
ledger exists, so the child failed before its crash boundary with
`approval claim CAS lost`; the same failure reproduced standalone. This was a
test/fixture mismatch, not a production CAS failure.

The test fixture now runs P38 and seeds an exact current Executable approval,
Pending `agent_loop_step_actions` row and `ActionsInProgress` step per
invocation. The child uses the production P4 claim order—
`ToolInvocationStore.recordIntent` followed by
`ExecutableApprovalStore.consumeApproved`—inside one `TransactionScope`, with
the same invocation, approval, action, callRef, tool and lease identities.
Before-commit kill still proves neither intent nor consumption commits;
after-commit kill proves exactly one `NotAdmitted` invocation and one
revision-2 `Consumed` approval, and exact retry is idempotent. Denied and
Interrupted no-effect settlement assertions remain intact.

The P4 process-crash file passed focused 1/1 after the correction (26.901s test;
96.22s invocation). `pnpm build`, `pnpm typecheck`, and Biome on the changed
test/child files passed. No shards or full functional suite were run after this
correction.

The separately requested clean-checkout case on the same SHA `1ce7ffc7` ended
at 396.171s with nested black-box Vitest `SIGTERM` (status absent); its S1/S3
cases had passed before termination. This is recorded as the L4 package-runner
budget issue per owner direction and was not rerun.
