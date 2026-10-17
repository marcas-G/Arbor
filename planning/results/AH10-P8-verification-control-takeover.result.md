# AH10 P8 Verification Control Receipt-First Takeover — Partial Result

Status: **IMPLEMENTATION PARTIAL; real-process qualification blocked by host deployment eligibility**

Base: `16b3fe8eee619934ef360822f921250284e47c59`.

Scope: generation-scoped receipt-first recovery for `RecordVerificationEvidence`
and `ConcludeVerification`, under the accepted VCS schema-46 contract and P9
prior-receipt contract. No migration, `docs/design/**`, or AH14 files were
changed.

## Implemented

- Both P8 control actions now derive CommandIds with the existing
  `generationScopedCommandId` encoding. Generation 0 retains the prior stable
  occurrence ID; later generations get generation-specific IDs.
- Takeover strictly decodes the registered current or explicitly allowed prior
  receipt schema. `ConcludeVerification` v2 can therefore decode its registered
  v1 prior receipt instead of incorrectly forcing schema 2.
- A prior committed receipt must bind the exact command, project, schema,
  fingerprint algorithm, actor, and semantic payload. Its registered
  `validateReceiptReplay` runs inside the transaction scope before any replay
  Observation/Settle is returned. P8's registered validators verify canonical
  Evidence or Verification/VerificationConcluded event/result facts; result
  identity is checked again at the control-action boundary.
- Only prior `FencingRejected` receipts are skipped for a newer generation.
  Other terminal rejection, unsupported/malformed receipt, absent validator,
  fingerprint mismatch, missing/conflicting canonical effect, or mismatched
  result fails closed without issuing a replacement command or producing an
  Observation/Settle.
- Added handler tests for both actions, including committed replay, schema-v1
  Conclude replay through v2 handler registration, fencing retry, non-fencing
  rejection, malformed result, fingerprint mismatch, missing validator, and
  canonical mismatch.
- Added one default-suite real-process C/P test for RecordVerificationEvidence
  at `tests/functional/process/agent-loop-ah10-verification-control-takeover.functional.test.ts`.
  It is not qualified on this host and the R−/R+ cases or Conclude process cases
  are not yet present.

## Verification

- `pnpm build` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check --write` on the three touched TypeScript files — PASS;
  no formatting changes were needed on the final run.
- `pnpm exec vitest run --config vitest.config.ts apps/single-workspace/test/verification-control-actions.test.ts --reporter=dot`
  — PASS (1 file, 21 tests).
- `git diff --check` — PASS.
- New P8 C/P process test — NOT QUALIFIED: production fixture daemon exited
  with readiness 503 after 60 seconds (`exitCode=1`, empty captured stderr).
- Existing AH10 baseline using the same worktree and production fixture
  (`agent-loop-ah10-generation-takeover.functional.test.ts -t "crashes the old owner before its fence receipt commit"`)
  failed identically, so this is not isolated to the new fixture.
- `pnpm build` ran before the baseline rerun; the generated
  `apps/single-workspace/dist/control-actions.js` was newer than the modified
  source. A direct no-DB daemon invocation also reported
  `P39_UNSUPPORTED_DEPLOYMENT` / `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`.
  PowerShell diagnostics say `Microsoft.PowerShell.Security` cannot autoload
  and `Get-Acl` is unavailable. The P39 production writer-lock/ACL eligibility
  semantics were not bypassed or weakened. Per direction, no further process
  retry was attempted after the existing AH10 baseline reproduced the host
  failure.

## Qualification still open

The mandatory six-case real two-daemon matrix is not complete: R−, R+, and C/P
for each of Evidence and ConcludeVerification. The single added Evidence C/P
test requires execution on a P39-eligible host; then add the remaining five
cases and verify exact evidence/event/result uniqueness and no provider replay.
No AH10 closure claim is made. Full `pnpm check` and full functional suite were
not run.
