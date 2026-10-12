# P9 W5 Duplicate Escalation Result

Date: 2026-10-13
Base: `60cb569fab95b4d9d22b3ac32f4052f897ef12c7`
State: **W5 REGRESSION FIXED; TARGETED QUALIFICATION PASS**

## Diagnosis

The precise W5 case failed because `RecoveryResult.escalated` contained the
same Execution twice. In the legacy reconciliation branch, the Execution was
added as soon as pending invocations were found; the later unresolved-pending
disposition branch added it again before returning. The journal still had the
expected durable `ReconciliationEscalated` fact.

P40/P41 did not merge source families or make the W5 event count stale. P40
`ToolObservationReplayEvidenceEscalated` and P41
`SubmittedDecisionBindingEscalated` remain separate event types, facts, and
Attention identities. P41's optional test services exposed the duplicate
result path in this legacy P9 fixture; the W5 Execution is a Work episode and
does not enter the Submitted Decision binding branch.

## Change

Removed the premature `escalated.push` from the pending-invocation fact
materialization block. The later disposition branch remains responsible for
reporting this P9 escalation once. Durable event creation and its existing
`executionId + invocationRefsFingerprint` idempotency key are unchanged. No
cross-source deduplication was introduced.

## Verification

- Exact pre-fix W5 reproduction: failed with two identical Execution IDs in
  `recovery.escalated` (after the initial workspace build).
- `tests/p9-worker-crash.test.ts` + `tests/p9-recovery-visibility.test.ts`:
  **15/15 PASS**.
- The W5 test asserts exactly one durable `ReconciliationEscalated` row with
  the expected aggregate/execution ID, exact invocation refs, and matching
  `invocationRefsFingerprint` (not merely an in-memory result count).
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS on the source fix commit before the additional assertion.
- Biome on the changed runtime and regression test files: PASS.
- `git diff --check`: PASS.

Integration validation after cherry-picking onto `60cb569f` (fix commit
`4a10e8ce`, assertion/evidence follow-up recorded separately):

- Worker-crash + recovery-visibility: **15/15 PASS**, including the exact
  durable event assertion above.
- P9 acceptance Story B selection: **2/2 PASS**.
- P9 tool-outcome-unknown `TT4/NonIdempotent` selection: **1 failure** before
  the expected crash injection; observed
  `Cannot read properties of undefined (reading 'map')` instead of
  `harness-kill:tool-post-effect`. This was outside the W5 test and its one-line
  recovery-result change; no fix is claimed here.
- `pnpm typecheck`: PASS; Biome on `recovery.ts` and `p9-worker-crash.test.ts`:
  PASS.

No full `pnpm check`, daemon/process suite, live environment, or existing
database was used.

## Review

Diff review confirms the change affects only the redundant in-memory
`RecoveryResult` entry. P9's durable event and fingerprint-based deduplication
remain intact; P40 and P41 source identities remain independent. The existing
W5 exact-one assertion and recovery-visibility suite cover the regression.
