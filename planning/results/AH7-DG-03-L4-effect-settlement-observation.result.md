# AH7-DG-03 L4 effect, settlement and Observation qualification

Status: **targeted crash/restart boundaries PASS; L4 remains OPEN**.

This batch extends only test qualification seams and recovery tests under the
accepted P4/P3/P9 contracts. Executable calls use `approvalId = null` and
`requiresApproval = false`; the separate public Control approval is only for
Work admission. This is not approved-Executable handoff evidence.

## P4 effect / settlement / lease-fence evidence

- `tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts`:
  **1/1 PASS**, 69.88s. A real public ProviderTurn contains two ordered
  Idempotent `patch` calls. A commits and advances the cursor; B performs its
  workspace file effect, then the daemon is killed before P4 settlement. On
  restart, the same Execution/Step/ProviderTurn/callRef/ToolInvocationId
  replays the idempotent patch. Each distinct marker is present exactly once;
  A/B each have one P4 Success, ToolResult, Artifact and Observation; cursor is
  2; the original ProviderTurn/action batch is not regenerated. This asserts
  stable external effect and unique durable result, not one Executor call.
  For both ToolResults, `observationRef` equals the persisted Action
  `observation_source_ref`, the Session `source_ref` equals that ref, and each
  source occurs exactly once.
- `tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`:
  **1/1 PASS**, 17.65s. Two real daemon processes use generation 0/1. The old
  generation performs one allowed, no-approval shell append, then pauses before
  P4 settlement. After lease renewal is frozen and generation 1 takes over,
  releasing generation 0 yields a fenced settlement rejection; it cannot
  commit Success or append a successful ToolResult/Observation. The current
  generation records `OutcomeUnknown`; the actual marker remains exactly once
  and is not blindly replayed.
- `tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`
  uses real daemon crash/restart for P4 settlement transaction and P3 result
  boundaries. Each named case below passed as a targeted 1/1 run:
  - `AH7BeforeToolSettlementTransaction`: 39.86s. P4 effect/result Artifact
    are present, P4 intent is unsettled, Action remains Pending and no ToolResult
    exists; restart settles/reprojects the same invocation.
  - `AH7BeforeToolSettlementCommit`: 39.93s. The process is killed inside the
    P4 settlement transaction after the settlement update but before COMMIT.
    Independent durable state remains unsettled; restart retries and settles
    the same invocation exactly once.
  - `AH7AfterToolSettlementCommit`: 40.36s. P4 Success and Artifact are durable,
    while Action/ToolResult/cursor are not; restart converges the P3 projection
    without changing the canonical P4 result.

## P3 Observation / Action / cursor transaction

- A new `AH7BeforeActionResultCommit` qualification hook runs inside the
  AgentLoop transaction after Session ToolResult, Action transition and cursor
  update have been issued, immediately before the transaction returns for
  COMMIT. This is a process-local test seam, not a production route.
- `AH7BeforeActionResultCommit`: **1/1 PASS**, 39.96s. SIGKILL rolls back the
  complete P3 projection while the already committed P4 Success/Artifact remain.
  Restart reconstructs the same ToolResult, Applied Action and cursor from the
  same ProviderTurn/callRef/ToolInvocationId.
- `AH7AfterActionResultCommit`: **1/1 PASS**, 40.72s. The complete P3
  projection survives the kill; replay is idempotent.
- Both P3 cases assert the exact ToolResult `observationRef` equals both the
  Action `observation_source_ref` and Session `source_ref`, and exactly one
  ToolResult exists at that source. The same action-bound ProviderTurn remains
  stable.

## SideEffectSemantics distinction

The three-case real two-daemon effect-admission matrix
`tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts`
passed **3/3**, 53.49s:

- `NotAdmitted` Reconcilable recovery safely passes the new generation's fresh
  authority/fence/admission gate and produces one effect/result.
- `MayHaveStarted` Reconcilable recovery remains P4-unsettled and converges to
  `OutcomeUnknown`/`ReconciliationPending` without effect or ToolResult.
- `MayHaveStarted` NonIdempotent recovery commits P4 `OutcomeUnknown`, remains
  `ReconciliationPending`, and performs no external effect or replay.

The Control Work-approval row remains the exact consumed Control approval;
each executable ToolInvocation has null `approval_id`, and the fixture contains
zero Executable approval rows for that Execution.

## Validation and boundary

- `pnpm --filter @arbor/tool-runtime build`: PASS.
- `pnpm --filter @arbor/agent-runtime build`: PASS.
- `pnpm --filter @arbor/single-workspace build`: PASS.
- `pnpm --filter @arbor/web build`: PASS (required once because this isolated
  tree initially lacked `apps/web/dist`).
- `pnpm exec biome check` on touched TypeScript/JavaScript sources and
  `git diff --check`: PASS; `node --check tests/functional/support/ah-crash-child.mjs`:
  PASS.
- No full test suite was run. No design documents, main/integration tree, or
  production approval routing were changed.

This qualifies the listed P4/P3 process boundaries only. It does not qualify
active Reconcilable external-reality reconciliation, every action/settlement
permutation, or approved Executable handoff; AH7 remains OPEN.
