# Phase 2 — Executable Capability Harness Result

**Date:** 2026-09-27  
**Code snapshot:** `master@063d40d236ef` plus the pre-existing dirty worktree  
**Scope:** Test infrastructure, fixtures, runner, evidence capture, and case
representation only

## Deliverables

- `pnpm test:capability` runs the selected gray-box/component suites and
  generates a JSON + Markdown capability report.
- `pnpm test:capability:real` runs the same prerequisites, then invokes the
  isolated real-provider Vitest project with three repetitions when its
  explicit configuration is present. Missing configuration is reported as
  `NOT_RUN`, without a skip or provider request.
- B01–B14 each have an executable case-catalog representation and an
  L1/L2/L3 report row. B01 and B04 also have isolated real-provider test code.
- Suite-level classification records each Vitest file, collected test names,
  count, evidence level, and classification rationale in
  `suite-evidence-inventory.json`.
- `env.sh` forwards only the whitelisted `ARBOR_CAPABILITY_*` settings needed
  by the real-provider runner. A dummy-value container check and `bash -n`
  passed; no credential value was printed.

## Suite classification

The previous 1,253-case root suite, before Phase 2 additions, classified as:

| Project | L1 | L2 | L3 | MIXED | UNKNOWN | Total |
|---|---:|---:|---:|---:|---:|---:|
| Root | 54 files / 289 cases | 130 / 739 | 1 / 6 | 9 / 75 | 25 / 144 | 219 / 1,253 |
| `apps/web` | 21 / 163 | 2 / 10 | 0 / 0 | 1 / 4 | 7 / 31 | 31 / 208 |

Phase 2 added six root cases across three files. Current ordinary collection
is **1,259 root + 208 Web = 1,467 cases across 253 files**:

| Project | L1 | L2 | L3 | MIXED | UNKNOWN | Total |
|---|---:|---:|---:|---:|---:|---:|
| Root | 55 / 293 | 132 / 741 | 1 / 6 | 9 / 75 | 25 / 144 | 222 / 1,259 |
| `apps/web` | 21 / 163 | 2 / 10 | 0 / 0 | 1 / 4 | 7 / 31 | 31 / 208 |
| **Ordinary total** | **76 / 456** | **134 / 751** | **1 / 6** | **10 / 79** | **32 / 175** | **253 / 1,467** |

The separate real-provider project contains **2 L3 cases in 1 file**. Ordinary
L3 remains the six narrow P13 HTTP/WebSocket cases; those are not Agent
capability passes.

## Qualification run

`pnpm run test:capability:real` could not enter the runner because pnpm tried
to write the already modified lockfile and failed with
`ERR_PNPM_LOCKFILE_WRITE_FILE`. The same configured runner was then invoked
directly under the pinned Node 24 image:

```text
node scripts/testing/run-capability.mjs real-provider
```

It ran **232 root + 31 Web = 263 selected cases; all 263 passed**. The
provider variables were absent, so the isolated real-provider cases were not
launched and made no network calls. The generated report is
`reports/capability-real-provider-2026-09-27T20-03-10.924Z-9644ad7e-f35f-4aa5-9f6b-120b139dcf1f.md`
and its JSON counterpart.

The report was normalized after the run to keep B03's adopted control-route
case blocked even though its legacy/direct supporting suites passed. This
normalization changed metadata only; it did not rerun tests or alter suite
results.

## B01–B14 status

These are capability statuses for this run, not component-suite totals:

| ID | L1 | L2 | L3 | Real provider needed for L3? | Current reason |
|---|---|---|---|---:|---|
| B01 | PASS | PASS | NOT_RUN | Yes | External HTTP submission, daemon, duplicate submit, and transcript L2 sentinel passed; no real provider configured. |
| B02 | PASS | PASS | NOT_RUN | Yes | P4 execution/observation seams passed; S01 qualification remains unauthorized. |
| B03 | PASS | BLOCKED_BY_IMPLEMENTATION | BLOCKED_BY_IMPLEMENTATION | Yes | Direct/legacy send tests pass, but adopted ControlToolRegistry/AgentAction route is not authorized or implemented. |
| B04 | PASS | PASS | NOT_RUN | Yes | Existing recording-provider test proves request composition only; BLUE-WHALE recall/isolation test is implemented but awaits provider configuration. |
| B05 | PASS | PASS | NOT_RUN | Yes | Durable steer command tests pass; real next-turn cognition not run. |
| B06 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes for cognition | BlobStore bytes → SendMessage → durable Message/Inbox L2 sentinel passed; adopted model-facing route is absent. |
| B07 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes | Governed formation mechanics pass; model proposal requires the unauthorized adopted control route. |
| B08 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes | Specialist admission/settlement mechanics pass; model-selected adopted action is unavailable. |
| B09 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes | Matcher/deliverable mechanics pass; model-facing initiation route is unavailable. |
| B10 | PASS | PASS | BLOCKED_BY_DESIGN_GAP | Yes | Applicable G‑V2‑2, G‑V2‑3, and G‑V2‑4 source-reference/lifecycle gaps remain open. |
| B11 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes | Deterministic lifecycle gates pass; producer judgment route is unavailable. |
| B12 | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | Yes | SQLite recovery seams pass; process-level daemon restart plus cognitive continuation sentinel is not implemented. |
| B13 | PASS | PASS | NOT_RUN | Yes for model-visible recovery | Scripted provider/tool/worker failure cases pass; real model interpretation was not run. |
| B14 | PASS | PASS | NOT_RUN | Yes for generated response | Web component and transcript/pagination seams pass; full external submit-to-visible-reply UI case is not run. |

**No complete B01–B14 capability case is `CAPABILITY_PROVEN`.** The run has no
B-case `FAIL`; B01/B04 real outcomes are `NOT_RUN`, and the listed
implementation/design blockers remain visible. Historical S01 live failure
evidence remains recorded separately and was not qualified or changed here.

## Test-system findings

- `tests/p12-acceptance.test.ts` story 6 writes
  `planning/results/P12.restore-drill.json` through `runRestoreDrill()`.
  That test was not included in the capability runner. A harness-only
  isolation proposal is recorded in `08-known-failures.md`; neither its test
  nor artifact behavior was modified.
- The earlier `tests/p12-security-performance.test.ts:169` regression
  assertion remains untouched and is recorded in `08-known-failures.md`.
- Test-authoring checks found metadata, fixture-ID, and async-harness mistakes
  in newly added test code; these were corrected before the unified
  qualification run. No production failure was repaired.
- The qualification runner is repeatable through the direct pinned Node
  command above. The package aliases exist; pnpm invocation is currently
  blocked by the dirty lockfile write permission in this environment.

## Stop disposition

Phase 2 has 14/14 executable capability representations, a report generator,
suite inventory, B01/B04 real-provider test code, and a real-provider runner.
The first unified capability run is complete. No production code, Prompt, or
frozen design contract was changed.
