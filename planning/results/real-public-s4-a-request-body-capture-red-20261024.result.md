# Real Public S4-A Request Capture RED — 2026-10-24

## Run

- Candidate: `e6a11dc721c66e151f707c4bbb3531dbd038f5c5` (`6aafae5f` plus the
  S3 result record only).
- Command selected only `REAL S4-A`, with one worker and retry 0:

  ```text
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-A' --maxWorkers=1 --retry=0
  ```

- Result: **FAIL, 1 test; S4-B skipped.** The configured Provider returned a
  successful HTTP 200 response for the first public conversation round, and
  the public assistant reply was present. The test then failed before arming
  the response gate: it searched for the first prompt in `request-start`,
  which intentionally has no request body. The body is carried by the matching
  `response-complete` event. This is a test-oracle defect; this run did not
  reach held response, process-tree kill, restart, or recovery assertions.
- Teardown confirmed the daemon exited; the fixture was archived. No automatic
  retry was performed. The credential/config values and captured conversation
  content remain private and are not reproduced here.

## Preserved private evidence

Run directory:
`.test-results/real-public-s4-a-conversation-hard-restart-tnIsk4/`

The `evidence-mKhlXB/` directory contains the sanitized run evidence and
provider capture. `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/`
contains the failed run's database files and workspace. The archive records
`status=FAIL`, `daemonExited=true`, and zero daemon errors.

| File | SHA-256 |
|---|---|
| `evidence-mKhlXB/provider-captures.jsonl` | `D1EBBE7C1E04BAC96B6FCC9B12FE12401EDCCF4D4B3EB9C639D5720F8F60E909` |
| `evidence-mKhlXB/s4-a-conversation-hard-restart-2026-10-23T18-48-20.943Z.json` | `BB070CC37BC39877ABE84EAE50FAB7101071142A1891CEFE31934D30AD333989` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/failure-evidence.json` | `D8D36C1F3B1645CDE283E9E49325117C542ECAD44293E3457F78407319742C62` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/arbor-functional.db` | `4F065A4EED27E781EF2452A4B14C756A392CAB08A433035EE4CBBABE2F8A60B7` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/arbor-functional.db-wal` | `011D353C64DCB5D84BD03F8D735BB1F1879807CEEAE1D552AA7B5B39A8AD9616` |
| `retained-fixture-02b24c79-549b-4233-98ec-f503c123f9a8/workspace/proof.txt` | `D1574F67AE06C81C6988C3ECCEC572C403A0602DA3DB45EA6F3FCAA431B18514` |

## Correction and qualification status

The harness now joins body-bearing response events to exactly one
`request-start` by request ID and rejects duplicate or conflicting evidence.
S4-A's post-restart check also compares the public transcript again after a
bounded 1.5-second quiet window. These changes address the RED but have not
been qualified by another real Provider run. This result remains a failed
pre-fix qualification, not S4-A PASS evidence.

The stub-only response-gate regression passed **1/1** under the default root
Vitest configuration with bounded serial execution:

```text
pnpm exec vitest run --config vitest.config.ts tests/capability/support/provider-fetch-capture-hook.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
```

The test replaces `globalThis.fetch` in its short-lived Node helper with an
in-memory `Response`; the `.invalid` endpoint is never contacted. It verifies
the bodyless start event, matching body-bearing completion/held events,
body-to-start identity checks including duplicate/conflict rejection, explicit
release, and that a new process with an empty gate path does not inherit the
old held gate. This is harness evidence only, not a daemon, model, or S4
recovery qualification.

## Single corrected S4-A rerun

The corrected harness was run once at candidate
`e6a11dc721c66e151f707c4bbb3531dbd038f5c5` using the same explicit config
path, a fresh P39 run directory, one worker and retry 0. **S4-A still failed**
after the hard restart: the recovered second assistant turn did not appear
within its bounded deadline. S4-B was skipped. There was no automatic retry
or second real Provider run.

The private capture has two `request-start` and two `response-complete`
events (both HTTP 200), plus one `response-held`, all from old daemon PID
`16528`. There is no `response-released` and no post-restart Provider request.
The held gate remained isolated to the original process; the restarted daemon
received an empty gate-directory environment value. Its child process tree was
stopped and archived (`daemonExited=true`, no daemon errors).

Read-only inspection of the retained database establishes the durable chain:

| Identity | Durable result |
|---|---|
| First message `msg_d4c5afc7-c423-7f1e-8186-d4bf6d7b0871` | Job `Answered`; Execution `exe_bc76c6ce-41f9-7788-8f77-cd92f8bd249f` `Completed`; ProviderTurn `ptn_exe_bc76c6ce-41f9-7788-8f77-cd92f8bd249f_0` Attempt 0 `Success`, with `provider-success-v1` |
| Second message `msg_d65ec34e-f6de-7d04-8de6-30ba57626ff9` | Same Session `ses_3bd0a2c5-7f43-737b-809f-d122b2888b37`; Job `NeedsAttention(UnknownFailure)`; Execution `exe_647fb509-0438-7a00-85bc-2a26f01ccd59` `Failed` |
| Second ProviderTurn `ptn_exe_647fb509-0438-7a00-85bc-2a26f01ccd59_0` | Attempt 0 became `TerminalFailure`; recovery cause `ProcessLost`; P4 retry safety `UnsafeReplay`, decision `Stop`; no Provider Success evidence |
| Second AgentLoopStep | Logical step 0 / repair 0 is `SettlementProposed`, with `decoder_version=NULL`, `manifest_id=NULL`, and no successor; no `ProviderResultAvailable` handoff |
| Restart ownership | The failed Execution lease advanced from generation 0 to generation 1 under a new worker incarnation; conversation consumers advanced through sequence 8 and there are no pending scheduler timers |

The capture hook received and retained the upstream HTTP 200 response, but it
held the response before returning it to the Provider SDK. That receipt is
test-local evidence only; it is absent from canonical ProviderAttempt storage.
The durable attempt observation records `responseStarted=false`,
`canonicalEventEmitted=false`, `consumerVisibleOutput=false`,
`toolCallProposed=false`, `continuationAvailable=false`, and
`externalEffectPossible=true`. P4 therefore classifies the process-lost
attempt as `UnsafeReplay/Stop`; P17 settles the conversation Job to
`NeedsAttention`, after which the scheduler does not issue another Provider
request. Existing `tests/p9-provider-disconnect.test.ts` PD2/I-5 likewise
qualifies a mid-stream turn without a verified cursor as `UnsafeReplay`.

This is evidence for the current fail-closed Provider retry policy, not a
successful recovery. Under the frozen P9 contract, `ProcessLost` with
incomplete durable observation and `externalEffectPossible=true` is
`UnsafeReplay/Stop`; the test hook's receipt of HTTP 200 is private test
evidence and does not establish that the Provider SDK or canonical runtime
received a result. The prior positive-recovery oracle was therefore incorrect;
no production or `docs/design/**` change was made.

## Fail-closed oracle correction

The corrected S4-A assertion now treats this exact crash boundary as a
fail-closed outcome: retain the first answered transcript/session identities,
keep the second HumanMessage pending, expose
`NeedsAttention(UnknownFailure)`, and require the exact ConversationResponse
Execution to be Failed with a TerminalFailure ProviderAttempt and a durable
`ProcessLost / UnsafeReplay / Stop` decision. It also requires no durable
Provider success/AgentLoopStep handoff, no second assistant answer, no request
from the restarted daemon, and no response-release marker for the held request.
A read-only transaction rechecks the public/durable state after a bounded
1.5-second quiet interval. The lease assertion captures the pre-crash
generation/incarnation and requires the same Execution to advance exactly one
generation under a different worker incarnation; consumer offsets must be
nonempty, have a non-null project event high-water mark, and all be caught up.

The initial real run failed before the response gate because the test searched
the bodyless `request-start` event; the corrected body correlation then
reached hard restart but failed the obsolete expectation of a recovered second
assistant turn. The retained second-run database and capture above already
show the fail-closed state required by P9, but are historical observations and
not qualification of the revised oracle.

## Fail-closed oracle real attempt — 2026-10-24

- Candidate: `47b257dd69298529d9431286cb069017adc4ad11` plus the dirty S4-A
  oracle changes reviewed by f18 (Blocking = 0).
- Command selected only `REAL S4-A`, with the explicitly authorized config,
  one worker and retry 0:

  ```text
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-A' --maxWorkers=1 --retry=0
  ```

- Result: **FAIL, 1 test; S4-B skipped.** The journey reached hard restart and
  the public `NeedsAttention(UnknownFailure)` state. It then stopped at a test
  assumption that `transcript.responseStatus` exposes `executionId`; the
  public DTO does not. The exact Execution binding is available through the
  read-only `conversation_response_jobs.active_execution_id` row and is
  already scope-checked against the same message, project, workspace and
  ConversationResponse episode. This was a test-oracle/API-shape mismatch,
  before the new P9 durable-snapshot assertions ran. No automatic retry was
  performed.
- Capture contained two `request-start`, two HTTP 200 `response-complete`, and
  one `response-held` events, all from the original daemon PID. It contained
  no `response-released` or restarted-daemon request. P39 failure evidence
  reports `status=FAIL`, `daemonExited=true`, and zero daemon errors. The
  private fixture/capture remain retained; no secret or conversation body is
  included in this record.

Private run directory:
`.test-results/real-public-s4-a-conversation-hard-restart-TwjJkO/`

| File | SHA-256 |
|---|---|
| `evidence-uH7qfr/provider-captures.jsonl` | `230F039724014B1C4CCE59514FB46A90D1B708A1750BE704B0135338B5ACCB07` |
| `evidence-uH7qfr/s4-a-conversation-hard-restart-2026-10-23T19-17-17.057Z.json` | `58567C9502EEDC49F6966C834AC108DCCAAFA64A236E97EA594E564D8776756A` |
| `retained-fixture-ef4eeb40-0aec-409c-b968-2b1aec29b7ac/failure-evidence.json` | `DA0F71B5A324B221555C72F35E5675AE122AB4D7356B274E25F01C6873FFF14E` |
| `retained-fixture-ef4eeb40-0aec-409c-b968-2b1aec29b7ac/arbor-functional.db` | `4F065A4EED27E781EF2452A4B14C756A392CAB08A433035EE4CBBABE2F8A60B7` |
| `retained-fixture-ef4eeb40-0aec-409c-b968-2b1aec29b7ac/arbor-functional.db-wal` | `5EC511EC6D7DCBA8D452F681988EFC360320A9642D6EF6CE1B30C695DAE60894` |
| `retained-fixture-ef4eeb40-0aec-409c-b968-2b1aec29b7ac/workspace/proof.txt` | `D1574F67AE06C81C6988C3ECCEC572C403A0602DA3DB45EA6F3FCAA431B18514` |

The source correction removes the unsupported public `executionId` assumption
and asserts `job.activeExecutionId === execution.executionId` from the
read-only durable snapshot. This run does not qualify the revised oracle.

## Final authorized S4-A run — 2026-10-24

- Candidate: `dc50a8866b96f9ebf1592621282f0513ed404cae`; independent final
  review reported Blocking = 0.
- The same command was run once more after explicit root authorization, with
  fresh P39 evidence, explicit authorized config path, one worker, retry 0,
  and only `REAL S4-A` selected.
- Result: **PASS, 1 test; S4-B skipped.** The first completed turn remained
  stable. The second real upstream response was held by the private hook on
  the old daemon; the full daemon tree was hard-stopped and restarted on the
  same fixture DB. The pending human message remained in the same session,
  public transcript showed `NeedsAttention(UnknownFailure)`, and there was no
  second assistant message. The read-only durable snapshot verified the same
  ConversationResponse Execution failed, ProviderAttempt `TerminalFailure`,
  recovery `ProcessLost / UnsafeReplay / Stop`, no durable Provider success or
  `ProviderResultAvailable` handoff, and the exact active-job/Execution
  binding. Lease generation advanced exactly once under a new incarnation;
  consumer offsets were nonempty and caught up, scheduler timers were zero.
  A 1.5-second public and durable reread was identical. Captures contained
  only the original PID's two request starts/two HTTP 200 completions and one
  held response, with no release marker or restarted-daemon request.
- Cleanup completed successfully: the disposable fixture was removed after
  PASS; no daemon process remained. Private P39 run evidence remains at
  `.test-results/real-public-s4-a-conversation-hard-restart-mH1QGX/`.

| File | SHA-256 |
|---|---|
| `evidence-ci4hsh/provider-captures.jsonl` | `83A447C326CFDBBEF31821CB78F96CE2E9FC5A92FB077D9427920643419F848E` |
| `evidence-ci4hsh/s4-a-conversation-hard-restart-2026-10-23T19-21-18.425Z.json` | `42C75D57EEC1E9C0FEF040C01E89C233B329015EB0676E38013724FFC820975D` |
| `evidence-ci4hsh/selector.json` | `DAB4E0A8C19A897D27187BF89382070A5973C7E521BFB0077143B78377FE41CF` |

This qualifies only the bounded S4-A unknown-outcome/fail-closed hard-restart
boundary. The quiet reread is 1.5 seconds, not a multi-day durability proof;
S4-B's durable external Approval recovery was not run and is not claimed.

Corrected-run private archive:
`.test-results/real-public-s4-a-conversation-hard-restart-N7ABeJ/`, including
`evidence-UAtPWL/` and
`retained-fixture-4b454e67-7889-47f6-9959-c8eea9c317ed/`.

| File | SHA-256 |
|---|---|
| `evidence-UAtPWL/provider-captures.jsonl` | `8AE802595CF008624A94713D5ADA0667B706021B36183B329863291C744AFD88` |
| `evidence-UAtPWL/s4-a-conversation-hard-restart-2026-10-23T19-02-41.879Z.json` | `325D372CDDD5C217FA6F657F420A4693A6D010DD8F81DA71EA0D0187AA0EE88D` |
| `retained-fixture-4b454e67-7889-47f6-9959-c8eea9c317ed/failure-evidence.json` | `CDB94665F9933CC9B4F821E76E8D73B5A74E9F14E729D3E8B0DA8FE82C6BD327` |
| `retained-fixture-4b454e67-7889-47f6-9959-c8eea9c317ed/arbor-functional.db-wal` | `24FCE47B91098068EED349EE523F3124CB509166DD32BA525A1619B88BEE1A08` |
| `retained-fixture-4b454e67-7889-47f6-9959-c8eea9c317ed/arbor-functional.db-shm` | `18E548A35995EB76261979288F06C41F59A4F56DC70204E4C99526AB4156A1DE` |
