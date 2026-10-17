# AH10 P8 Verification Control Receipt-First Takeover — Partial Result

Status: **IMPLEMENTATION PARTIAL; the six-case P8 real-process takeover matrix is qualified**

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
- Fixed ConcludeVerification v2 receipt decoding: it now validates the exact v2
  result fields directly (including the production `wakeSignals` and
  `channel1Release` fields), rather than passing through the exact-key v1
  decoder. V1 continues to reject v2 snapshot fields. Added v1/v2 positive and
  negative codec coverage plus a prior-generation Conclude validator test using
  the registered production handler and canonical v2 event/snapshot facts.
- Added the default-suite real-process matrix for both controls at
  `tests/functional/process/agent-loop-ah10-verification-control-takeover.functional.test.ts`:
  committed receipt / Action Pending (C/P), stale-generation receipt fenced
  before commit (R−), and stale-generation receipt committed before takeover
  (R+). Each case checks generation/command identity, canonical effect and
  Observation uniqueness, action settlement, and no repeat provider execution.
- Added generic P9 resume cursor selection from durable `AgentLoopStep` rows,
  with binding validation against the exact persisted ProviderTurn manifest,
  plus cursor tests for in-progress resume and malformed/ambiguous histories.
- Added a focused `executeAgentLoopActions` integration test using real SQLite
  `TransactionPortLive` and `AgentLoopStepStoreLive`, real Control registry and
  `ControlActionAuthorizerLive`, and the registered P8 handler/receipt
  validator. It seeds step 0 `NextStepReady` → step 1 `ActionsInProgress`, a
  read Action already Applied and the P8 Control Action Pending; generation-1
  replay selects step 1 and proves the P8 Action becomes Applied, the cursor
  advances, and exactly one Runtime Observation is persisted.

## Verification

- `pnpm build` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check --write` on the three touched TypeScript files — PASS;
  no formatting changes were needed on the final run.
- `pnpm exec vitest run --config vitest.config.ts apps/single-workspace/test/verification-control-actions.test.ts --reporter=dot`
  — PASS (1 file, 23 tests).
- Cursor unit — PASS (7 tests).
- `pnpm --filter @arbor/agent-runtime build`,
  `pnpm --filter @arbor/persistence-sqlite build`, and
  `pnpm --filter @arbor/single-workspace build` — PASS.
- Focused Biome check and `git diff --check` — PASS.
- `pnpm exec vitest run packages/application/test/command-result-codec.test.ts apps/single-workspace/test/verification-control-actions.test.ts`
  — PASS (2 files, 31 tests); after adding the Gateway atomicity regression,
  the combined focused run of those files plus
  `apps/single-workspace/test/gateway-fencing-receipt-atomicity.test.ts`
  passed (3 files, 32 tests).
- `pnpm build` — PASS; `pnpm --filter @arbor/web build` — PASS.
- Production Gateway/two-connection fencing receipt atomicity test — PASS:
  the independent SQLite connection saw no receipt at the in-transaction
  pre-commit probe and exactly one receipt after transaction return.
- Evidence process cases — C/P PASS (previous qualification run), R− PASS,
  R+ PASS. ConcludeVerification process cases — C/P PASS (28.8 s), R− PASS
  (55.3 s), R+ PASS (62.3 s), all through the default functional process
  configuration with the P39 child environment intact.
- Thus the six P8 process cases are individually qualified. This does not close
  AH10's broader control-action/state matrix or the separate AH10 governance
  gaps.
- Root cause of the prior timeout was a test gate bug: the fixture sets
  `ARBOR_AH10_GATE_ACTION_KIND=record_verification_evidence` for both owners,
  but released only the old owner's `action-intent` gate. The gen1 test now
  waits for the same logicalActionId, asserts its exact durable tuple, and
  releases the new owner's `action-intent` gate before waiting for Control
  return. No production code or P39 safety behavior was changed for this fix.
- The single pre-fix diagnostic showed target Execution
  `exe_a8caf649-8e8f-71f5-8499-fdfced089c46` still unsettled under generation 1:
  step-0 read was Applied with a Succeeded ToolResult; step-1 P8 action was
  Control/Pending at cursor 0. It contained no `ExecutableToolInvocationRejected`
  settlement; the other observed ExecutionSettled events were unrelated
  Completed executions. The earlier EITR symptom is not attributable to this
  P8 action. Vitest global teardown removed the diagnostic fixture root.
- Existing AH10 baseline using the same worktree and production fixture
  (`agent-loop-ah10-generation-takeover.functional.test.ts -t "recovers a committed Deliverable receipt"`)
  passed after the Web build and explicit P39 environment propagation. The
  initial host eligibility issue was test-child `PSModulePath` loss; the fixture
  now passes `p39WindowsTestEnvironment()` to primary and secondary daemons,
  and a regression checks that a Node child can import
  `Microsoft.PowerShell.Security` and run `Get-Acl`. Production P39 semantics
  were not bypassed or weakened.

## Qualification still open

The P8 RecordVerificationEvidence / ConcludeVerification six-case matrix is
complete, but AH10 remains PARTIAL: other control actions, state combinations,
and the previously identified Deliver/verification governance gaps remain
outside this change. No AH10 closure claim is made. Full `pnpm check` and full
functional suite were not run.
