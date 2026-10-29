# AH7 ProviderCall versus ToolResult oracle correction

Date: 2026-10-16

## Diagnosis

The release log's only failure was the assertion at the post-recovery
`source_ref` check in `agent-action-ah7-pending-intent.functional.test.ts`.
The run had two Provider calls for the target Work: the first decision emitted
the `read` ToolCall; after restart reused its durable identity and committed one
ToolResult, the follow-up Provider call consumed that ToolResult. The test
incorrectly equated ProviderCall count (2) with ToolResult rows for one exact
ObservationRef (1). AH7/P3/P4/P40 require one sourced ToolResult for the exact
observation, not one ToolResult per Provider call. No effect was replayed and
no runtime omission was found.

The shared AH durable-snapshot helper now reads its related execution,
AgentLoopStep, Action, P4 invocation, artifact and ToolResult rows in one
read-only SQLite transaction. The recovery assertions continue to check the
original/recovered logical action, `callRef`, invocation id and immutable P4
binding; they also assert exactly one ToolResult for the ObservationRef and
one target Provider request that emitted the read action.

## Verification

- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts -t "reuses the same action and tool identity after AH7BeforeToolSettlementCommit"` — **two consecutive runs passed, 1 passed / 7 skipped each**.
- `pnpm typecheck` — **PASS**.
- Biome on the changed helper and test — **PASS**.
- `git diff --check` — **PASS**.

No runtime or frozen design changes were made. No full functional suite was run.
