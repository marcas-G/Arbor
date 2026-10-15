# AH19 startup handshake diagnostic

Date: 2026-10-15

Status: **both focused cases pass; prior intermittent startup timeout remains
unexplained and is not closed as a root cause**.

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
The reporter is enabled only for the two requested AH19 cases.

## Validation

| Check | Result |
|---|---|
| Root `pnpm build` | PASS |
| `pnpm --filter @arbor/web build` | PASS (existing chunk-size warning only) |
| Targeted Biome, 8 files | PASS |
| `git diff --check` | PASS |
| `p38-runtime-schema-boundary` real `--once` + Web bind with a probe that throws on every phase | PASS, 1/1, 55.66s |
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

After cleanup, OS process checks found all six captured child PIDs no longer
running. The only remaining workspace temp directory is the pre-existing
`.arbor-functional-schema42-FBDIxO/`, retained as failed-batch evidence. No
`G43dwQ` directory exists in the candidate checkout or the configured Temp
root, so none was removed.

## Conclusion

The two failures did not reproduce in isolated runs. The measured startup
phases do not show a deterministic stall in P39 validation, migration, or T1
recovery. The previous release batch's `STARTED`-without-`LISTENING` timeout
therefore remains a nonreproduced intermittent startup delay. Resource or
host contention is a possibility, not established evidence; no production
defect or root cause is claimed closed by these passes.
