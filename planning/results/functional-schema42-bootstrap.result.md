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
- Biome on all 14 changed implementation/test/config files: passed.
- `git diff --check`: passed.

The full `pnpm test:functional` suite has not yet run against this clean
implementation commit. Its terminal counts and duration will be appended after
qualification.
