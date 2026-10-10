# AH10 DeliverMessage Generation Fence and Attention — Implementation/Test DAG

Status: **planning only; no implementation started or authorized by this task**

## Objective and fixed design boundary

The AH10 Deliver design is **design-closed** at DID v1.38 after its independent
post-landing review reported Blocking = 0. This DAG executes no new semantics:
it follows the accepted DeliverMessage/1 route and P9 receipt-first/legacy
proof, then the accepted P9 fact/P10 marker projection and qualification.
Ordinary `SendMessage`, `MessageSent(v1)`, and the MessageSent-only
`ChildDelivered` wake source stay unchanged. No synthetic wake row is written.

The AH10 tree is still at P35/user_version 35. Accepted AH7/P36 migration
0036 is present only in its isolated tree and must be integrated before P37
can be implemented or released. This DAG does not merge P36 or implement P37.

## Start gates

1. **Functional terminal gate:** wait for the coordinator to report the
   current functional run's terminal result and workspace/resource release.
   This planning task did not run, poll, or infer that run's state.
2. **AH7 L4 gate:** wait for status/result from
   `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\tasks\AH7-DG-03-L4-process-matrix.md`.
   At this planning snapshot, AH7-DG-03 has recorded L1/L2/L3 results, but no
   matching L4 result file was present; its overall status remains open.
3. **Schema integration gate:** the target implementation tree must contain
   the accepted P36 migration as ordered `0036`, with v35→v36 qualification.
   P37 is permitted only as the next ordered migration after that integrated
   P36. No implementation phase below starts before these gates and a fresh
   tree/status check.

## Layered DAG

| ID / dependency | Exact first RED and minimum assertions | Qualification boundary | Can be pre-done before P36 integration? |
|---|---|---|---|
| **G0 — wait for shared gates** | No new RED. Capture the current functional terminal result and AH7 L4 state; do not infer completion from old green results. | Coordination/read-only evidence only. No test execution. | **Planning only.** No implementation/test run. |
| **L1 — AH7/P36 prerequisite** (external owner; blocks L2) | Use AH7's existing `p36-ah7-tool-invocation-state-migration.test.ts` and accepted AH7 L4 matrix. RED is not recreated in AH10: the prerequisite is a target-tree migration-registry check showing P36/0036 is absent or not qualified. Record that it maps old invocation state to `LegacyUnknown`, as the accepted AH7 L1 result states. | P36 owner's L1/L2/L3 plus its actual L4 process result; AH10 does not claim those qualifications. | **No in AH10.** Only read/plan; P36 schema ownership belongs to AH7. |
| **L2 — P37 P9 fact + P10 marker storage** (after integrated L1) | Proposed deterministic REDs: (a) migration registration/version assertions show no ordered `0037` and no `deliver_replay_attention_rows`; (b) migrated `user_version=36` lacks the marker/FK; (c) marker insert without P9 fact is rejected and a second marker for the same `attentionFactId` conflicts; (d) P9 fact/event retry creates exactly one fact/event; (e) P10 projection query has no Deliver row in the union despite the P9 fact. Exact migration paths: v33→34→35→36→37, v35→36→37, v36→37; assert no standalone v35→37 and no change to 0034–0036. | L1/module: file-backed SQLite migration, P9 fact-store transaction/dedup, P10 marker/query module. Separate before/after `TransactionScope` assertions for P9 fact+event and P10 marker+offset; **not** real process-kill evidence. | **No implementation or authoritative schema qualification.** Only test-case/fixture specification can be drafted; final fixtures must start from integrated P36. |
| **L3 — DeliverMessage/1 decoder + Gateway handler** (after L2) | Existing historical RED is `tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts`: its direct `deliverHandler` gen0 call after gen1 lease currently observes a failed handler exit **but one Message, one MessageSent and one Inbox row**; its same-generation repeat fails on uniqueness and is not receipt replay. Minimum new deterministic RED must traverse the production CommandGateway route: gen0 stale submission returns the stored `FencingRejected` outcome and writes zero Message/Event/Inbox; gen1 uses the same stable MessageId with generation-scoped DeliverMessage CommandId and commits exactly one Message + exact `MessageSent(v1)` + Inbox summary. Also reject malformed/extra codec fields and keep ordinary SendMessage receipts untouched. | L1/module: strict DeliverMessage/1 codec, CommandGateway tuple/fence/receipt transaction, Deliver handler write-set. Does not prove daemon takeover. Preserve the pending direct-handler case as the initial bypass reproduction; do not mark it green by changing its expected side effect. | **Not in this ordered DAG.** Pure decoder/RED descriptions may be drafted, but implementation waits for L1/L2 and G0. |
| **L4 — P9 receipt-first and legacy proof** (after L2+L3) | Proposed module RED matrix, each exact fixture uses the pinned action and stable MessageId: (a) exact prior DeliverMessage/1 Committed receipt plus exact Message/Event converges without handler replay; (b) strict receipt decoder/result mismatch fails closed with `PriorReceiptDecodeMismatch` / `PriorReceiptResultMismatch` as specified; (c) receipt absent enters legacy proof only; wrong/duplicate Message or MessageSent tuple—including project, aggregate, type, version, complete payload or `caused_by_command_id != legacyDeliverCommandId(providerTurnId,outputPosition)`—returns `LegacyMessageBindingMismatch`; (d) extant Inbox wrong key/kind/summary/correlation/admittedAt is `LegacyInboxConflict`, while absent Inbox after consumption is accepted; (e) FencingRejected plus any contradictory effect produces `RejectedReceiptEffectConflict`; operational failure retries with the original CommandId only when no effect exists. Assert one immutable P9 fact/event and no Action Observation/Applied/second effect on blocked paths. | L1/module: receipt/result decoder, legacy evidence validator, P9 store and failure code/event tuple under deterministic SQLite transaction tests. This is not daemon crash qualification. | **No integrated implementation.** The P9 failure table and exact transactional evidence depend on L2/P37; only case lists may be drafted. |
| **L5 — P10 public Attention + wake consumer** (after L2+L4) | Proposed RED: with a durable P9 fact and consumed `DeliverReplayEscalated`, the frozen public Attention View currently returns no Deliver row. Assert exactly one `ActionRequired/DeliverReplayFailure`, target=Execution Workspace, `dedupKey=attentionFactId`, typed failure code and accepted fixed safe summary; union with AssignWork/F21/derived sources preserves each once and subtree count is once. A pruned event plus retained fact still rebuilds the row. For successful delivery, assert `MessageSent` alone drives existing `ChildDelivered` consumer/wake; no fabricated wake row and no P9 failure fact. Assert P10 consumer marker and P1 offset share one transaction; F21 refusal and AssignWork rows remain unchanged. | L1/module projection/consumer/query tests first; then public read path through frozen Attention View and real consumer composition. Public qualification must not read private SQLite state as its oracle. The successful wake case verifies the existing MessageSent consumer, not a new wake contract. | **No** for P10 implementation or public qualification; both require P37 schema/fact source. Only assertion lists may be prepared. |
| **L6 — two-daemon commit-before/after and restart matrix** (after L1–L5 and both G0 gates) | Use two independent daemon OS processes on one file-backed SQLite DB. Matrix: (a) old gen0 `FencingRejected` transaction killed before commit → no durable receipt/effect, new gen1 commits once; after commit → new gen1 sees exact old rejection then commits once; (b) DeliverMessage Committed before Action/Observation commit → kill/restart, exact receipt-first convergence gives one Message/Event/Inbox/Observation and one Provider request; (c) P9 fact+event before/after commit kills → neither/both durable and one P10 Attention after restart; (d) P10 marker+consumer-offset before/after commit kills → neither/both and one visible row; (e) committed old receipt/effect contradiction after takeover remains ActionRequired, never silent success/replay. Assert exact CommandId/MessageId/LogicalAction identity, generation, receipt, action state, observations and counts from one coherent DB snapshot. | True L4 process kill/restart; two daemons, independent SQLite readers, explicit before/after commit probes. Keep store-process, daemon-restart and public-process evidence separately labeled. No qualification inferred from L1–L5 or existing AH10 handler-level tests. | **No.** Must wait for P36 integration and G0 completion; do not overlap the currently awaited functional run or AH7 L4 work. |

## Exit conditions and non-claims

- Run the phases strictly L1→L2→L3→L4→L5→L6 after G0; keep pending RED tests outside the default suite until each has a reviewed implementation and evidence.
- Run focused module checks at L1–L5. Only after the process matrix passes, run the required wider gates in a separately scheduled turn; this plan does not authorize or execute them.
- The existing AH10 Submitted DecisionEpisode binding RED and Verification command gaps are independent work and are not part of this Deliver DAG.
- No implementation starts until the coordinator supplies both awaited status updates and confirms the target tree's P36 integration. This plan alone is not phase closure, release qualification, or permission to modify production.
