# P9 — 03 Worker Lease Hardening & Recovery Drive

**Authority:** P2 `03` (lease CAS / lazy invalidation / release), P2 `05`
(scheduler / wait / wake / timer), P2 `06` (recovery skeleton); DID v1.11
§8.16 (durable timer / `TimeReached`), §9.7, §6A.5, §6A.6; GQ3 adjudication
(`planning/proposals/P9/00-scope-extraction.md` §3); scope items B-4/B-9.
**Status:** DRAFT (first draft for contract review).

P2 froze the lease/recovery **mechanisms**; P5 proved representative restart
continuity. P9 closes the two missing production drives — the worker lease
renewal loop and the recovery/sweep trigger timing — and re-drives durable
timers. All semantics below are drives over frozen contracts; zero mechanism
change.

## 1. Lease renewal loop

```text
acquire (CAS; generation = MAX+1, P2 `03` §2)
  ↓ drive begins
  ↓ renewal loop: every TTL/3, renew = CAS on (worker_id, generation)
  │   extending expires_at; generation UNCHANGED by renewal
  ↓ drive ends → SettleExecution (fenced) → release (CAS, same generation)
```

- Renewal cadence convention is frozen at **TTL/3**; the TTL value itself and
  absolute cadence are **empirical** (task-level; P2 `03` §8 keeps lease
  duration non-contract).
- Renewal success keeps ownership continuous: no generation bump, no new
  execution lease row identity — only `expires_at`/`updated_at` advance
  (P2 `03` §2).
- Renewal failure (stale generation / no live lease) means the worker lost
  ownership: `LeaseLost` locally; the worker must stop durable mutation and
  must not ordinary-retry (P2 `03` §7). The authoritative rejection, if a
  write is nonetheless attempted, is `FencingRejected` /
  `LeaseFencingRejected` (02 §2).
- A drive shorter than one TTL needs no renewal; the loop is bounded by the
  drive lifetime, not an independent daemon thread.
- Release (soft): worker-initiated release is a CAS on
  `(worker_id, generation)` deleting the live lease row. Release **never
  settles** the Execution and never changes Work lifecycle (DID §6A.6);
  lazy invalidation remains the authority for expired leases (P2 `06` §3) —
  release is an optimization, not a correctness requirement.

## 2. Recovery / sweep trigger timing (GQ3, frozen)

```text
T1  startup full recovery     nine-step pass (P2 `06` §2), exactly once per
                              daemon startup, before any new dispatch or
                              admission
T2  periodic sweep            same nine-step pass, fixed interval
                              (interval = empirical, task-level)
T3  event-triggered sweep     same nine-step pass, enqueued by frozen hooks:
                                a. ExecutionSettled observed
                                b. expired lease observed (any lease CAS /
                                   fence check / pre-dispatch check seeing
                                   expires_at <= now — consistent with lazy
                                   invalidation, P2 `06` §3)
                                c. consumer dead-letter written
T4  targeted pre-dispatch     lease-fence predicate ONLY (P2 `03` §3):
  recovery check              is there a live, unexpired lease for this
                              execution before dispatch? NEVER the nine-step
                              recovery
```

- **Prohibition restated (GQ3): no dispatch round runs the full nine-step
  recovery.** T4 is a single-predicate read, not a recovery pass; conflating
  them is a contract violation.
- T1 crash-recovery: crash during T1 → restart runs T1 again; idempotent
  re-entry asserted by (02 §4 D2).
- T2/T3 sweeps are single-flight per daemon (P2 `05` §8 discipline); a sweep
  concurrent with T4 is harmless (T4 is a read).
- Hook set (T3 a–c) is frozen; adding a hook is a contract change, not an
  implementation choice.
- Sweep drives reevaluation via the existing `reevaluate` loop (P2 `05` §4);
  no new scheduling decision is introduced (DF2 bottom line, 02 §9).

## 3. Durable timer re-drive (B-9)

- T1 (startup) and every T2/T3 sweep scan `dueTimers(now)` (port frozen in
  P2 `05` §6; currently zero production callers — P9 adds the drive only):
  - firing = enqueue a wake for the owning Workspace **and** clear the timer
    row in the same transaction (P2 `05` §6);
  - the wake drives `reevaluate` (existing `TimeReached` condition
    semantics, DID §8.16; P2 `05` §4);
  - wake delivery is at-least-once; re-delivery re-runs `reevaluate`, which
    is idempotent given current canonical state.
- Crash between firing and wake delivery: the timer row is cleared only in
  the same transaction as the wake enqueue → a crash before COMMIT leaves
  the row intact → the next sweep re-fires. No lost timer.
- No Worker in-memory timer is authoritative (DID §8.16); assertions of
  (02 §4 D4) cover the dirty-restart face of this drive.

## 4. RuntimeSafetyGate in-process semantics (maintained, not upgraded)

- Gate counters stay in-process (P2 `05` §7; DID §8.16A): a daemon restart
  resets them; a resumed Execution continues with fresh counters.
- P9 records this as a **note, not a change**: no persistence, no upgrade of
  the gate to durable state (scope scope-extraction §C (planning/proposals/P9/00-scope-extraction.md) default: keep P2-frozen semantics).
- Consequence for injection assertions: dirty-restart tests (02 §4) must not
  assume counter continuity across the restart boundary.

## 5. Must Not Decide

- No lease CAS / renewal CAS / release semantics changes (P2 `03` owns).
- No recovery step order, settlement rules, or authority changes (P2 `06`).
- No new scheduling decisions / runnable semantics (P2 `05` §4; P7).
- No TTL, sweep-interval, renewal-cadence numeric values (empirical,
  task-level); only the TTL/3 convention is contract.
- No pre-dispatch recovery beyond the lease-fence predicate (GQ3
  prohibition).
- No RuntimeSafetyGate persistence/upgrade (P2 frozen).
- No distributed / multi-host lease or recovery drives (P12).
