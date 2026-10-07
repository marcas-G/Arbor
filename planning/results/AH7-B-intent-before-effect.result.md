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
pinned ProviderTurn keeps one sourced ModelOutput/decoded-output hash and one
successful ProviderAttempt; its two Action callRefs and B ToolInvocation
identity remain unique. A distinct successor ProviderTurn may make a legitimate
Text-only Provider call after the action batch; that is not replay of the
original decision.

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

The full `pnpm test:functional` run on `69ce796` reached 25/26 files and
64/65 tests before reporting one failure in this new test: a work-wide
`targetProviderCalls === 1` assertion observed 2 after the pinned actions had
completed. All original-turn, A/B identity, effect, ToolResult, Artifact,
Observation and cursor assertions passed. A follow-up Text response for a
separate successor ProviderTurn is legal; the oracle needed to be narrowed to
the pinned ProviderTurn/ModelOutput/action-batch identities rather than a
work-wide HTTP-call total. In the same run, F20 passed 1/1 (45.55s) and the
P9 dense SSE lease-renewal test passed 1/1 (10.73s); Playwright did not run
because the Vitest phase returned failure.

The test-local oracle has now been corrected: it reads the pinned ProviderTurn's
typed `AssistantMessage`/legacy ModelOutput and sourced ProviderTurnCall rows,
asserting one durable output, exactly the two patch callRefs for A/B, a stable
`decoded_output_hash`, and one successful Attempt for the original ProviderTurn.
It no longer treats a legitimate successor-turn Text call as replay. The P4
intent boundary, action/call/invocation uniqueness and one B effect remain
asserted.

```text
pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
PASS

pnpm exec biome check tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts
PASS

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts
1/1 PASS (64.70s)
1/1 PASS (63.76s)
```
