# AH10 P8 Verification Control Receipt-First Takeover — Partial Result

Status: **IMPLEMENTATION PARTIAL; Evidence C/P qualified, remaining five real-process cases open**

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
  It proves gen0 Command/Evidence commit with Action Pending before the crash,
  then gen1 receipt-first replay and Observation/Action convergence. Evidence
  R−/R+ and all Conclude process cases remain open.
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
- Evidence C/P process — PASS (1 test, 25.5 s). The gen0 command/evidence was
  committed while Action remained Pending; gen1 replayed the prior receipt,
  persisted the Runtime Observation, and transitioned the Action to Applied.
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

The mandatory six-case real two-daemon matrix is not complete: Evidence R−/R+
and ConcludeVerification R−/R+/C/P remain. Evidence C/P alone does not close
AH10. No AH10 closure claim is made. Full `pnpm check` and full functional
suite were not run.
