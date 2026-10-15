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
The reporter is enabled only for five AH19 manifest-corruption cases:
`logicalStepNo`, `providerTurnId`, `bindingFingerprint`, `repairAttempt`, and
`executionId`. Other AH19 cases continue to run without these startup traces.

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
| Fixture listen-then-exit cleanup regression | PASS, 1/1; 2.084s test time |
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
