# P37 L6 Legacy Direct-Write → P10 Poll Diagnostic

Date: 2026-10-12
Source run: first complete P37 L6 single-pass matrix; case 8/11
Status: **P9 fact/outbox observed; P10 projection not reached; cause unresolved**

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
P9 event. No P10 poll error was persisted. The primary daemon error array was
empty. The first-run capture did not retain stderr from the additional recovery
daemon, so the diagnostic cannot establish whether that daemon stayed healthy
and polled after P9 fact commit. No P10 or production defect is concluded.

## Follow-up boundary

Keep this branch separate from the approved receipt-seed and gen0-renewal-gate
repairs. On the next centrally allocated P37 process window, inspect both
daemons' process-local logs and P10 dispatch/poll attempts through the P9 event
sequence, then exercise the exact P10 row-write and post-commit boundaries.
Do not alter the frozen P9 fact/event or P10 marker/ACK/offset contract. If a
repeatable P10 poll/rebuild behavior contradicts that contract after the
fixtures prove a live, healthy consumer, capture the failure and source row as
implementation evidence before classifying it.
