# AH10 P8 Verification Control Receipt-First Takeover — Partial Result

Status: **IMPLEMENTATION PARTIAL; real-process qualification remains open after gen1 handler-entry diagnosis**

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
  but gen1 has not reached the post-Control-handler boundary. R−/R+ and
  Conclude process cases are not yet present.
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
- `git diff --check` — PASS.
- New P8 C/P process test — NOT QUALIFIED: it did not reach the post-handler
  boundary; gen0 C/P facts were committed, while gen1 reopened the exact
  logical step/action and route as a Control action but did not return from the
  handler before the deadline. In the single final detailed diagnostic, the
  target Execution `exe_a8caf649-8e8f-71f5-8499-fdfced089c46` remained
  unsettled under lease generation 1. Its step-0 read Action was Applied
  (ProviderTurn `ptn_exe_a8caf649-8e8f-71f5-8499-fdfced089c46_0`, action index
  0, logicalActionId
  `lac_007078be233095776d489af68987b035683a63b5d7da24e92e75c11a49ca5333`,
  callRef `call_19e7bc6594994e1db335f26d21bd98b7`, resultRef
  `result_2a75517d2415fe81fefc7f3107f15a29bcede0ce579aaedff6d663f293caf8e5`)
  with one canonical `Succeeded` ToolResult for invocation
  `tin_018f2b3c-4d5e-7abc-8def-bfc9b4f67174`; step 1 was
  `ActionsInProgress`, cursor 0, and its action was Control
  `record_verification_evidence`, Pending (ProviderTurn
  `ptn_exe_a8caf649-8e8f-71f5-8499-fdfced089c46_1`, action index 0,
  logicalActionId
  `lac_32eb67cbe08146a75661cb7c717e23305decf4eca2faf78f3080b50fee9b67c9`,
  callRef `call_5cb9025ad99c417396f50b3b6789860a`, no resultRef).
  The pinned route is Control v2 and the route-classification event is
  `Control/core.control.record-verification-evidence`. The same diagnostic
  contained no `ExecutableToolInvocationRejected` settlement and no target
  Execution settlement. The only three `ExecutionSettled` rows were for other
  Execution IDs and all were Completed (assign conversation, seed Wait, and
  claim completion). Thus the earlier EITR symptom is not attributable to this
  P8 action or target Execution; its prior-run origin remains unproven.
  The P8 handler-return timeout itself remains unresolved. The fixture requested
  `preserveDirectoryOnStop`, but functional Vitest global teardown removed the
  entire `.arbor-functional-schema44-*` root after the test; no database was
  retained.
- Existing AH10 baseline using the same worktree and production fixture
  (`agent-loop-ah10-generation-takeover.functional.test.ts -t "recovers a committed Deliverable receipt"`)
  passed after the Web build and explicit P39 environment propagation. The
  initial host eligibility issue was test-child `PSModulePath` loss; the fixture
  now passes `p39WindowsTestEnvironment()` to primary and secondary daemons,
  and a regression checks that a Node child can import
  `Microsoft.PowerShell.Security` and run `Get-Acl`. Production P39 semantics
  were not bypassed or weakened. No daemon was rerun after the one-shot
  structured gen1 route diagnostic.

## Qualification still open

The mandatory six-case real two-daemon matrix is not complete: R−, R+, and C/P
for each of Evidence and ConcludeVerification. The gen1 handler hang remains
unlocated: static review and the focused integration unit show the authorizer,
SQLite transaction nesting, real Control registry, P8 validator, and P9 action
transition return successfully in isolation. The process failure's
`ExecutableToolInvocationRejected` provenance cannot be attributed to a
generation from retained evidence: the fixture cleans up its database, and the
current schema has no settlement-writer generation field. Further process
qualification should wait until the retained failure output or another
approved bounded diagnostic identifies the settlement source; only then add
the remaining five cases and verify exact uniqueness and no provider replay.
No AH10 closure claim is made. Full `pnpm check` and full functional suite were
not run.
