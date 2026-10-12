# P37 L6 Legacy Direct-Write → P10 Poll Diagnostic

Date: 2026-10-12
Source run: first complete P37 L6 single-pass matrix; case 8/11
Status: **P9 fact/outbox observed; initial P10 timeout traced to a test gate ordering defect; post-correction run pending**

## Evidence

The process case reached the test-only `P37LegacyDirectObservationReturned`
boundary for gen0 and ran gen1 recovery. The probe/result log records:

- one exact historical direct-write `Message`, `MessageSent`, and Parent Inbox
  effect with no DeliverMessage receipt;
- gen1 `DeliverReplayEscalated` with `failureCode=PriorReceiptEffectConflict`;
- one durable `deliver_replay_attention_facts` row and its exact P9 event;
- the test timed out waiting for the configured
  `P10AfterAttentionRowWriteBeforeConsumerCommit` process boundary.

The archived DB is
`planning/results/P37-L6-process-crash-artifacts/08-does-not-accept-a-gen0-direct-write-observation-in-gen1-an-existing-fact-still-b/arbor-functional.db`.
A read-only query after daemon shutdown returned:

| Field | Stored value |
|---|---|
| P9 fact | one, `PriorReceiptEffectConflict` |
| P9 event | sequence 20, `DeliverReplayEscalated` |
| P10 consumer offset | sequence 15 |
| P9 pending outbox | one row for the exact `attentionFactId` |
| P10 Deliver marker | zero |
| P10 Attention projection row | zero |
| Global poll claim | clear; generation 3; next attempt sequence 4 |
| Project poll state | last attempt 3, failures 0, next eligible `2026-10-12T01:42:11.309Z` |
| P9 fact time | `2026-10-12T01:42:54.111Z` |

The max journal sequence was 20, so the Attention offset remained before the
P9 event. No P10 poll error was persisted. The first-run capture did not retain
stderr from the additional recovery daemon.

The fixture-repair rerun reproduced the same branch in its legacy-direct-write
case. Its archived database is
`planning/results/P37-L6-process-crash-artifacts-rerun-1/08-does-not-accept-a-gen0-direct-write-observation-in-gen1-an-existing-fact-still-b/arbor-functional.db`.
The P9 event is sequence 20, offset 15, the queue still contains the exact
fact, no P10 marker/projection row exists, and the global claim is clear with
no poll failure. This rerun also captures the test-code ordering: the process
is held at `AfterDeliverReplayAttentionCommit` while awaiting the P10 row-write
boundary.

The bounded cause is in the qualification fixture. Recovery runs inside
`schedulerTick`, while `main.ts` runs `pollConsumers` only after that Effect
returns (`apps/single-workspace/src/main.ts:417-418`). The held P9 callback
therefore prevents that same daemon from reaching its P10 poll. This does not
prove a P10 production-liveness failure.

## Follow-up boundary

The second fixture-only correction releases the P9 after-commit test gate after
asserting its durable identity, then waits at the P10 pre-commit row boundary.
It does not change P9/P10 production code, contracts, cases or timeout. The
focused P9-after-boundary case has since passed 1/1 with this gate order,
including P10 pre-commit and post-commit probes. That adjacent case exercises
`PriorReceiptDecodeMismatch`, not this legacy-direct-write
`PriorReceiptEffectConflict` branch. The direct-write case itself remains open
until the full matrix requalifies it; P10 is not closed by the focused adjacent
case.
