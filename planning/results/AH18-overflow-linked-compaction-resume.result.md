# AH18 linked overflow compaction recovery

Date: 2026-10-08

Status: **PASS for the linked Summary bootstrap and tested second-overflow
terminal boundaries; AH18/P9 qualification is not declared closed.**

Process test:
`tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts`

## Recovery contract exercised

The public production daemon receives a real OpenAI-compatible SSE
`context_length_exceeded` from the first Inference. It durably records the
terminal ContextLimit Attempt, then separately settles the ProviderTurn and
creates ordinal-0 Inference/OverflowCompaction links. The test hard-kills the
old process before the ProviderTurn failure transaction commits, at both
sides of the link transaction, and at both sides of the Summary
ProviderTurn+Manifest transaction:

| Probe | Independently readable state before kill |
|---|---|
| `AH18BeforeInferenceFailTurnCommit` | Terminal Attempt with typed ContextLimit, taxonomy, retry decision, canonical event prefix and delivered position is durable; ProviderTurn remains unsettled, Step is Prepared, and no overflow links exist. |
| `AH18BeforeOverflowLinksCommit` | ContextLimit Attempt and failed Inference Turn committed; link transaction remains uncommitted and externally absent. |
| `AH18AfterOverflowLinksCommit` | Same Step has exactly Inference + OverflowCompaction links at ordinal 0; Summary ProviderTurn/Manifest is NotFound. |
| `AH18BeforeSummaryTurnCommit` | Links are committed; Summary ProviderTurn/Manifest writes are uncommitted and externally absent. |
| `AH18AfterSummaryTurnCommit` | Links are committed; the same Summary ProviderTurn/Manifest is durable but has no Attempt yet. |

For `AH18AfterSummaryTurnCommit`, the persisted Summary `manifest_id`,
`manifest_json`, and `portable_request_json` are now compared byte-for-byte
across the pre-kill snapshot, post-kill snapshot, and recovered settled Turn.
This proves restart reused the committed Summary request binding rather than
rebuilding its Manifest.

After real lease expiry, ordinary daemon restart resumes the stable Summary
Turn, commits one Summary checkpoint and epoch 0→1, then runs exactly one
replacement Inference. Across all four link/Summary cases the original
inference request is not repeated; the same is verified for the pre-failTurn
case, where durable terminal Attempt evidence lets restart settle the original
Turn locally before forming links. There is one Summary request, one
replacement, one logical Step at `repairAttempt=0`, and exactly three
ordinal-0 link roles. The original Inference Manifest remains byte-identical.
The Summary success and replacement identity are retained, with no duplicate
checkpoint or additional overflow ordinal.

The RED showed gen1 failing `AgentLoopStepReplayBindingMismatch` when durable
links existed but the Summary receipt was NotFound. Recovery now validates the
original ContextLimit/link binding, records a pending compaction resume, then
waits until the same Session projection and `AgentStepContext` input are rebuilt
before calling Compaction with the link-pinned ProviderTurnId. NotFound creates
that exact turn; Unsettled delegates to ProviderRuntime's persisted manifest
and safe-retry checks. SettledSuccess retains the existing pinned-manifest
validation and checkpoint-recovery path. Other receipt, identity, or epoch
states fail closed.

## Fail-closed evidence

Three isolated negative tests corrupt only the test database after the real
daemon has created the linked overflow state; they do not synthesize the
Inference, ActionStep, or chain:

- A NotFound Summary ProviderTurn with an orphaned manifest row is rejected by
  `findManifestByTurn`; no Summary request, checkpoint, epoch advance, or link
  change occurs.
- An Unsettled Summary with a manifest context-epoch mismatch is rejected
  before ProviderPort; no checkpoint or replacement is created.
- An Unsettled Summary ProviderTurn whose stored epoch differs from the link is
  rejected before ProviderPort; no checkpoint or replacement is created.

Only these negative cases use SQL to inject the explicitly named corruption
after process kill. All positive chain formation and recovery is through the
real Scheduler/Provider/daemon path.

## Second overflow terminal branch

The custom Provider returns ContextLimit for the replacement as well. Existing
AH4 probes hard-kill before and after `SettlementProposed`; restart converges
to one Failed Execution with the same Step identity and
`ProviderFailure:ContextLimitExceeded`. The three provider requests (original,
Summary, replacement) each occur once; there is one checkpoint and only the
three ordinal-0 links, no repair-attempt increment, extra compaction, action,
or durable output.

## Verification

```text
Overflow bootstrap boundaries:
  pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts -t "resumes one ordinal-0 Summary"
  4/4 PASS

Original Inference failTurn pre-commit:
  pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts -t "original failTurn transaction"
  1/1 PASS

NotFound orphan manifest:
  same file -t "orphan manifest"
  1/1 PASS

Unsettled binding negatives:
  same file -t "Unsettled Summary binding is corrupted"
  2/2 PASS

Second overflow terminal proposal:
  same file -t "terminalizes a second ContextLimit"
  2/2 PASS

pnpm typecheck: PASS
pnpm build: PASS
Biome on changed files: PASS
Core regressions (p3-driver, p3-provider, provider-turn-project-store): 43/43 PASS
```

No full `pnpm check` or full `pnpm test:functional` was run for this batch.
The tests do not claim all AH18/P9 crash boundaries or AH15–AH19 closure.

## Independent integration rerun

On integrated source at `03b6c8637f63b4f6ef7275bd7b1d3c4eaa7c5673`, after a
fresh `pnpm build`, the complete AH18 process file passed 10/10 (548.72s), and
`tests/p3-driver.test.ts` passed 37/37. A full `pnpm check` was run twice:

- Run 1: Biome checked 955 files; typecheck and architecture 155/155 passed.
  Root Vitest reported 315/316 files and 1721 passed / 2 failed / 3 skipped.
  The two failures were in the existing
  `tests/provider-runtime-phase1.integration.test.ts`: (1) “whole turn deadline
  timeout aborts the Adapter…” reached Vitest's 30,000 ms test timeout while
  awaiting its `connected` deferred, with no assertion result emitted; (2)
  “turn deadline covers retry backoff…” matched `ProviderExecutionTimeout` at
  phase `TurnDeadline`, then expected Adapter `calls === 1` but observed `0`.
  The root Vitest process noted 316 workers spawned. This run exited before Web
  typecheck/build/tests.
- Focused diagnosis: those same two existing tests passed 2/2 in 4.29s
  (427 ms and 335 ms). This is diagnostic evidence only and does not replace or
  erase Run 1.
- Run 2: full `pnpm check` completed successfully: Biome 955 files, typecheck,
  architecture 155/155, root Vitest 316/316 files with 1723 passed / 3 skipped,
  Web typecheck/build, and Web Vitest 31/31 files / 216/216 tests. The first
  run's deadline-test failure remains recorded; these observations do not
  establish a product deadline defect. A deterministic test-oracle repair is a
  separate follow-up.

The complete F20 clean-checkout and `pnpm test:functional` gates have not been
rerun on this integration batch; they are to be run from the committed checkout
after the separate deadline-test-oracle follow-up. No test assertion was
weakened in this batch. Production composition leaves qualification probes
undefined; all added probe callbacks are guarded and carry no SecretRef.

The ContextLimit `failTurn` commit is already durable at both link probes. The
`AH18BeforeOverflowLinksCommit` hard kill occurs after the link writes have
been issued inside their transaction but before that transaction commits; the
independent snapshot proves rollback leaves the same durable no-link image as
immediately after `failTurn`, and restart rebuilds the links. There is no
separate probe at the exact instruction boundary between `failTurn` returning
and beginning the link transaction; this is the same durable recovery image as
the tested rollback case. The original `failTurn` transaction's pre-commit side
is now process-qualified by `AH18BeforeInferenceFailTurnCommit`; the terminal
Attempt is a separate prior commit, so the test does not conflate Attempt
settlement with ProviderTurn settlement.
