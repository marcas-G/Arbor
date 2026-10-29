# AH7 shell@3 NotAdmitted scenario correction

Date: 2026-10-17

Status: **PASS for the corrected scenario; AH7 remains PARTIAL.**

The first crash scenario in
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
stops after a shell invocation is durably recorded but before it is admitted
to the executor. Its persisted approval row now confirms the frozen shell@3
`NonIdempotent` semantics. The scenario expectation was corrected to match
that catalog write. It resumes from the persisted ProviderTurn, executes once,
and completes with one artifact; the exact executable approval binding and
revision assertions remain in place.

The adjacent ambiguous-effect scenario had labeled an ordinary production
shell write `Reconcilable` without injecting the test-only reconciliation
profile. That impossible unprofiled case was removed. The ambiguous
`NonIdempotent` effect-before-settlement case remains. Scenarios that exercise
`Reconcilable` recovery continue to use explicit test-only reconciliation
mode/profile injection. Historical profile-less shell@2 recovery remains
qualified separately by
`tests/p4-schema44-profileless-shell2-recovery.test.ts`.

## Verification

- Root `pnpm build` and `pnpm --filter @arbor/web build` — PASS.
- Before correction, the requested targeted case failed with the database
  evidence `actual NonIdempotent` versus `expected Reconcilable`.
- After correction, the targeted case passed: 1 passed, 24 skipped.
- AH7 remains PARTIAL; this scenario correction does not qualify the broader
  reconciliation, non-Success replay, or takeover matrices.
