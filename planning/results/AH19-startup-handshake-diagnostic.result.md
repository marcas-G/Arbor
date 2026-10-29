# AH19 startup handshake diagnostic

Date: 2026-10-15

Status: **focused AH19 startup assertions pass; the release timeout is traced
to fixture HTTP-readiness handling after an expected fail-closed child exit**.

## Scope and instrumentation

Candidate started at `2ddcb772`; the concurrent runner-only commit advanced
HEAD to `3f9a4707198e80bd0df1a89c54442f8fba005f39` before the focused runs.
The AH19 diff was saved before testing at
`.test-results/ah19-startup-source.diff`.

An opt-in startup callback is passed only by the AH19 child when
`ARBOR_AH19_STARTUP_TRACE=1`. It records fixed phase labels and elapsed time
around Layer construction, P39 path/schema validation and permit acquisition,
ProductionDaemon service acquisition, migration, T1 startup recovery, and Web
bind. Diagnostic callback exceptions are swallowed. The child wrappers retain
the original expression order: `runDaemonForever(config)` is constructed
before `main(config)`. No timeout or AH19 security, hash, no-replay, or
settlement assertion changed. The default production composition does not
provide the callback.

Persisted records are bounded and contain only phase, elapsed milliseconds,
child PID, lifecycle stage, exit status, and summarized state; they omit
nonces, secrets, provider request bodies, Session text, and opaque references.
Within this test module, all processes launched via
`ah19-native-daemon-child.mjs` now emit startup phases by default. The
AH19-owned nonce-daemon startup paths in the checkpoint helpers also enable
the phase trace, so startup failures before the AH19 child restart are
observable. Other functional tests using the ordinary nonce daemon are not
changed. Child callbacks remain exception-safe, and persisted diagnostic data
continues through the same strict phase/state allowlists.

## Validation

| Check | Result |
|---|---|
| Root `pnpm build` | PASS |
| `pnpm --filter @arbor/web build` | PASS (existing chunk-size warning only) |
| Targeted Biome, 8 files | PASS |
| `git diff --check` | PASS |
| `p38-runtime-schema-boundary` real `--once` + Web bind with a probe that throws on every phase | PASS, 1/1, 55.66s |
| Startup JSONL redaction sentinel regression | PASS, 1/1; sentinel fields do not appear in the artifact |
| AH19 terminal ConversationResponse after Native rebase | PASS, 1/1; case 77.311s, 38 skipped |
| AH19 corrupted compiled hash before Summary | PASS, 1/1; case 133.322s, 38 skipped |
| AH19 ordinary history + AH17Before + AH17After checkpoint sequence | PASS, 3/3; cases 61.384s, 56.034s, 58.449s; original per-test budgets unchanged |

## Phase evidence

Phase records are in `.test-results/ah19-startup-20584.jsonl` (terminal
ConversationResponse) and `.test-results/ah19-startup-26656.jsonl` (compiled
hash corruption).

For the terminal case, all three daemon incarnations reached
`FUNCTIONAL_DAEMON_LISTENING`: initial process in 19.2s, AH19 scenario process
in 17.7s, and changed-binding recovery process in 28.7s. The recovery process
completed P39 runtime-path validation, Layer construction, schema validation,
writer-permit acquisition, ProductionDaemon service acquisition, migration,
T1 startup recovery, and Web bind. Its migration took about 1ms and T1 startup
recovery about 12ms. The test passed its existing terminal settlement,
answered-response, pinned-output, and Provider request-count assertions.

For the hash-corruption case, all three daemons reached the listening marker
in 19.4s, 20.7s, and 20.4s. Migration took 1–2ms and T1 startup recovery
6–8ms. The final test child exited with code 1 after listening, as expected
for the corrupted binding-evidence fail-closed path; the case passed its
existing no-Summary/no-settlement assertions.

Post-review hardening constrains the JSONL writer to tagged records and routes
every persisted state through `ah19PersistedStateSummary`, which emits only
numeric counters, presence/settlement booleans, and known enum labels (unknown
labels become `other`). A sentinel regression injects the same marker into
Session, Provider request/response, checkpoint, and opaque-reference fields;
the marker is absent from the JSONL. Both child-side Layer phase calls use a
nonthrowing wrapper. The schema-42 `--once` observer-throws regression remains
green.

After cleanup, OS process checks found all six captured child PIDs no longer
running. The only remaining workspace temp directory is the pre-existing
`.arbor-functional-schema42-FBDIxO/`, retained as failed-batch evidence. No
`G43dwQ` directory exists in the candidate checkout or the configured Temp
root, so none was removed.

## Readiness-exit follow-up

The later release run `.test-results/2026-10-15T05-58-32-788Z-3340` timed out
on the manifest `providerTurnId` case after the surrounding cases passed.
The cause was in fixture readiness, not daemon startup: after the nonce-bound
LISTEN marker, `startDaemon` polled HTTP readiness for up to 60 seconds using a
predicate that included `!childHasExited`. When the intentionally corrupted
manifest made the restarted daemon exit fail-closed, that predicate remained
false but did not reject; the fixture waited out the entire HTTP-readiness
window. Earlier traces showed LISTEN followed by child exit code 1 about one
second later and `fixture.restart` returning about 60 seconds after that. The
`logicalStepNo` pre-fix trace at
`.test-results/ah19-startup-23404.jsonl` reached LISTEN at child elapsed
17.396s, exited code 1 at 18.392s, and had not returned from fixture restart
before the 160s test timeout. This explains how accumulated scenario/startup
latency can push the unchanged 160s test budget over its limit.

`waitForDaemonReadiness` now checks child exit around each HTTP probe and
rejects immediately with exit/signal and bounded, redacted stderr. The normal
60s readiness bound remains unchanged. A fixture regression starts a real
HTTP-listening test child that exits code 23 before answering readiness; it
asserts prompt rejection, exit/stderr diagnostics, closed provider, removed
fixture directory, and no surviving child process.

Validation on `c6d7c518` plus the fixture change:

| Check | Result |
|---|---|
| Fixture listen-then-exit cleanup regression | PASS, 1/1; 2.298s test time |
| Fixture live-but-no-headers overall timeout regression | PASS, 1/1; 3.199s test time |
| Fixture late-200-after-deadline regression | PASS, 1/1; 3.310s test time |
| `pnpm typecheck` | PASS |
| Exact `providerTurnId` fail-closed case | PASS, 85.771s; 39 skipped |
| Ordered `logicalStepNo`, then `providerTurnId` with `--bail=1` | PASS, 2/2; 81.892s and 89.758s; 38 skipped |

The post-fix trace `.test-results/ah19-startup-23956.jsonl` records the exact
`providerTurnId` run: restart child Web LISTEN at child elapsed 17.893s, exit
code 1 at 18.869s, and fixture restart plus fail-closed marker both returned at
85.645s. The ordered pair trace is `.test-results/ah19-startup-25252.jsonl`;
both cases report restart-return and fail-closed markers, and both children
were already dead with exit code 1 before fixture cleanup. Startup phase times
varied under the sequential run (for example, writer-permit acquisition was
17.5s in the first case and 30.5s in the second), but both stayed within the
existing per-case budget once the erroneous 60s readiness wait was removed.

No production code, timeout budget, binding/security assertion, no-replay
assertion, or settlement assertion changed. The evidence establishes a
test-fixture orchestration defect causing the delayed return; it does not claim
that all possible startup/resource contention is eliminated. The only retained
untracked batch evidence remains `.arbor-functional-schema42-FBDIxO/`.

## Windows process-tree stop follow-up

Run `.test-results/2026-10-15T08-12-23-904Z-6668` failed before manifest
mutation or business assertions, while `startOrdinaryNativeAtCheckpointBoundary`
was stopping its generation-0 daemon. The child had reached LISTEN. The
previous Windows lifecycle code started a 5s target-exit wait at the same time
as `taskkill.exe`, so command runtime and Node's later child-exit event shared
one budget. A taskkill taking slightly more than 5s could therefore time out
even when the target exited normally immediately after taskkill completed.

Windows stop now bounds taskkill independently at 10s, then starts a fresh
5s target-exit grace. If the target exits first, the same `/T /F` helper is
allowed a bounded completion; only helper exit code 0 with the helper reaped
proves tree cleanup. Helper error, nonzero exit, or timeout rejects as
unproven. Timeout errors identify `taskkill`, `taskkill-cleanup`, or
`target-exit-after-taskkill`; race and child-exit listeners/timers are removed
on every outcome. Taskkill helper cleanup has a separate 1s bound.

| Validation | Result |
|---|---|
| Virtual-clock taskkill completes after old 5s bound; target exits within fresh grace | PASS; no real sleep; listeners/timers cleared |
| Target exits before taskkill; same helper completes successfully | PASS; no real sleep |
| Taskkill independent timeout and helper cleanup | PASS; no real sleep; listeners/timers cleared |
| Real Windows parent+grandchild process-tree stop, repeated stop | PASS, 1/1; 319ms |
| Real Windows process-tree stop and repeated stop after successful tree kill | PASS, 1/1 |
| AH19 exact `providerTurnId` | PASS, 53.630s |
| Ordered AH19 `logicalStepNo` + `providerTurnId` | PASS, 2/2; 53.667s and 53.126s |
| Targeted Biome and `pnpm typecheck` | PASS |

No AH19 per-case budget or business/security assertion changed. The lifecycle
fix is isolated to test-process cleanup and its shared process helper; no full
suite was run. The failed run's startup phase trace did not reach manifest
mutation, confirming that failure point was cleanup rather than AH19 recovery.

## Startup trace expansion and AH17 sequence

The AH19 child trace applies by default to every process launched via
`ah19-native-daemon-child.mjs` in this test module. The checkpoint helpers
also opt their AH19-owned initial nonce-daemon startup into the same trace;
this is local to these AH19 tests and does not change ordinary nonce fixtures
elsewhere. All persisted values continue through strict phase and state
allowlists.

The requested minimum sequence passed on unchanged test budgets:

| Case | Initial nonce daemon final bind | AH19 child final bind | Test result |
|---|---:|---:|---|
| Ordinary Native history | 21.870s | 18.774s | PASS, 61.384s |
| AH17BeforeCheckpointEpochCommit | 17.801s | 17.446s | PASS, 56.034s |
| AH17AfterCheckpointEpochCommit | 18.646s | 17.600s | PASS, 58.449s |

Per-child phase records are in `.test-results/ah19-startup-1036.jsonl`. All
six processes reached `web-transport.bind.after` and emitted the nonce-bound
LISTEN marker. The full batch's STARTED-without-LISTEN symptom did not
reproduce in this sequence. A preceding diagnostic attempt did capture a slow
but progressing AH17Before initial startup (P39 runtime-path validation
13.512s, Layer path validation 26.545s, schema validation 40.645s, writer
permit acquisition 50.253s, Web bind 50.333s). That attempt then failed in
the new test-only auto-attach hook after fixture startup; the hook was
corrected and the complete sequence rerun successfully. The timings show
startup-phase variability, but no phase stalled in the successful sequence;
they do not establish a production root cause for the earlier full-run event.

## Windows taskkill failure-path hardening

The Windows process-tree path now retries `/T /F` once after a bounded primary
helper cleanup when the target is still alive. A retry is successful only
after the target's exit is observed within a fresh bounded grace. If the retry
also fails, the code attempts direct-child `SIGKILL` and a fresh bounded exit
wait, then rejects with `Windows process-tree cleanup unproven` and the
attempt-phase list; it never treats direct-child exit as proof that descendants
were removed. If the target exits while taskkill has not spawned yet, cleanup
waits for the same helper's spawn/error/exit and then for successful exit code
0. A spawn error, nonzero exit, or timeout rejects as unproven rather than
treating an already-exited root as proof of tree cleanup. A late-spawned helper
must finish the tree kill and be reaped.

If a failed taskkill attempt is being cleaned up and the root exits during that
cleanup window, the run terminates as unproven without retrying against the
stale PID. A `WeakMap` preserves that outcome for later calls on the same
`ChildProcess`, so a repeated stop cannot wash away the failure. A child that
naturally exited before any stop attempt retains the existing no-op contract;
repeated-stop idempotence is qualified only after a prior successful tree
cleanup.

| Validation | Result |
|---|---|
| Primary timeout → retry tree-kill success → target and fake descendant exit | PASS; virtual timing; no real sleep |
| Two tree-kill failures → direct child killed and function rejects unproven; fake descendant retained | PASS; virtual timing; no helper/target remains |
| Controlled target-first root+descendant; helper code 0 removes descendant | PASS; no real sleep |
| Target-first with pid-less helper delayed spawn → helper code 0 required | PASS; no real sleep |
| Target-first with pid-less helper spawn error | PASS; rejects as unproven after error |
| Target-first helper nonzero exit | PASS; rejects as unproven |
| Root exits during failed-helper cleanup | PASS; terminal unproven is memoized and repeated stop rethrows; fake descendant remains unproven |
| Naturally exited child never previously stopped | PASS; existing no-op behavior |
| Repeated stop after successful real tree cleanup | PASS, 1/1; second stop is a no-op |
| Windows lifecycle race/retry/fallback suite | PASS, 11/11; includes real Windows tree and target-first helper outcomes |
| AH19 exact `providerTurnId` | PASS, 76.18s |
| Ordered AH19 `logicalStepNo` + `providerTurnId` | PASS, 2/2; fail-closed markers at 53.707s and 53.021s |
| Targeted Biome and `pnpm typecheck` | PASS |

No per-case timeout, recovery assertion, or security/settlement assertion was
changed. No full suite was run.

## Lease-loss and child-exit follow-up

Windows `stopChildBounded` again attempts taskkill immediately for a live child;
there is no generic natural-exit grace or process-table PID query. Once forced
cleanup starts, only taskkill exit code 0 plus observed target exit proves
cleanup. Target-first code 128, other nonzero exits, errors, and timeouts stay
`tree cleanup unproven`. This does not claim to manage external processes
detached from the root.

The AH10 regression identified `consumeWorkspaceWake` as the only production
`runExecution` callsite not containing `LeaseFencingRejected`. It now ends
only that wake on ownership loss; unrelated failures still propagate. AH10
before/after generation-takeover passed two consecutive rounds after removing
the generic grace (81.676s / 59.131s and 59.528s / 58.963s), with the old owner
explicitly stopped by the fixture and no daemon errors.

The AH18 fail-closed tests now wait for their own restarted child to report a
determinate exit after observing failure evidence. This is a scenario-level
assertion, not a cleanup grace: it proves the child exited naturally after the
typed rejection rather than relying on fixture teardown to make the assertion
pass. The orphan-manifest and both corruption-table branches passed three
consecutive runs (9/9): orphan 31.369s / 29.871s / 34.640s;
manifest-context-epoch 29.881s / 29.792s / 30.029s; turn-context-epoch
29.827s / 29.479s / 24.550s.

The first full handshake-file run exposed a test-child setup bug, not a
taskkill success case: wrong/duplicate-marker branches used unresolved
top-level await without a referenced event-loop handle. Node exited them with
code 13 while taskkill raced and returned 128. These intentionally live test
children now hold a referenced interval until fixture cleanup. Their expected
handshake-marker assertions remain unchanged, and cleanup can stop a live
child normally.

| Validation | Result |
|---|---|
| `containLeaseFencingRejected` unit test | PASS; catches only ownership loss; unrelated tagged failures propagate |
| AH10 generation-takeover before/after receipt-commit pair | PASS, 2 consecutive rounds after removing grace (4/4); 81.676s / 59.131s and 59.528s / 58.963s |
| AH18 orphan-manifest + corruption-table cases with exit assertion | PASS, 3 consecutive rounds; 9/9 |
| Full `production-fixture-port-handshake` file | PASS, 2 consecutive rounds; 26/26 each, 70.27s / 69.64s |
| Late HTTP readiness `<5s` assertion | PASS in both full-file rounds at 3.035s / 2.980s |
