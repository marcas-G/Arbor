# P5 — 04 Slice Continuity

**Authority:** DID v1.9 §3.4, §6A.6, §8.16/§8.17, §11 P5, G4/G5; P2 `05`/`06`.
**Status:** DRAFT (first draft for contract review).

## 1. Multi-turn Session continuity across Executions

- A Workspace main Execution snapshots `primarySessionId` at admission
  (`execution.sessionId` immutable — P2 §3.4).
- P3 `SessionRepository.appendEntry` writes `ModelOutput` / `Observation` /
  `ContextUpdate` / `CheckpointReference` entries into that fixed Session.
- A later Execution in the same Workspace snapshots the **same**
  `primarySessionId` (unless `ReplacePrimarySession` ran with no active main),
  so continuity spans Executions.
- `Session History != Provider Context` (SD §5.4): `prepareTurn` projects the
  Session, it does not replay it.

## 2. Yield → WorkWait → wake → continuation

```text
CompletionClaim? no
Yield(reason, waitSpec)
  -> Completed(Yielded) settlement
  -> WorkWait registered in the SAME transaction (P2 `05` §5)
  -> Work remains Open; Execution settles
  -> wake (Dependency/Decision/Verification/Inbox/Environment/TimeReached/Manual)
  -> ExecutionScheduler.reevaluate -> new Execution continuation
```

- Lost-wake-up protection is P2's; P5 exercises it end to end.
- `TimeReached` uses the durable `scheduler_timers` (no in-memory timer).

## 3. CompletionClaim (G4)

- `CompletionClaim` → `Completed(CompletionClaimed)` settlement via the P2
  `SettleExecution` command (ExecutionOrigin, fenced).
- The **Work remains `Open`**; P5 does **not** call `StartVerification`,
  `AcceptWorkOutcome`, or `CompleteWork`.
- The durable `ExecutionSettled(CompletionClaimed)` event is the hand-off point
  for P8's deterministic `StartVerification` consumer.

## 4. Restart-continuity proof (G5)

```text
run slice -> durable state advances (Work/Session/Execution/entries/waits)
stop runtime (dispose layers, close DB)
reconstruct runtime against the SAME durable DB file
resume: load canonical state -> P2 recovery (expired leases, unsettled) ->
        continue the same Work/Session
```

- **P2 owns the recovery mechanism**; **P5 owns only the representative
  restart-continuity acceptance proof** (`05` §4).
- **P9 owns systematic fault-injection hardening**; P5 does not inject crashes
  mid-transaction.
- The proof asserts: same Work still `Open`; same `primarySessionId` reused; the
  Session entries survive; the loop continues.

## 5. Must Not Decide

- No Verification/Acceptance/CompleteWork (P8).
- No new recovery mechanism (P2).
- No systematic fault injection (P9).
- No dependency-aware wake sources (P7 owns their production; P5 consumes).
