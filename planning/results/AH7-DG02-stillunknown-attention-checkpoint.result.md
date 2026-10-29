# AH7-DG-02 StillUnknown P9/P10 Attention checkpoint

Status: **Implementation checkpoint complete; real-process qualification
pending. AH7-DG-02 remains open.**

The accepted DID v1.40 P9 contract requires `StillUnknown` to keep the P4
invocation unsettled, preserve P3 `ReconciliationPending` / Execution
`OutcomeUnknown`, execute no Executor, and record the existing
`ReconciliationEscalated` event under the current Worker fence while the
Execution is still unsettled. P10 `02` projects that event as one
`ActionRequired` row keyed by the execution and invocation-reference
fingerprint.

Before this change, ordinary `OutcomeUnknown` action settlement returned from
P3 without recording that event. P9 `runRecovery` only recorded it for a Stop
candidate, while P3 settled ordinary StillUnknown executions before the next
recovery sweep could observe them.

## Implementation

- Added the P9 `makeReconciliationEscalationRecorder` path. It verifies the
  exact execution/fence binding, renews the same full Worker fence, rechecks
  that the same-project Execution is Active, and appends the existing P9 event
  only when its `(executionId, invocationRefsFingerprint)` identity is absent.
- Wired the P9 recorder into the production AgentLoop composition. P3 calls
  it before persisting its terminal `OutcomeUnknown` action, carrying the
  original principal, invocation refs and AgentLoopStep fence.
- Extended the P3 OutcomeUnknown unit case to assert the exact refs and fence
  passed to P9.
- Extended the existing StillUnknown real-process scenario to assert one
  P9 event and one visible P10 `ActionRequired` row after restart. This new
  process assertion has not yet been run.

No `docs/design/**` file, event type, Attention source, migration, P4
settlement rule or replay behavior changed.

## Evidence

- `pnpm typecheck` — PASS.
- Biome on the seven changed source/test files — PASS.
- `tests/p3-driver.test.ts -t "OutcomeUnknown action pending reconciliation"`
  — PASS, 1 test.
- `tests/p9-recovery-visibility.test.ts -t "StillUnknown escalation"` — PASS,
  1 test. It proves the recorder commits one event under a live Worker fence,
  leaves the Execution unsettled, and deduplicates a repeated call.
- `git diff --check` — PASS.
- The modified `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
  StillUnknown daemon scenario — NOT RUN pending coordinating-thread release.

This checkpoint does not claim real-process P9/P10 restart/rebuild
qualification or AH7-DG-02 closure. The process scenario must confirm P4
StillUnknown remains unsettled, P3 remains `ReconciliationPending`, the
Execution is `OutcomeUnknown`, P9/P10 produce exactly one visible Attention
row after restart, and Executor/effect counts remain zero.
