# Functional release validation sweep — 2026-10-23

Status: **RELEASE FUNCTIONAL QUALIFICATION NOT COMPLETE**.

The release manifest contains 62 files (56 Vitest files and 6 browser/UI
files), SHA-256 `d5e4a686275c268fa3f59ebc6531e19b71fcb6fdd869ebd8395067c4bb9beb24`.
The checks below were run serially in several commits while targeted fixes were
integrated. They are scoped evidence for their recorded commit and case; they
do not combine into a complete release pass on one SHA. The full
`pnpm test:functional` release profile has not completed successfully.

The package smoke was explicitly deferred. The six desktop Playwright/UI files
were later run on `0dd2742136feece736688844f4c819a825ce1d40`: 9 of 10 tests
passed and the P38 approve/resume browser case failed. No real OS sandbox
provider was qualified or shown to be usable. Synthetic V6 registry drift is
not evidence of a supported OS sandbox.

## Runner and build notes

The first release-profile attempt was `pnpm test:functional` on
`bfd6aae85110997f279d3b475e22ce1bcf77dac2`. Root TypeScript and Web builds
passed; Vitest stopped at 170 passed and 1 failed case, so the manifest result
is incomplete. Later work used one Vitest file at a time, `--retry=0`, one
worker, and per-file JSON and log output. The targeted pattern runs selected
only the named case; other tests in the file were skipped by the pattern.

The later per-file command form was:

```text
pnpm exec vitest run --config vitest.functional.config.ts --no-cache --no-file-parallelism --bail=1 --retry=0 --maxWorkers=1 --reporter=verbose --reporter=./scripts/testing/vitest-progress-reporter.mjs --reporter=json --outputFile <run-dir>/<file>.json [--testNamePattern <case>] <file>
```

Run-specific command lines, reporter progress, and JSON results are retained
under the `.test-results` directories listed below. Builds on later candidates
were reused only where the parent verified that production and Web build inputs
had not changed.

## Run segments

| Run directory | SHA | Result |
|---|---|---|
| `.test-results/2026-10-23T03-01-51-794Z-7308/` | `bfd6aae85110997f279d3b475e22ce1bcf77dac2` | Release attempt incomplete; 170 passed, 1 failed. Thirteen files completed successfully; `sandbox-policy-v6-registry-drift-restart.functional.test.ts` failed before the later test-only fixture fix. |
| `.test-results/2026-10-23T05-44-26-373Z-sweep/` | `16a1709b0c8d8bcede721dcba4b703a8d31321ac` | 18 individual files attempted: 16 passed, 2 failed. |
| `.test-results/2026-10-23T07-09-08Z-adcb524f-sweep/` | `adcb524f0eebb7e4ea40166dc00da8dfd3fc5e4d` | 15 files reached: 12 passed, 2 failed, and P39 writer-exclusion was hung and explicitly aborted after 931,106 ms. It is recorded as HUNG/ABORTED, not as a normal Vitest assertion failure. |
| `.test-results/2026-10-23T08-42-28Z-d89103-remaining2/` | `d89103d848c0b1a6b93e07f125b6fed0de9e5026` | RAI readmission 2/2 and recovery verdicts 6/6 passed. |
| `.test-results/2026-10-23T08-47-24Z-d89103-priority-retests/` | `d89103d848c0b1a6b93e07f125b6fed0de9e5026` | F21 full file 2/2 passed. Port-handshake had 11 passed and 1 failed before bail. Organization had 1 passed and 1 timed out at the configured 90 seconds. The exact P9 update_plan case failed to reach gen1 lease acquisition. |
| `.test-results/2026-10-23T09-31-36Z-46d811b7-postfix-qualification/` | `46d811b7b2db87d02d3a1fe462c2d83392a377f3` | F18 lease-claim exact case and P9 update_plan exact case passed. Port-handshake full file had 11 passed and 1 failed before bail. F18 live stage progress was read at 39,296 ms; a partial stage snapshot was saved. |
| `.test-results/2026-10-23T09-40-36Z-46d811b7-f21-v6/` | `46d811b7b2db87d02d3a1fe462c2d83392a377f3` | F21 online replay exact case failed its response-shape assertion. V6 fresh-root drift failed while waiting for executable approval. |
| `.test-results/2026-10-23T10-02-49Z-0dd274-port-f21/` | `0dd2742136feece736688844f4c819a825ce1d40` | Port-handshake full file 33/33 passed; F21 online replay exact case passed 1/1. |
| `.test-results/2026-10-23T10-10-28Z-0dd274-ui-desktop/` | `0dd2742136feece736688844f4c819a825ce1d40` | Six desktop Playwright files, 10 tests total: 9 passed, 1 failed. |
| `.test-results/2026-10-23T07-54-30Z-ae2630-ah7-case6/` | `ae2630eadd138881479ac735f697d8886afd7fdc` | AH7 `AH7BeforeActionResultCommit` exact case passed 1/1; the other seven cases in that file were skipped by name pattern. |

The exact case paths and failures below should be read together with these
run-local JSON reports; no failed case was retried.

## Completed file evidence by segment

The official `bfd6aae` attempt completed these 13 files successfully:

- `agent-action-ah7-reconcilable.functional.test.ts`
- `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `agent-loop-ah10-generation-takeover.functional.test.ts`
- `agent-loop-ah10-select-current-work-takeover.functional.test.ts`
- `agent-loop-ah10-send-message-takeover.functional.test.ts`
- `ah10-p10-attention-materialization.functional.test.ts`
- `ah18-overflow-linked-compaction-resume.functional.test.ts`
- `ah19-provider-native-binding-recovery.functional.test.ts`
- `f21-open3-activation-recovery.functional.test.ts`
- `p37-delivermessage-process-crash.functional.test.ts`
- `p38-executable-approval-public.functional.test.ts`
- `p4-ah7-effect-admission-takeover.functional.test.ts`
- `p4-ah7-live-lease-acquisition.functional.test.ts`

Per the checkpoint instructions, the sandbox V6 file was also treated as a
prior directed pass on `729b76d0fafd5c76f00808fce3edd647c912e0b7` when forming
the initial remainder. Its exact report was not found in this worktree. That
directed result is not counted as a current-SHA pass, and later full V6 coverage
on `46d811b` failed as noted below.

The `16a1709` segment passed these 16 files:

- `tests/capability/black-box/s1-s4-public-api.test.ts`
- `tests/functional/process/agent-action-ah7-p4-store-process-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-verification-control-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah11-step-effects-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah13-conversation-convergence-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah14-legacy-adoption-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah14-legacy-attention-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-two-action-interleaving.functional.test.ts`
- `tests/functional/process/agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`
- `tests/functional/process/agent-loop-ah9-terminal-action-recovery.functional.test.ts`
- `tests/functional/process/ah15-inbox-input-promotion-crash.functional.test.ts`

The `adcb524` segment passed these 12 files:

- `tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts`
- `tests/functional/process/ah19-conversation-checkpoint-owner-crash.functional.test.ts`
- `tests/functional/process/ah19-conversation-native-owner-match.functional.test.ts`
- `tests/functional/process/ah19-conversation-native-owner-mismatch.functional.test.ts`
- `tests/functional/process/command-input-validation.functional.test.ts`
- `tests/functional/process/cross-work-delivery.functional.test.ts`
- `tests/functional/process/cross-work-wake.functional.test.ts`
- `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts`
- `tests/functional/process/human-steer.functional.test.ts`
- `tests/functional/process/model-output-ah5-ah6.functional.test.ts`
- `tests/functional/process/p38-control-approval-current-assign-work.functional.test.ts`
- `tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`

The `d89103` remaining-process segment passed `rai-readmission-hold.functional.test.ts`
(2/2) and `recovery-verdicts.functional.test.ts` (6/6). Its priority retests
passed the full F21 rebuild file (2/2). The final `0dd274` port-handshake file
passed 33/33; the F21 online exact replay case passed 1/1. Those are the latest
complete-file and targeted replay results respectively.

The `0dd274` desktop browser run used the existing Playwright configuration:
headless Microsoft Edge on Windows, one worker, retries zero, default desktop
viewport, and the schema-44 Playwright global setup. It passed F14/F15,
completed Work visibility, both F21 browser cases, P38 reject/expired approval,
project conversation, and both route/session cases (9/10 total).

## Failures, incomplete cases, and diagnostics

- On `bfd6aae`, the V6 drift file failed at setup because the synthetic D2
  artifact destination already existed. A separate pass was reported for
  `729b76d0`, but its exact artifact was not found here.
- On `16a1709`, `agent-action-ah7-pending-intent.functional.test.ts` failed at
  `AH7BeforeActionResultCommit` during fixture restart with
  `P39MaintenanceFailure/P39_UNSUPPORTED_DEPLOYMENT` (5 passed, 1 failed, 2
  left unexecuted). On `ae2630`, that exact case passed 1/1. The original cause
  remains undetermined; do not infer a production fix from the single targeted
  rerun.
- On `16a1709`, `agent-loop-ah10-submitted-decision-binding-takeover` failed on
  the manifest-mismatch before-commit path because the recovery daemon raised
  `ExecutionDriverInvariantFailure(AgentLoopStepReplayBindingMismatch)`.
  A fix was integrated later; this sweep does not claim all AH10 bindings pass.
- On `adcb524`, the F21 full rebuild worker failed with
  `SqliteAdapterError: database user_version 44 requires an offline upgrade to
  schema 51`. The complete file passed 2/2 on `d89103`.
- On `adcb524`, the F18 `AfterSourceValidationBeforeClaim` assertion expected a
  specific injected-crash diagnostic; the daemon exited 86 with the exact
  `F18_TEST_CRASH` marker but the wrapper's generic startup message did not
  include the expected stderr. The `d89103` full organization file then passed
  its first case but timed out in `AfterReconciliationLeaseClaimCommit` at
  90 seconds. That exact case passed on `46d811b` in 40.1 seconds, within its
  665.5-second case budget; stage progress is retained in
  `f18-stage-progress-observed.json`.
- The `P9 direct Control effects` file on `ae2630` had 9 passing cases and one
  failure: gen1 did not reach `AH10AfterLeaseAcquired` for stale `update_plan`.
  The exact case failed again on `d89103` with a public wait timeout, then
  passed on `46d811b` in 42.7 seconds. No full P9 direct-control file pass was
  recorded on `46d811b` or `0dd274`.
- Port-handshake diagnostics changed across candidates. On `d89103`, the full
  file had 11 passed and one failure because the wrong-port startup error did
  not include the old requested/reported port text; another run failed because
  startup evidence expected `functional daemon exited before HTTP readiness`
  but received the normalized `functional daemon startup failed` reason. The
  full file subsequently passed 33/33 on `0dd274`.
- On `46d811b`, F21's online replay exact case failed because it expected the
  original receipt body directly, while the endpoint returned a committed
  command envelope containing the result. The exact case passed on `0dd274`.
- On `0dd274`, the desktop P38 executable-approval approve/resume browser case
  failed: the browser-side effect counter remained 0 instead of 1 after 45
  seconds. The reject and expired-approval browser cases passed. Screenshot,
  trace, and Error Context are retained in the UI run's `artifacts` directory.
- The V6 full file on `46d811b` failed at the new fresh-root drift branch: the
  public executable-approval wait timed out while the HumanConversation Inbox
  entry remained unconsumed. This qualifies no real OS sandbox provider. A
  later isolated V6 action-oracle diagnostic completed in another worktree
  with 1 failure; the fresh-execution approval timeout remains unresolved, and
  no real daemon or OS sandbox provider was qualified by that diagnostic.
- The P39 writer-exclusion case on `adcb524` hung in the shared/exclusive
  lock test. After 931,106 ms, the wait graph showed the contender waiting on
  SQLite while cleanup could not send `release` to the exclusive-lock helper.
  The exact Vitest/worker/helper processes were stopped with parent
  authorization, the temp SQLite file was preserved, and the case is recorded
  as **HUNG/ABORTED**, not as a normal assertion failure. Evidence:
  `.test-results/2026-10-23T07-09-08Z-adcb524f-sweep/p39-writer-exclusion-hang.json`.

## Not run / not qualified

The following package entry was deferred under the task instructions:

- `tests/functional/package/clean-checkout.functional.test.ts`

The remaining process file inventory was exercised across the recorded SHA
segments, but several tests were skipped after file-level `--bail=1` failures,
and the evidence spans multiple commits. Later fixes received targeted or
file-level qualification only. There is no complete `pnpm test:functional`
result with `completeCoverage: true` on `0dd2742136feece736688844f4c819a825ce1d40`;
therefore release readiness remains open.
