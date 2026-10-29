# P39 writer-lock contention deadline evidence

Date: 2026-10-23  
Base: `adcb524f`  
Status: implementation and focused qualification complete; original sweep hang not reproduced.

## Scope and conclusion

This change keeps synchronous SQLite busy waits out of the Node event loop for
P39 writer-lock acquisition. Each attempt uses a fresh scoped SQLite connection
with SQLite's synchronous `busy_timeout` set to zero, retries only SQLite
`LockTimeoutError`, and sleeps cancellably between attempts. A monotonic
deadline is established once per acquire call and checked across connection
creation, setup, transaction acquisition, and retries. Failed attempts roll
back when needed and close their scope before retrying; a successful attempt
retains its connection scope until permit release. Fresh lock-file creation
and protected-path checks remain owned by `p39WriterLockLayer`.
The configured budget begins when `P39WriterLockClient.acquire` is called;
one-time layer path validation and missing-lock-file creation occur before
that budget, while SQLite connection/schema initialization is included.

The 2026-10-23 sweep artifact
`C:/Users/ThinkPad/.codex/worktrees/native-sandbox-preintent-integration/Arbor/.test-results/2026-10-23T07-09-08Z-adcb524f-sweep/p39-writer-exclusion-hang.json`
records `HUNG_ABORTED_BY_AUTHORIZED_OPERATOR` after 931106 ms, not an ordinary
test failure. The original approximately 600-second hang was not reproduced
by the isolated same-layer retry comparison below; this result therefore does
not claim that the sweep hang's root cause is closed.

## Reproduction and comparison

The Node SQLite driver opens `DatabaseSync` before setting `PRAGMA
busy_timeout`; its own type documentation notes that SQLite's synchronous busy
timeout blocks the event loop. In a raw cross-process probe, the constructor
and timeout pragma returned quickly, while a contended `PRAGMA journal_mode`
with a 250 ms busy timeout took about 817 ms and a 50 ms timer did not run.
This localizes a directly observed blocking path to a later synchronous SQL
probe, but does not establish that it caused the sweep's longer hang.

The same-layer P39 holder/refusal/release/reacquire harness was run against
both exact `adcb524f` and the changed layer, for both shared-holder/exclusive-
contender and exclusive-holder/shared-contender cases:

| Layer | First attempt | Event-loop timer | Same-client retry after holder release |
|---|---:|---|---|
| `adcb524f`, shared → exclusive | 377.176 ms | did not fire | acquired in 3.239 ms |
| `adcb524f`, exclusive → shared | 765.282 ms | did not fire | acquired in 1.861 ms |
| changed, shared → exclusive | 250.858 ms | fired | acquired in 2.83 ms |
| changed, exclusive → shared | 279.728 ms | fired | acquired in 7.29 ms |

The measured elapsed times include process/event-loop scheduling and are not
hard real-time bounds. Crucially, the baseline already recovered on retry in
this reproduction. The demonstrated improvement is event-loop responsiveness
and deadline behavior under the reproduced contention, not a proven fix for
the 931106 ms sweep hang.

## Contract and error behavior

- Cross-process shared/exclusive contention returns the typed
  `P39_WRITER_LOCK_ACQUIRE_FAILED` only after its configured deadline; an
  early holder release allows the same P39 client to acquire successfully.
- Same-layer shared permits remain held until each matching release; an
  exclusive contender remains refused until both are released.
- Cancellation during retry closes the pending attempt scope; a later fresh
  acquisition succeeds.
- Only SQLite `LockTimeoutError` is retried. The malformed non-busy schema
  regression returns immediately as the existing `SqliteAdapterError`
  identity and diagnostic message.
- Protected path validation remains fail-closed; missing lock files are still
  created by the production layer with its existing private/shared-group mode
  selection, then validated. Existing lock-file paths are validated as before.

SQLite schema/journal incompatibilities retain their previous
`SqliteAdapterError` identity and message, although they are observed from the
deferred acquire path now that initialization participates in the acquire
deadline. The existing `P39_WRITER_LOCK_SCHEMA_INVALID` remains limited to the
post-BEGIN identity-row shape check, as before. Filesystem path failures retain
the P39 path error codes. Non-busy SQLite open/setup failures retain the
previous `SqliteAdapterError` wrapper and cause; SQL errors after acquisition
starts retain `P39_WRITER_LOCK_ACQUIRE_FAILED`. Only SQLite lock contention is
retried.

## Verification

- P39 same-layer refusal/release/reacquire cases: PASS, 2/2.
- Same-layer shared-permit ownership case: PASS, 1/1.
- Early release, cancellation cleanup, and non-busy schema case: PASS, 3/3.
- The isolated non-busy-schema regression was rerun after restoring the
  original error identity: PASS, 1/1 (six other cases skipped).
- Biome on the changed TypeScript/MJS files: PASS; `git diff --check`: PASS.
- `pnpm typecheck`: PASS after the final source and test updates.
- `pnpm test:functional` and daemon/bootstrap suites: NOT RUN (the main sweep
  owns the heavy test slot).

## Effect lifecycle follow-up

Follow-up review of the exposed adapter service identified three Effect
construction-time hazards in the initial implementation: the deadline was
captured before the returned acquire Effect ran, a zero wait budget skipped
the first SQLite attempt entirely, and constructing (without running) a
release Effect removed the permit before cleanup was registered. The follow-up
places acquire state inside `Effect.suspend`, always makes one attempt (with
zero SQLite busy timeout meaning no wait/retry), and defers permit removal
until an uninterruptible rollback/close finalizer runs. Internal acquisition
typing now explicitly retains `SqlError`; contention is narrowed and
normalized at the outer retry boundary without a cast that masks it.

Focused lifecycle regressions pass: deferred/repeated acquire Effect 1/1,
zero-budget free acquire 1/1, zero-budget contention refusal 1/1, and
constructed-but-unrun release followed by layer shutdown 1/1. They were run
with an isolated Vitest config and the SQLite adapter package build; no
functional global setup was loaded. The original implementation was not
re-run with these new regressions to collect a separate red log. After this
follow-up, `pnpm typecheck` and the adapter package build pass; the broader P39
focused cases were not rerun in this follow-up. Zero budget means one
non-waiting SQLite attempt, not a hard zero-millisecond wall-clock bound;
one-time setup and event-loop scheduling can still consume time.

## Integrated-candidate focused qualification (2026-10-24)

The final two candidate commits were integrated as source `cd1a2845` and the
SQLite adapter package was rebuilt before qualification. The complete focused
file
`tests/functional/process/p39-maintenance-writer-exclusion.functional.test.ts`
then passed 11/11 with retry 0 and one worker in 97.50 seconds. It covered both
cross-process shared/exclusive directions, deferred and repeated Effects,
zero-budget free and contended acquisition, constructed-but-unrun release,
same-layer permit ownership, event-loop responsiveness, cancellation cleanup,
invalid schema, and crashed holder recovery.

A pre-build run of four lifecycle cases had one child timeout with no output;
after rebuilding the adapter package, the exact case passed in 4.709 seconds
inside the full 11/11 run. This is recorded as stale-dist test setup evidence,
not a production regression or retry of the qualified run.

The integrated result still does not identify or reproduce the historical
931106 ms sweep hang. It qualifies the bounded writer-lock module on the
current candidate; it does not close the historical common-cause audit or the
full functional release gate.
