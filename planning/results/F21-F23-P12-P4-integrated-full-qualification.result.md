# F21/F23 + P12/P4 Integrated Full Qualification

Status: **FULL LOCAL GATES PASS at the tested code SHA; not a release-readiness
claim.**

## Tested candidate and scope

- Integration worktree: `C:\Users\ThinkPad\.codex\worktrees\f21-open3-on-portnonce\Arbor`.
- Code SHA tested by both full gates: `8bc25c25c78700f278cfc03a6247aa7b86a59727`.
- Independent incremental review before the gates: Blocking = 0.
- Full gates ran in order, once each, on the frozen candidate:
  1. `pnpm check` — PASS.
  2. `pnpm test:functional` — PASS, after the complete check terminated successfully.
- No code, tests, or design files were changed during gate execution; no push or
  merge was performed. This result document is being committed after testing;
  that documentation-only commit is not the tested code SHA and was not itself
  rerun through either full gate.

## `pnpm check` — complete result

The repository script completed all stages successfully:

| Stage | Result |
|---|---|
| Biome | 1013 files checked; 0 errors, 1 existing `noNonNullAssertion` warning at `packages/agent-runtime/src/model-decision.ts:4070` (`loopSteps!`) |
| TypeScript build and test types | `tsc -b && tsc -p tsconfig.test.ts` PASS |
| Architecture | 31 files / 158 tests PASS |
| Core Vitest | 335 files / 1827 passed / 4 skipped (1831 total) |
| Web typecheck | PASS |
| Web production build | PASS; 254 modules; `index.js` 553.41 kB (166.66 kB gzip), CSS 57.83 kB (9.19 kB gzip); Vite emitted its existing >500 kB chunk-size advisory |
| Web Vitest | 33 files / 235 tests PASS |

## `pnpm test:functional` — complete result

The root script completed its build, Web production build, functional Vitest,
and Playwright stages successfully. The functional Vitest configuration used
`fileParallelism: false`; Playwright used one worker and zero retries.

- Functional Vitest: **38 files / 164 tests PASS**; duration 7504.69 seconds.
- Playwright: **7/7 PASS**; one worker, zero retries; duration 50.7 seconds.
- F20 clean committed checkout smoke: PASS within functional Vitest (50.980
  seconds).
- Browser cases passed: F14/F15 approval and Acceptance; F22 completed Work
  visibility; F21 Profile resource selection and forged-ref/path rejection;
  project conversation/restart; foreign-workspace deep-link privacy; and direct
  route, reload, project-picker, back/forward URL and WebSocket project scope.

## Generated P12 restore-drill artifact

The full check regenerated only the timestamp and restored-database hash in
`planning/results/P12.restore-drill.json`. After all full tests reached terminal
state, those two generated values were restored exactly to their tracked values:

| Field | Generated during gate | Restored tracked value |
|---|---|---|
| `timestamp` | `2026-10-10T21:51:27.824Z` | `2026-09-30T04:58:00.887Z` |
| `restoredDbHash` | `sha256:165c6cb0f1111c9ec65c923eddbbfcadcee7e4b8df57bd2dbc34a5e9ee64eec0` | `sha256:fc30c1931e23ee2f92c0a0c87807fe242aa18d50d13c4fc04d6160b581e3c821` |

No other file was restored or modified. Final HEAD remained the tested code SHA
before this result-only commit; `git diff --check` passed and the worktree was
clean after restoring the artifact.

## Earlier red evidence retained separately

The following failures belong to earlier candidates/rounds. They are retained
as historical evidence and are neither counted as failures nor overwritten by
this `8bc25c2` full-gate result.

- **Earlier Architecture red at `6fcbc17`:** 157 passed / 1 failed / 158 total;
  Core and Web did not run in that attempt. The failure was
  `tests/architecture/p10-architecture.test.ts` / `zero canonical mutation`,
  a static transaction-scope classification false positive in
  `activation-attention-reconciliation.ts`. The focused architecture repair
  and subsequent complete gate are recorded in
  `F21-open3-wave3-p10-story-l-full-rebuild.result.md`.
- **Earlier Core reds:** retain the separate initial failures for the newly
  introduced `WorkspaceResourceActivationChanged` event-set expectation, B01
  public conversation returning 403 where the old test expected 200, and the
  S1–S4 public API suite's invalid-request/400 timeout. These were addressed in
  isolated test/fixture and contract-alignment rounds; they are not folded into
  the current full-gate counts.
- **P32 compatibility fixture round:** the earlier Core result was 160/161.
  Its sole P32-related failure was the equivalent-schema fixture being cloned
  from P35 while dropping P33/P34 objects but not the two P35 activation tables
  and their two indexes (schema-object comparison 90 vs. 86); a follow-on
  upgrade assertion also still expected migration version 34 rather than 35.
  This was a fixture/version expectation issue, not a production regression.
  The later focused P32 qualification and current full results are distinct
  evidence.
- **AH19 seed timeout at `309c3ac`:** the earlier functional Vitest run had one
  AH19 seed failure; the script's `&&` chain therefore did not start
  Playwright. The captured snapshot remained at Root Work seed
  (`CurrentWork=null`, Inbox contained only `HumanConversation`) and did not
  reach Native candidate injection, lease, or restart. It is preserved as a
  prior-round timeout and does not establish a production ambiguity-recovery
  regression. This full run's AH19 tests are current-candidate evidence, not a
  rewrite of that historical run.

## Remaining boundaries — no release claim

These green local single-user gates do not close the following independent
scope:

- FT-DG-01 **OPEN-1** Profile-source audit and **OPEN-2** historical
  CreateProject v1 same-ID successful replay remain open.
- AH7 and AH10 remain **PARTIAL**; this broad suite does not close their entire
  action/state/concurrency/crash matrices or associated governance gaps.
- P15 remains local single-user v1. Multi-principal Project visibility and its
  visibility resolver are outside this qualification and remain open.
- Other explicitly open governance/release validation items are not implied
  closed by these full local gates.

Accordingly, this result establishes a successful full local check and
functional run on the stated code SHA only; it does not declare Arbor release
ready, close FT-DG-01 OPEN-1/OPEN-2, close remaining F23 governance gaps, close
AH7/AH10, or qualify multi-principal support.
