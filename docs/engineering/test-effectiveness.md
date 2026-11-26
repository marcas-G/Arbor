# Test effectiveness — diagnosis and remediation program

Status: adopted 2026-11-26. Owner document for the test-system overhaul
(architecture-evolution object 6 and the testing-pyramid landing).

## The weight is real

- 290,668 lines of test code against 180,988 lines of production code
  (1.61 : 1).
- 18 test files exceed 2,000 lines (largest 8,588).
- The functional lane boots real daemon processes and injects crashes
  via SIGKILL at 30 call sites; 72 files run serialized with bail=1 for
  30–40 minutes.

## The effectiveness ledger (2026-11-24/26, first-hand)

Every real defect found in this window, by who found it:

| Defect | Found by | What the tests were doing |
|---|---|---|
| 3 syntactically corrupted production files | TypeScript compiler | silent (correct — not their job, but 290k lines had nothing to say) |
| `read` tool unbounded allocation (OOM vector) | manual review | the read tool's tests never touched a large file |
| cast-to-never forged WorkspaceId bypassing root binding | manual review | permission tests covered ordinary denial, not the missing-project edge |
| catch-all swallowing policy resolution errors | manual review | the catch path had no coverage |
| 18 production-required services hidden as optional | architecture audit | tests were complicit — the optionality was their assembly shortcut |
| KP-021 recovery-count oracle flaky | — | the test itself became the defect source, two red master runs |

What tests did catch in the same window: one missing-service assembly
(the 12-minute fast lane) and, historically, provider-classification
defects via the conformance suites. Real, but thin against the
investment.

## Structural root causes

1. **Inverted pyramid.** Core recovery semantics are verified almost
   exclusively by "boot a daemon, kill it, count" mega-integration
   tests — slow, fragile, whole-chain (a failure does not localize).
2. **Timing-based crash injection.** Where injection is not
   probe-gated, the same code both passes and fails by scheduler luck,
   which discounts the proof value of every such test. (KP-021's own
   injection is probe-gated; its residual race is in the *target*
   process's concurrent call count — the oracle, not the injection.)
3. **Tests as a maintenance object.** Every architecture step had to be
   hand-replicated across 4–6 test assemblies (PR #4 missed one: 43
   runtime failures, typecheck clean). Tests did not modularize with
   the production code.

## Remediation batches

| Batch | Content | Status |
|---|---|---|
| B1 | **TestKit driver assembly** — `agentDriverTestDependencies` in @arbor/testkit provisions every typed driver requirement once; tests state deltas (scripted revisions, app-root capability layers). p11-acceptance and p11-controlbasis migrated as the demonstration. | this PR |
| B2 | Oracle precision for the recovery-count family — done for ah7/ah19. The ah7 `targetProviderCalls <= 2` bound is replaced by the invariants it was proxying: the reconciled-no-effect denial lands exactly once as a ToolResult, the crashed tool never re-executes (marker count), and post-denial model chatter stays inside MAX_TURNS. Diagnosis evidence: the scripted Text replies never claim completion, so the driver legally continues the turn loop until RuntimeSafety stops it — the stop point is timing-dependent (observed 2..6 calls on identical code), which is what raced the count bound. ah19's pre-restart wait drops the idle conjunct (projection-vs-idle boundary race) and steers 40 times so `rows > 64` is always satisfiable. Product behavior was verified contract-compliant (one denial, fail-closed, bounded). Stability: ah7 resourceChange 6/6, drift variants 4×3, ah19 3/3. | this PR |
| B3 | Capability-level test landing for the decision/action services (PR #8's ModelDecisionService is Layer-testable without a daemon); migrate the corresponding daemon-boot assertions downward. | planned |
| B4 | Effectiveness measurement as a convention: every real-defect fix records which test should have caught it (escape analysis) in the KNOWN_PROBLEMS/PR entry; a quarterly ledger turns the table above into a standing metric. | this PR (convention) + standing |
| B5 | The 18 oversized test files split by scenario family with the R5 campaign; fixture ownership preserved. | queued (R5) |

## Rules adopted now

- New driver-using tests assemble via `agentDriverTestDependencies`; a
  hand-built full service block is a review blocker.
- New crash-injection tests must gate on a durable probe event, never
  on wall-clock timing.
- Every PR that fixes a real defect states the escape analysis line:
  "should have been caught by X (missing) / X (why it failed)".
- Effect-based tests are authored with `@effect/vitest` (`it.effect`,
  TestClock, `it.layer`) per effect-conventions.md — adopted after
  surveying Effect's own package and OpenCode's test organization
  (flat scenario-family files, shared `test/lib`, recorded provider
  transcripts). Full migration; existing files convert when touched.
