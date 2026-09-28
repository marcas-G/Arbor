# Initial Capability-Qualification Readiness Run

**Date:** 2026-09-27  
**Code snapshot:** `master@063d40d236ef` plus the pre-existing dirty worktree  
**Runtime:** `arbor-node24:24.21.0`, Node 24.21.0, Vitest 5.0.1  
**Provider mode:** `NONE` for this run; no live-provider variables were configured

## Regression baseline

The full existing Vitest suite was run in the pinned Node container. It was
run a second time only to extract the exact failed assertion after the first
report exposed a failed count. Both reports had the same summary:

```text
546 reported suites: 544 passed, 2 failed
1,253 tests: 1,252 passed, 1 failed
```

The identified failed assertion is recorded in
`08-known-failures.md`. A separate suite-level failure is present in the
aggregate but was not represented by another failed assertion in the captured
JSON details. The `pnpm exec vitest` invocation could not proceed because pnpm
attempted to write the already modified lockfile; the installed Vitest binary
was invoked directly inside the pinned container.

## Capability qualification

No complete B01–B14 black-box card executed during this run. Missing live
provider configuration left real-provider cases `NOT_RUN`; B02/S01 and
ControlToolRegistry qualification are also outside the current authorization.
The following is the qualification disposition, not a report of executed
black-box tests:

| Status | Cases |
|---|---|
| `BLOCKED_BY_IMPLEMENTATION` | B03, B07, B08 |
| `BLOCKED_BY_DESIGN_GAP` | B10 |
| `NOT_RUN` | B01, B02, B04, B05, B06, B09, B11, B12, B13, B14 |
| `PASS` | none |
| `FAIL` | none as a complete B01–B14 card |

The historical 2026-09-26 live Human Input evidence is cited separately in
`01-existing-test-evidence-audit.md`; it is not part of this run. No
capability is `CAPABILITY_PROVEN`.

## Stop boundary

The first qualification baseline is recorded. Product, Prompt, and frozen
design semantics were not changed. This result ends the initial audit pass;
the next test work is listed in `09-test-implementation-plan.md`.
