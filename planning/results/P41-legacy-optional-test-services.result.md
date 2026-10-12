# P41 legacy test service wiring result

## Scope

Base: `f56dd869` (`docs: record P41 integration full-check results`).

Legacy P2/P3/P6/P9 runtime fixtures now share
`tests/support/p41-optional-test-services.ts`. It composes the existing typed
SQLite `RecoveryAttentionFactStore` and `AttentionProjectionStore` adapters
against each fixture's existing schema. Those fixtures do not apply migration
0041, so the adapter readiness check reports the Submitted Decision source as
unavailable; no P41 table is created or queried by ordinary Work execution.
P41 source-absence tests keep their dedicated fail-closed setup and assertions.

The shared services are installed through the P6 application fixture and the
P2 driver/recovery, P3 integration, and P9 lease/recovery fixtures. The domain
event catalog test now includes the accepted
`SubmittedDecisionBindingEscalated` event while retaining its existing P6 and
P40 event expectations.

Production code and frozen design documents were not changed. Production
composition already provides the SQLite adapter; `runExecution` checks
availability only for a stopped `DecisionEpisode`, and the ordinary Work path
does not read P41 facts.

## Verification

- `pnpm typecheck` — PASS.
- Biome on the 9 changed TypeScript files — PASS.
- `git diff --check` — PASS.
- Focused P2 driver, P41 source-absence, and domain event catalog suites —
  3 files, 15/15 tests PASS.
- Broader P2/P3/P6/P9/P41 run — 9 files, 40 tests: 26 passed, 14 failed.
  The failures are the already-recorded F21 legacy fixture issue
  (`projects.resource_source_json` missing or decoded as invalid) plus the P9
  worker-crash W5 duplicate-escalation expectation. No P41 missing-service or
  source-absence assertion failed. This run does not qualify full `pnpm check`.

## Review

The helper delegates to the production adapters instead of fabricating P41
rows or installing migration 0041. Readiness is derived from the fixture's
actual schema. Consequently legacy schemas keep P41 disabled, while the
dedicated P41 negative tests continue to prove that unavailable storage fails
closed. The event catalog change is additive and leaves the existing P6/P40
events intact.

Open integration follow-up: resolve the independent F21 legacy fixture
failures and the P9 W5 assertion drift before claiming a green full check.
