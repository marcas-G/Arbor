# AH7 multi-action B effect-before-settlement — process qualification

Date: 2026-10-08

Status: **PASS for this Idempotent multi-action crash boundary; AH7 remains
PARTIAL / OPEN.**

Test: `tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts`

## Qualified sequence

The test uses one real ProviderTurn containing two ordered `patch` ToolCalls;
both are P4 `Idempotent`, have no invocation approval, and use the existing
public `GrantPermission(fs:write)` setup. The production daemon first commits
Action A and its Observation, advancing the AgentLoopStep cursor to 1. After a
process restart, B reaches the existing `AH7AfterToolEffectBeforeSettlement`
probe. At that exact boundary the B file has its expected marker, while B's
Action remains Pending and its same-identity P4 ToolInvocation intent remains
unsettled. The test kills that daemon, then restarts an ordinary production
daemon against the same database.

The restart reuses the same Execution/AgentLoopStep/ProviderTurn and B's
callRef/ToolInvocationId. Idempotent patch replay observes that B's insertion
already exists and completes the P4 Success settlement. The resulting durable
state has A and B Applied, cursor 2, exactly two ToolInvocations, ToolResults,
Artifacts and AgentLoopAction Observations. Both files retain their unique
marker exactly once; the original ProviderTurn has one Attempt and the
Provider action batch was requested once. The executor may be invoked again
under the same Idempotent identity; the test asserts the stable effect/result
and unique durable facts, not a single executor call.

## Validation

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts
1 file / 1 test PASS (64.54s)
pnpm typecheck
PASS
pnpm exec biome check tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts
PASS
git diff --check
PASS
```

This adds a multi-action P9 T2 Idempotent effect-after-crash qualification. It
does not exercise non-Success settlement Observation replay (AH7-DG-01),
Reconcilable reality proof (AH7-DG-02), approval/settlement atomicity
(proposed AH7-DG-03), or close AH7 as a whole.

## Independent integration revalidation (2026-10-08)

On base commit `904a3f9`, this process test was independently rerun: 1/1 passed
(64.27s). Complete `pnpm check` passed with Biome 946 files, TypeScript
typecheck/build, architecture 30 files/155 tests, core 315 files/1708 passed
+ 3 skipped, and Web typecheck/build plus 31 files/216 tests. The F20 clean
checkout and full release functional batch are to be rerun after this
test/documentation commit; AH7 remains PARTIAL.

## Full functional run and state-boundary correction (2026-10-08)

On commit `7f71058`, the first full `pnpm test:functional` run produced
**24/25 Vitest files and 58/59 tests**; Playwright did not run because Vitest
failed. This test's sole failing assertion expected `NextStepReady`, while the
read immediately after B became Applied observed the durable
`StepEffectsCommitted` state at `next_action_index=2` (revision 6). P9's frozen
state table permits `StepEffectsCommitted` to persist either a successor or a
settlement; `NextStepReady` is a later transition. The effect, settlement,
unique ToolResult/Artifact/Observation and file assertions all held. This was
an over-specific test-state expectation, not a production defect.

The test now pins the same Execution/Step/ProviderTurn and cursor 2, and accepts
only the two frozen valid progression states `StepEffectsCommitted` or
`NextStepReady`. All effect/result uniqueness assertions remain unchanged.
The corrected test passed twice in isolation (64.13s and 64.66s); test
typecheck and single-file Biome passed.

On committed `9157e9c`, F20 clean checkout passed 1/1 (50.44s). Full
`pnpm test:functional` passed: Vitest **25/25 files, 59/59 tests** (1701.69s)
and Playwright **2/2** (21.5s). This includes the corrected AH7 B case and P9
dense SSE qualification; AH7 remains PARTIAL / OPEN.
