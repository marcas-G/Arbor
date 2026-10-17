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
  handler before the deadline. A one-shot structured diagnostic showed
  `DriverCursorSelected(logicalStepNo=1, ActionsInProgress, cursor=0)`, the
  pinned P8 manifest route, `classifyToolRoute=Control`, and
  `decode=RecordVerificationEvidence`. This excludes wrong cursor/turn and
  executable-vs-control misclassification. The process fixture deletes its
  temporary directory on cleanup, so the failed run's database is not retained
  for settlement provenance inspection.
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
