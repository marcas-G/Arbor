# Known Failures and Unqualified Claims

**Audit date:** 2026-09-27

## Current regression run

The pinned-container full Vitest run reported 1,253 tests: 1,252 passed and
one failed. It also reported 544 of 546 suites passed. The detailed failure
record identifies:

- `tests/p12-security-performance.test.ts:169`
- Test: “P12-013 §2 Information Trust Plane at the context boundary
  centralizes ContextFragment construction at the single boundary factory”
- Failure: expected one source match, observed two.

This is an observed failure in the current dirty worktree. Its cause has not
been adjudicated as test drift or product regression. This task does not repair
it. The aggregate reports a second suite-level failure without exposing a
second failed assertion in the captured record; preserve it as unresolved
runner evidence.

The normal pnpm command also encountered
`ERR_PNPM_LOCKFILE_WRITE_FILE` while trying to update the already modified
`pnpm-lock.yaml`. Direct Vitest was used under the pinned container. No lockfile
or production change was made for this audit.

## Test artifact side effect

`tests/p12-acceptance.test.ts` story 6 calls `runRestoreDrill()`, and
`apps/single-workspace/src/restore-drill.ts` writes
`planning/results/P12.restore-drill.json` at a repository-fixed path. The
worktree already contains a modified copy of that artifact, with a changed
timestamp/hash. Re-executing the test can change a tracked result file.

No test or production behavior was changed. Harness-only options for manual
review are to run the case in an isolated temporary worktree/copy, or to
snapshot and restore the artifact around the test. The current capability
runner does not include `tests/p12-acceptance.test.ts`.

## Capability facts that must remain visible

- `planning/results/WAVE1.generic-cognition.result.md` records a real Work
  sentinel failure: provider calls returned malformed/empty `arbor_directive`
  arguments and the Execution settled `Interrupted`. This is historical
  S01-related evidence; S01 qualification is currently unauthorized.
- `planning/results/wave1-live-human-input-evidence.json` records a narrow
  real-provider Human Input response persisted as `Answered`. It is not a
  complete external submission-to-transcript B01 result and proves no B04
  recall.
- P5 Session/restart tests prove persistence and recovery seams, not
  multi-turn cognition.
- The P14 closure result records that its smoke daemon did not produce an
  Assistant turn; deterministic write-back/transcript tests covered separate
  mechanics.
- Current P14 request-composition coverage includes recent answered turns but
  uses a canned provider response. Real memory use and unrelated-session
  isolation remain `NOT_RUN`.
- P4/P6/P7/P8/P9/P12 phase closures prove their scoped contracts and
  integration behavior. They do not automatically qualify the broader B01–B14
  model capabilities.

## Expected-fail disposition

No complete B01–B14 card has a fresh, executed black-box result that can
currently be labeled `FAIL`. Keep these distinctions:

- B03, B07, and B08 are blocked on the adopted model-facing control path; do
  not manufacture a failure by testing an unauthorized/legacy substitute.
- B10 is blocked by existing design gaps; do not invent reference fixtures to
  force a run.
- B02/S01 has a historical live failure, but the current authorization
  explicitly forbids S01 qualification. Do not convert that record into a
  current B02 result.
- B04 is `NOT_RUN`: current request composition is evidenced with a scripted
  provider, while real recall and session-isolation behavior remain unknown.

Thus the right current statement is “not proven / not run / blocked,” not a
prediction that every unimplemented or untested capability will fail.

## Existing design-gap blockers

B10 remains `BLOCKED_BY_DESIGN_GAP` under the existing source audits:
G-V2-2 ToolObservation identity, G-V2-3 durable conclusion summary reference,
and G-V2-4 initial Work VerificationMission lifecycle. These are not new gaps
found by this audit and must not be bypassed with fabricated fixtures.

No new Design Gap was established by the test run. The failed assertion is a
finding requiring review, not authority to alter frozen semantics.
