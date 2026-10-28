# S1–S4 Current-Candidate Pause Checkpoint — 2026-10-26

**Status:** PAUSED BY USER AFTER CURRENT RUN / NOT A FORMAL S1–S4 CLOSURE

## Candidate identity and repository state

- Branch: `codex/release-quick-hardening`.
- Committed and pushed base: `06337cac33b3b0eced35f0394f857c19140513be`.
- PR: `https://github.com/marcas-G/Arbor/pull/1`.
- All work below is uncommitted and unpushed.
- No `docs/design/**` file was changed.

Dirty implementation/test paths before this record:

```text
adapters/persistence-sqlite/src/session-repository.ts
adapters/persistence-sqlite/test/work-session-frontier-isolation.test.ts
apps/single-workspace/src/executable-tool-handler.ts
packages/ports/src/repositories.ts
packages/tool-runtime/src/runtime.ts
tests/capability/real-provider/public-s1-lifecycle.test.ts
tests/capability/real-provider/public-s2-supervision-steer-stop.test.ts
tests/capability/real-provider/public-s3-collaboration.test.ts
tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts
tests/functional/process/p38-executable-approval-public.functional.test.ts
tests/functional/support/sandbox-policy-v2-daemon-child.mjs
tests/p3-driver.test.ts
```

## Changes made in this interval

1. Added a real-provider S2 Critical `SteerWork` case covering a complete
   ContractAmendment, exact active-Execution quiescence, held old action
   rejection, restart and exact Command replay.
2. Strengthened real S1 wire checks: neither `shell` nor disabled legacy
   subagent tools may be advertised.
3. Strengthened and staged real S3 around exact Parent/Child ownership,
   stable Dependency wait, delayed Child permission, Child completion,
   Verification and Acceptance.
4. Corrected Work Session frontier behavior:
   - raw latest 64 Session-local rows are selected before filtering;
   - no older row is refilled after schema/owner filtering;
   - Work history spans same-Workspace Work Executions;
   - prior-Execution opaque reasoning is excluded, while portable text/tool
     history and current-Execution reasoning remain;
   - ConversationResponse owner isolation remains.
5. Corrected Native Disabled restart recovery: test-only composition wiring,
   durable `intentAt` replay, exact settled Native Denied recovery routing,
   and post-crash P3 settlement before P10 Attention projection.

## Passing evidence

### S1

The current dirty candidate passed the real-provider S1 lifecycle after the
final S1 oracle change:

```text
1/1 PASS, zero retry
Work effect → independent Verification PASS → human Acceptance → Completed
→ hard restart/read; shell and disabled subagent surfaces absent on wire.

.test-results/evidence-AEaGT0/
  PUBLIC-S1-REAL-2026-10-26T15-57-45.682Z-23e80a56-3c17-472f-a329-c82984398562.json
```

Scripted recovery and negative-verdict support passed:

```text
recovery-verdicts.functional.test.ts + s2-steer-work-revision.functional.test.ts
2 files / 7 tests PASS
```

This includes Verification Fail/Unknown keeping Work Open, provider outage
recovery, crash-after-wire answer dedup, pagination, and scripted revision /
Critical Steer binding.

### S2

Real-provider S2 passed before the later frontier/reasoning edits:

```text
Normal ContractAmendment + revised Verification/Acceptance  PASS
exact StopExecution + restart                               PASS
2/2 PASS, zero retry

.test-results/real-public-s2-normal-1d1fe152ec-WfWOAM/
  evidence-D79Fmb/public-s2-S2-NORMAL-1D1FE152EC-2026-10-26T13-24-04.594Z.json
.test-results/real-public-s2-stop-a157ccc612-GK4cr5/
  evidence-zK9iG4/public-s2-S2-STOP-A157CCC612-2026-10-26T13-24-50.905Z.json
```

The new real-provider Critical Steer case passed:

```text
1/1 PASS; two unrelated cases skipped by name filter
.test-results/real-public-s2-critical-06bd886794-SiSXhl/
  evidence-rLG2G4/public-s2-S2-CRITICAL-06BD886794-2026-10-26T13-29-49.699Z.json
```

### S3

After the frontier and prior-Execution reasoning corrections, the strengthened
real-provider journey passed:

```text
1/1 PASS, zero retry, 205.625s
Parent/Child formation with ownership carve-out → stable exact WorkspaceBound
wait → forbidden Parent-remainder patch Denied/no file → Child artifact /
Deliverable / Delivery → Dependency satisfaction → Child and Parent
Verification/Acceptance → terminal Work clearing.

.test-results/real-public-real-public-s3-real-s3-09aeb7da9d-MPNnVL/
  evidence-BbTEsu/real-public-s3-real-s3-09aeb7da9d-2026-10-26T15-52-54.976Z.json
```

### S4 and context/recovery

Real-provider S4-A passed before the later frontier/P38 fixes: unknown Provider
outcome after hard restart became NeedsAttention without unsafe replay.

The public-process S1–S4 black-box file passed 4/4, including accepted evidence
surviving hard restart without Provider replay. The Native Disabled daemon
smoke passed 1/1, and real S1 proved `shell` absent on the actual Provider wire.

P38 exact Native Disabled after-commit crash/restart was repaired and passed:

```text
target case 1/1 PASS (14 unrelated tests skipped), 45.6s
same durable NotAdmitted invocation → exact Native Denied replay → P3
TerminalRejected → ProcessExecutionUnavailable Attention → no effect/replay
```

AH19 targeted evidence after the frontier correction:

```text
P2 append/frontier adapter tests                         10/10 PASS
ModelContext/provider-request projection                1/1 PASS
latest-64 Work frontier after pre-checkpoint restart    1/1 PASS
ordinary Native compaction from public Work history     1/1 PASS (47.975s)
```

The broad four-file AH19 process batch was interrupted after exposing the old
oracle and production-window failures. It was not rerun as a complete batch.

## Problems found and fixed locally, but not committed

1. Work frontier filtered by current Execution and lost valid Work continuity.
2. Pre-checkpoint SQL filtered before `LIMIT 64`, violating raw latest-64 and
   no-refill semantics.
3. Prior-Execution opaque reasoning was replayed to the real Provider and
   caused `RequestRejected`; portable text/tool history must remain, but old
   opaque reasoning must not be ordinary history.
4. P38 denial replay used a fresh time instead of durable `intentAt`.
5. Disabled catalog hiding prevented replay of an exact settled Native Denied,
   producing `action/tool-unavailable` instead of P3 `TerminalRejected`.
6. P38 Attention was read while the after-commit hook deliberately left P3
   Pending; restart must settle P3 first.
7. The P38 test child passed its TrustedLocal option to the wrong layer.
8. Real S3 exposed prompt/orchestration races: premature AnyProducer,
   execution before Parent wait, Delivery without a later CompletionClaim,
   and integration before Child acceptance. The staged harness later obtained
   one clean PASS.

## Still open or not fully verified

1. **Final static gate is incomplete.** `pnpm build` and architecture
   (37 files / 194 tests) passed. The last `pnpm lint` and `pnpm typecheck`
   failed only on formatting/import ordering and TypeScript narrowing in new
   S2/S3 tests. Those sources were then formatted/fixed, but the complete two
   commands were not rerun because the user requested a stop.
2. **Final-code S2 was not rerun.** Normal, Stop and Critical passed before
   the last frontier/reasoning edits.
3. **Final-code S4-A and black-box S4 were not rerun.** They passed earlier in
   the interval, before the last context/recovery edits.
4. **Full P38, AH19, functional and package suites were not run.** Only named
   failure-driven cases were rerun.
5. There is no final dirty-candidate `pnpm check`, `pnpm test:functional`, or
   `pnpm test:package` PASS.
6. The frozen scenario matrices are broader than these real-provider slices.
   Clarification, escalation, insufficient-result/rework and every branch
   cross-product are either deterministic-test evidence or remain outside the
   bounded real journeys. This checkpoint does not relabel them as fully
   real-provider-qualified.
7. Direct B08 capability-harness execution failed before a Provider call
   because its separate `ARBOR_CAPABILITY_*` configuration was absent. The
   real S1 wire check proves the disabled surface for that request, but is not
   the three-run B08 stability batch.
8. Old real S4-B TrustedLocal shell approval remains in source but is
   superseded as a release gate by the accepted Disabled/qualified-Native-only
   boundary.
9. PR #1 and the remote branch still point to `06337cac`; none of these dirty
   fixes or this checkpoint record are pushed.

## Commands deliberately not run after the pause request

```text
pnpm lint                    final rerun
pnpm typecheck               final rerun
pnpm check
pnpm test:functional
pnpm test:package
final-code S2 real batch
final-code S4-A / S4 black-box batch
full AH19 / P38 matrices
```

## Complete S1–S4 run requested after the initial pause

The user subsequently requested one complete S1–S4 run and explicitly asked
that failures only be recorded, not repaired. The results below supersede the
earlier statements that final-code S2/S4 had not been rerun.

### S1 final run

```text
PASS — 1/1, zero retry, 51.291s
.test-results/evidence-8X9XCF/
  PUBLIC-S1-REAL-2026-10-26T16-01-39.116Z-1449c82e-fc5a-48b6-8697-ce55698ead71.json
```

### S2 final run

```text
PASS — 3/3, zero retry
Normal ContractAmendment                         41.509s
Critical ContractAmendment + exact quiescence   35.492s
exact StopExecution + restart                   34.052s

.test-results/real-public-s2-normal-1f7a02fad1-vp02n6/
  evidence-Ggu8qX/public-s2-S2-NORMAL-1F7A02FAD1-2026-10-26T16-02-54.100Z.json
.test-results/real-public-s2-critical-de02a733db-K4mW1B/
  evidence-QTKq8L/public-s2-S2-CRITICAL-DE02A733DB-2026-10-26T16-03-29.588Z.json
.test-results/real-public-s2-stop-fd81fefe3c-zg9fTU/
  evidence-Xb0iYs/public-s2-S2-STOP-FD81FEFE3C-2026-10-26T16-04-03.664Z.json
```

### S3 final run

```text
FAIL — 0/1, zero retry, test body 1,200.996s
Assertion: expected child evidence file kind `file`, received undefined.

.test-results/real-public-real-public-s3-real-s3-ec07175837-pABOfk/
  evidence-mXRLhb/real-public-s3-real-s3-ec07175837-2026-10-26T16-24-55.956Z.json
```

Observed before the failure:

- Parent and Child formation decisions were consumed.
- The exact WorkspaceBound Dependency existed and stayed Unsatisfied during a
  stable 814ms window.
- The same Parent Execution remained active and the Provider request count
  remained 11 throughout that window.
- No Child artifact existed during the wait, as required.
- The exact Child `fs:write` permission grant was created after the wait.
- No daemon errors were reported.
- The Child never produced the expected evidence file before the 20-minute
  journey deadline; consequently Delivery, Dependency satisfaction, Child
  Verification/Acceptance and Parent integration were not reached in this
  run.

This is a reproducibility failure: an earlier run of the same strengthened
journey passed, but the requested final complete round did not. Per instruction
it is recorded and left unfixed.

### S4 final runs

Real-provider S4-A:

```text
PASS — 1/1, 46.968s
Unknown Provider outcome after hard restart → NeedsAttention; no unsafe replay.
Old TrustedLocal S4-B and its gate test were skipped because that path is
superseded by the accepted Disabled/qualified-Native-only release boundary.
```

Public-process black-box:

```text
PASS — 4/4
Includes S4 accepted-evidence preservation after hard restart with no Provider replay.
```

Native Disabled / P38 replacement boundary:

```text
PASS — 2/2 selected tests; 14 unrelated P38 tests skipped by name filter
P38 durable NotAdmitted → restart → exact Native Denied → P3 TerminalRejected
→ ProcessExecutionUnavailable Attention                 42.041s
Native Disabled real Work request omits shell           12.612s
```

Full four-file AH19 process batch:

```text
FAIL — 47 passed / 1 failed, 2,193.57s
```

The only failing case was:

```text
AH19 ProviderNative binding recovery
reconstructs the public latest-64 Work frontier after pre-checkpoint restart
```

Failure details:

- post-restart Inference was not observed within 120 seconds;
- Work remained Open at revision 33;
- the Session contained 73 rows, with the tail through sequence 72;
- repeated revision-33 Work Executions settled `Interrupted`;
- `requestsAfterSteer=[]` and Provider call count remained 3;
- the daemon remained alive with no daemon errors;
- all other AH19 cases in the four files passed, including ordinary Native
  compaction, checkpoint crash sides, malformed/ambiguous Native evidence,
  binding match/mismatch, portable Summary rebase, and Conversation owner
  recovery.

Per instruction this failed latest-64 restart case is recorded and not fixed.

### Final unresolved result after the complete run

The requested complete round is **not green**:

```text
S1  PASS
S2  PASS (Normal / Critical / Stop)
S3  FAIL (Child evidence never produced in final 20-minute run)
S4  PARTIAL PASS, with one AH19 latest-64 restart failure
```

No repair, rerun, commit, push, PR update or merge is performed after recording
these final failures.

## Pause disposition

Per the user's instruction, work stops after the complete S1–S4 run and this
record update. No failure is repaired. No further test, commit, push, PR
mutation or merge is performed. Resume only after a later explicit request.

## 2026-10-27 sequential repair and second pause

The user subsequently authorized sequential repair, then requested a stop at
the next interruptible point. The following work was completed before that
pause; all changes remain uncommitted and unpushed.

### Repaired release-scenario failures

1. **S3 real-provider journey: PASS (1/1, zero retry, 166.096s).**
   - Work Session context now retains prior plain assistant history but removes
     a prior Execution's provider-specific reasoning/tool-call causal group;
     the current Execution's complete causal group remains.
   - The S3 stimulus now uses mount-relative Parent/Child paths, one canonical
     Dependency, one Child completion/Verification revision, and separates
     Parent `accept_result` from later integration.
   - Evidence:
     `.test-results/real-public-real-public-s3-real-s3-a81141b91d-zjzRkW/evidence-j7aaxe/real-public-s3-real-s3-a81141b91d-2026-10-27T14-17-58.642Z.json`.

2. **AH19 latest-64 restart case: PASS (1/1, 51.560s).**
   - `reconstructs the public latest-64 Work frontier after pre-checkpoint restart`
     observed the post-restart inference and completed within its bound.

### Static and focused gate repairs

- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- Architecture: 37 files / 194 tests PASS in the resumed `pnpm check` runs.
- Native schema 49/50 storage test: 5/5 PASS after updating its current-schema
  oracle from 52 to 54.
- P39 cumulative-prefix and claim-atomicity tests: 4/4 PASS after preserving
  their historical prefix assertions while including current migrations
  53/54.
- P43/P47/P48 migration registration tests: 8/8 PASS with the exact current
  suffix through 54.
- Runtime schema boundary: 15/15 PASS. It now admits exactly schema 54,
  rejects 52/53 as offline-upgrade-required and 55 as too new, and upgrades
  the schema-48 fixture through migrations 53/54. The duplicated heavy
  rejection matrix uses representative historical/boundary versions to avoid
  exhausting the Windows commit limit while preserving the generic boundary
  assertion.
- P5 executable/control vertical slice: 1/1 PASS after routing its explicitly
  TrustedLocal success qualification through the internal functional-test
  composition seam; production composition remains unable to enable
  TrustedLocal.

### Interrupted final gate at the requested pause

The full `pnpm check` was resumed in deterministic 10-file core batches after
two stale schema-oracle failures and one load-sensitive 30-second timeout were
fixed.

- Core batches 1–14 passed.
- Batch 15 passed 30/30 after the schema-54 migration no-op case received the
  same 120-second bound as the adjacent real-daemon case.
- Batch 16's other nine files passed; its former P5 failure passed separately
  1/1 after the functional-composition correction.
- Batch 17 passed 51/51.
- Batch 18 was still running the isolated exhaustive schema-upgrade operator
  when the user requested the next interruptible-point stop. It emitted no
  failure before termination, but has no completed result.
- Core batches 19–48 and the final Web typecheck/build/test stages were not run
  after the pause request.

Therefore the current candidate has focused PASS evidence for both previously
recorded S3/AH19 release failures, but **does not yet have a completed final
`pnpm check`**. No commit, push, PR update or merge was performed.

## 2026-10-28 resumed release convergence

The user resumed work through delivery. The base commit at the start of this
round was `06337cac33b3b0eced35f0394f857c19140513be`; the fixes below were still
dirty while the real journeys were used as failure-finding runs. Final
same-commit qualification is recorded in the next section after the release
commit is created.

### Real scenario results before final commit

- **S1 PASS, 1/1, zero retry.** Work effect, independent Verification,
  human Acceptance, Completed, and hard-restart readback:
  `.test-results/evidence-D6Bh6G/PUBLIC-S1-REAL-2026-10-28T09-35-32.293Z-fb3e3ab0-bdc9-4250-a705-1d111d870f78.json`.
- **S2 Normal PASS** and **S2 Critical PASS** in the combined three-case run.
  The third sequential fixture (exact Stop) exited before its journey with a
  public `fetch failed`; its retained evidence showed no daemon diagnostic and
  no semantic Stop failure. The exact Stop case then passed alone, zero retry:
  `.test-results/real-public-s2-stop-ad59bf458b-XG0y2z/evidence-Xv6Nrs/public-s2-S2-STOP-AD59BF458B-2026-10-28T09-40-25.567Z.json`.
  Normal and Critical evidence:
  `.test-results/real-public-s2-normal-c19f1f07d0-s1sClW/evidence-vVfRPL/public-s2-S2-NORMAL-C19F1F07D0-2026-10-28T09-36-55.369Z.json` and
  `.test-results/real-public-s2-critical-9b373a29cd-FPF2RS/evidence-bGd8qm/public-s2-S2-CRITICAL-9B373A29CD-2026-10-28T09-37-43.734Z.json`.
- **S4-A PASS**, plus the current first-release Native Disabled replacement
  boundary PASS (real Work request omits `shell`; durable NotAdmitted action
  restarts into exact no-effect Denied and `ProcessExecutionUnavailable`
  Attention). The public S1-S4 black-box suite passed 4/4, including accepted
  evidence preservation after hard restart without Provider replay. S4-A
  private evidence:
  `.test-results/real-public-s4-a-conversation-hard-restart-YP1rFY/evidence-sCs0g5/s4-a-conversation-hard-restart-2026-10-28T09-46-23.723Z.json`.

### S3 evidence strengthening exposed and closed a production context defect

The first run passed the public outcome, but review found that the test no
longer independently proved model-authored verifier controls. The oracle was
strengthened to bind each concluded Child/Parent Verification to its exact
verification Execution ids, real ProviderTurn ids, and Applied
`record_verification_evidence` / `conclude_verification` actions.

The first strengthened run then reproduced a real production failure. Parent
revision 4 repeatedly admitted a new Work Execution and immediately settled
`Interrupted` with
`SessionContextBlocked:ContradictoryTimeline:call_00_r8nIYuEuGPYJfnOl3wYe4928`.
The retained database proved a unique, otherwise closed pair:

- sequence 31: InboxEpisode-owned `ToolCall(wait)`;
- sequence 32: later Inbox Report input;
- sequence 33: the same call's `SessionFrontierRepair` Interrupted ToolResult;
- sequence 34: the later Parent steer.

`listWorkActiveFrontier` excluded the old Execution's ProviderTurnCall but let
the repair result through as ambient history, creating an orphan result in the
new Work context. The production SQLite frontier now resolves every
`SessionFrontierRepair` ToolResult through its callRef to the originating
ProviderTurn and Execution, so call and repair result are retained or excluded
together. The regression test proves both sides: current-Execution repair
remains visible, prior-Execution repair does not.

The repaired and strengthened real S3 journey passed, zero retry. Its audit
record contains `IndependentVerifierModelActionsApplied` for both Work ids:
Child used four ProviderTurns and Applied one evidence plus one conclusion;
Parent used five ProviderTurns and Applied two evidence actions plus one
conclusion. Evidence:
`.test-results/real-public-real-public-s3-real-s3-e19df5d8cc-XcmcsW/evidence-J6PSTf/real-public-s3-real-s3-e19df5d8cc-2026-10-28T10-16-04.044Z.json`.

### Pre-commit gates completed in this round

- `pnpm build`: PASS.
- Web production build: PASS (258 modules; only the existing >500 kB chunk
  warning).
- `pnpm typecheck`: PASS after the S3 frontier fix and verifier-oracle change.
- Biome for the changed S3/frontier files: PASS.
- Work frontier ownership regression: 2/2 PASS.
- Native Disabled selected process qualification: 2/2 PASS.
- Public S1-S4 black-box: 4/4 PASS.

The first resumed `pnpm check` reached architecture 194/194 and core batches
1-5 green, then was deliberately stopped at a batch boundary because the S3
review required a code/test change; it is not final evidence. Full
same-commit `pnpm check` and `pnpm test:functional` remain required after the
release commit.

### First same-commit gate attempt and load-bound correction

Commit `3cdc8ad357b7c24eade33803d547a84d32e56892` was the first clean release
candidate. Its `pnpm check` passed lint, typecheck, architecture 194/194 and
core batches 1-39, including the complete schema-upgrade batch (87 passed,
6 skipped). Core batch 40 had one failure out of 72 tests:

```text
tests/p3-driver.test.ts
carries a conversation-safe control result into the next turn before answering
30s default timeout; observed 32.364s
```

The exact case passed alone in 22.52s and the complete `p3-driver` file passed
51/51 in 74.57s. The case performs a full current-schema fixture plus a
two-turn durable control-result loop; its assertions and zero-retry policy are
unchanged, while its explicit per-case budget is now 60 seconds to remove the
batch-load false negative. This changes no production behavior or semantic
oracle. A new release commit and full final gates are required.

### Functional frontier-oracle correction

The first complete release-functional run after the load-bound correction
stopped at the historical AH19 latest-64 restart case. Runtime recovery and
post-restart inference succeeded, but the test expected frontier
`12..75`; production correctly emitted `13..75`. Sequence 12 was the
prior-Execution `SessionFrontierRepair` result that the S3 production fix now
excludes together with its originating call.

The oracle now follows the frozen ordering rule directly: select the raw
latest-64 typed rows first, then identify the rows actually projected by the
manifest's exact Session context refs. It retains the 64-row raw-window check
and no longer treats a deliberately filtered repair result as projected
context. The exact restart case then passed 1/1 in 54.478s, zero retry. This
was test-only alignment with the production ownership fix; no runtime behavior
changed.

### TrustedLocal functional-fixture correction

The next full functional attempt passed the entire AH19 provider-native file,
including both ordinary source-identity crash sides and the corrected
latest-64 restart. It then failed the first AH7 Reconcilable case before any
Work provider call (`workProviderCalls=0`, `manualWaitCalls=0`). The fixture
still expected `shell` to be model-visible, while production composition now
correctly fixes the first-release process mode to Disabled.

The correction does not restore a production escape hatch. The existing
functional-only TrustedLocal seam is now selected by `ah-crash-child.mjs` and
`ah10-process-child.mjs` only when the trusted P11 fixture explicitly exports
`ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION=1`; all other child runs still
use production `main()`. The exact AH7 NotAdmitted crash/recovery case then
passed 1/1 in 54.151s. Formatting, typecheck and the opt-in boundary remain
green.

The following full functional attempt passed both the complete AH19 file and
the complete AH7 Reconcilable file, then timed out in the Sandbox V6 registry
drift main scenario at 180 seconds. Retained evidence showed the exact cause:
the Work request had no `shell`, so no P4 intent, EAP, executable probe or P9
probe existed. The V6 test already used the functional daemon child but had
not opted into its test-only executable catalog. It now exports the same
explicit test-only flag for that scenario. The exact V6 main journey then
passed 1/1 in 63.087s, including the P9 terminal and fresh reapproval after
registry drift. Production composition remains Disabled by default.
