# P36 Integrated Full Qualification

Date: 2026-10-11
Tested code HEAD: `6ee3ccd9248defae439e57f01cc4b339cc32d641`
Prior targeted qualification: `planning/results/AH7-DG-03-P36-wave2-qualification.result.md`

## Result

**Full local gates PASS at the tested code HEAD.** This record qualifies the
listed repository gates on that SHA. It does not claim release readiness,
overall AH7 closure, or multi-subject support.

The worktree was clean at the start of the final gate and after completion.
No `docs/design/**` files were changed. The full check regenerated the two
volatile values in `planning/results/P12.restore-drill.json`; after the gate,
they were restored to their tracked timestamp and hash. The final test run
left no Vitest, Playwright, or `pnpm check` runner process.

## `pnpm check`

The complete script reached its terminal success state on
`6ee3ccd9248defae439e57f01cc4b339cc32d641`.

| Stage | Result |
|---|---|
| Biome | 1,018 files; no errors; one existing `noNonNullAssertion` warning at `packages/agent-runtime/src/model-decision.ts:4070` (`loopSteps!`) |
| TypeScript | `tsc -b` and test typecheck passed |
| Architecture | 31 files; 158/158 tests passed |
| Core Vitest | 337 files; 1,840 passed, 4 skipped (1,844 total) |
| Web typecheck | Passed |
| Web production build | Passed; 254 modules. Vite emitted its >500 kB advisory for the 553.41 kB JavaScript bundle (166.66 kB gzip). |
| Web Vitest | 33 files; 235/235 tests passed |

## `pnpm test:functional`

The repository's formal script completed both builds, functional Vitest, and
Playwright successfully on the same tested code HEAD.

| Stage | Result |
|---|---|
| Functional Vitest | 40 files; 171/171 tests passed; 7,917.61 seconds |
| Playwright | 7/7 passed; one worker; 54.0 seconds |

Selected release and recovery evidence within that full run:

- F20 clean committed-checkout install/build/start/public-process smoke passed
  (55.970 seconds).
- P9 dense SSE lease-renewal qualification passed (10.755 seconds).
- The seven browser journeys passed, including F14/F15 approval and
  acceptance, F22 completed-Work visibility, F21 Profile-based resource
  selection and forged-reference rejection, conversation recovery after
  restart, and workspace route/session isolation.
- Public-process coverage also passed for F10–F13, F16–F19, F23 receipt
  validation/ordering, and the listed AH7/AH10–AH19 recovery cases in the
  functional suite. These results are suite evidence, not a declaration that
  every associated recovery or governance matrix is closed.

## Earlier gate attempts and disposition

Two earlier full-check attempts on this worktree failed before the final
green run. Their failures are retained here as history; neither is counted as
a failure of the final candidate.

1. **Architecture timeout attempt, base `9d45463`.** The first `pnpm check`
   reached architecture with 29/31 files and 156/158 tests passing. The only
   failures were P8 and P9 “touched manifests add no dependency keys vs git
   HEAD”; each exceeded Vitest's 30-second timeout while taking about 42
   seconds in the cold, heavily loaded run. An isolated rerun passed both
   tests (2/2, 17.41 seconds, transform 1%). This identified a load-sensitive
   test timeout, not a manifest assertion failure. The complete check was
   rerun after that diagnosis.

2. **Core failure attempt, base `9d45463`.** Architecture passed (31/31 files,
   158/158 tests), but core Vitest finished with 335/337 files and 1,838
   passed, 4 skipped, 2 failed. F21's durable-Workspace/Profile-version
   restart case hit the default 30-second timeout during the high-load full
   run (reported actual duration 39.031 seconds). An isolated run passed the
   same case in 21.749 seconds with its durable claim, replay, and stale
   Profile assertions intact. Its test-local timeout was raised to 60 seconds;
   no assertions were removed.

   The other failure was the P5 shell pipeline assertion: the persisted
   invocation settlement was `ExpectedFailure` instead of the expected
   `Success` for `echo hello`. Its full-run failure did not expose the shell
   `exitCode`/`stderr`. Two isolated P5 runs then passed (5.042 and 5.462
   seconds). The success oracle and production behavior were left unchanged;
   the test failure message was extended to include the persisted invocation
   and Observation payloads so a future recurrence reports shell diagnostics.
   No root cause for that one-off `ExpectedFailure` was established by the
   isolated reruns.

The test-only timeout and diagnostic changes were committed as
`6ee3ccd9248defae439e57f01cc4b339cc32d641`. Biome passed on both changed test
files before commit. The final full check then passed, including the F21 and
P5 tests. This sequence records the initial reds and focused evidence rather
than treating a later green run as proof that the earlier failure never
occurred.

## Scope that remains open

The full green gates do not close AH7 overall or AH7-DG-02, and do not qualify
the production-approved Executable `InvocationApproval` handoff excluded by
the P36 Wave 2 authorization. P37–P41 remain open. Multi-subject behavior and
visibility are not covered by this single-user qualification and remain open.
No push or merge was performed.
