# AH7 B P4 intent before effect — process qualification

Date: 2026-10-08

Status: **PASS for this Idempotent action-B pre-effect crash boundary; AH7
remains PARTIAL / OPEN.**

Test: `tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts`

## Qualified sequence

The test uses one real ProviderTurn returning two ordered `patch` ToolCalls.
Both are P4 `Idempotent` and have no invocation approval; the test grants the
public `fs:write` permission. The first daemon commits Action A and its
Observation. The test kills it at `AH7AfterActionResultCommit`, then verifies
the same AgentLoopStep is `ActionsInProgress` at cursor 1, A is Applied, and
the A patch effect/ToolResult/Artifact/Observation are durable while B has no
file effect.

After restart, the same pinned ProviderTurn resumes B. The test-only
`AH7AfterToolIntentCommit` probe pauses synchronously after the P4
`recordIntent` transaction commits and before ToolRuntime opens the sandbox
handle or invokes the patch executor. It captures B's Execution, `callRef` and
`ToolInvocationId`; at this held boundary, SQLite proves that the same Step is
still at cursor 1, B is action index 1 and Pending, and B's P4 intent exists
but is unsettled. Only A has a ToolResult, Artifact and Observation, and B's
target file does not exist. No fixed sleep is used to infer this pre-effect
state.

The paused daemon is hard-killed. An ordinary production daemon restarts from
the same DB and executes the same B action using the same
Execution/AgentLoopStep/ProviderTurn/`callRef`/`ToolInvocationId`. The durable
Step reaches cursor 2; A and B each have one Applied action, Success
ToolInvocation, ToolResult, Artifact and Observation. The A file remains
unchanged; the B file contains its unique marker exactly once. The original
Provider action batch, provider request and ProviderAttempt each occur once.

This qualifies the T2 Idempotent pre-effect side only. It does not cover
NonIdempotent effect reconciliation, non-Success Observation replay
(`AH7-DG-01`), Reconcilable reality proof (`AH7-DG-02`), approval/settlement
atomicity (proposed `AH7-DG-03`), or close AH7 overall.

## Validation

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts
1 file / 1 test PASS (63.97s)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
PASS

pnpm exec biome check tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts
PASS

git diff --check
PASS
```

No production code, shared process fixture, or `docs/design/**` was changed.

## Independent integration verification (2026-10-08)

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts
1 file / 1 test PASS (64.61s)
```

This independent rerun confirms the same Idempotent B pre-effect process boundary;
it does not change AH7's PARTIAL status or the scope limitations above.
