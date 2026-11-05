# P36 Integrated Full Qualification — Independent Review

Review date: 2026-10-11
Review type: read-only static evidence and repository-state review; no tests or
builds were run.

## Decision

**Blocking = 0.** The P36 qualification record is internally consistent with
the reviewed code and current repository state. This review does not reproduce
or independently certify the terminal output of either full runner.

## Reviewed identities and worktree

- Tested code SHA: `6ee3ccd9248defae439e57f01cc4b339cc32d641`.
- Qualification record SHA reviewed: `60872eb981cff298fa3f8cb6b95ac3df38c5b7da`.
- At review time, the detached worktree was clean at the qualification-record
  SHA. `6ee3ccd` is an ancestor of that SHA; the only change between them is
  `planning/results/P36-integrated-full-qualification.result.md`.
- The tested-code commit `6ee3ccd` changes only these two test files:
  `apps/single-workspace/test/p5-slice-acceptance.test.ts` and
  `tests/f21-create-project-resource-admission.test.ts`.

## Independently checked

- `package.json` defines `pnpm check` as lint, typecheck, architecture, core
  tests, Web typecheck/build, and Web tests. `pnpm test:functional` builds the
  project and Web client, then runs the functional Vitest config and Playwright
  config.
- The reported count arithmetic is consistent: 1,840 passed + 4 skipped =
  1,844 core tests. The other reported stage counts are presented as separate
  suites and are not summed together.
- The seven browser test definitions exist across the configured UI suite:
  F14/F15 approval and acceptance; F22 completed-Work visibility; two F21
  Profile/forged-reference cases; conversation restart; and two route/session
  isolation cases.
- The referenced F20 clean-checkout test and P9 dense-SSE lease-renewal test
  exist in the configured functional process/package suites.
- The two changes in `6ee3ccd` are test-only. The F21 change raises that test's
  timeout to 60 seconds without removing assertions. The P5 change enriches
  the assertion failure message with persisted invocation/Observation data;
  the `Success` expectation remains unchanged. No production file changed in
  that commit.
- The result record's scope caveats agree with the cited AH7 partial and P36
  Wave 2 records: the full gates do not close AH7, AH7-DG-02, or the
  production-approved Executable `InvocationApproval` route.

## Runner evidence not independently reproduced

This review did not run `pnpm check`, `pnpm test:functional`, any focused test,
build, or browser suite. Accordingly, these statements remain **reported by
the qualification record, not independently verified here**:

- `pnpm check` terminal success and its architecture/core/Web/Biome counts;
- `pnpm test:functional` terminal success, including 40 files / 171 tests and
  Playwright 7/7;
- the recorded F20 and P9 durations and their successful outcomes;
- the two earlier failing full-check attempts, isolated reruns, and their
  recorded durations;
- cleanliness at the start/end of those runs, restoration of the volatile P12
  artifact values, and the absence of leftover runner processes.

The result's arithmetic, suite configuration, and named test definitions were
checked statically, but source presence does not establish that those runners
completed successfully on the stated SHA.

## Remaining scope

The qualification record explicitly leaves P37–P41 and multi-subject behavior
open. No separate P37–P41 phase files were present in the reviewed
`planning/phases/` directory, so their open status is recorded here as stated
by the P36 result rather than independently established from phase records.
AH7 remains PARTIAL/OPEN; existing AH7 evidence continues to leave
reconciliation, approval/settlement atomicity, and other crash/restart branches
unqualified. This review makes no broader closure or release-readiness claim.
