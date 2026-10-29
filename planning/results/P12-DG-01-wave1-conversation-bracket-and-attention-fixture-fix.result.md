# P12-DG-01 Wave 1 follow-up — failure-safe bracket and Attention fixture

Date: 2026-10-24

## Findings addressed

1. Conversation checkpoint compaction admitted a ProviderTurn and called
   ProviderRuntime, but an error skipped `completeProviderTurn`, leaving the
   matching lease-scoped in-flight gauge open. The path now matches success and
   failure, ends the bracket in either case, and re-fails with the original
   ProviderRuntime cause. Success reports its actual `attemptNo`; failure
   reports no ordinal (`undefined`) rather than fabricating a retry count. The
   driver only includes `retryCount` when an actual ordinal is known.
2. The P12 runtime-safety Attention test used the invalid string
   `work-runtime-safety` for a WorkId, causing its WorkEpisode fixture to be
   malformed. It now uses the file's parsed `workId` consistently in both the
   episode JSON and source binding. Production code and assertions are
   unchanged.

## Verification

- Conversation checkpoint compaction targeted success and failure cases:
  2 passed; 1 skipped by the test-name filter. The new failure case asserts
  gate → ProviderRuntime → end-bracket ordering, an undefined attempt ordinal,
  and propagation of the exact original `ProviderFailure`.
- `pnpm exec vitest run tests/p12-runtime-safety.test.ts --maxWorkers=1` —
  29/29 passed, including the Attention projection fixture.
- `pnpm exec tsc -b packages/agent-runtime --pretty false` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false` — PASS.
- Biome check on the six changed TypeScript files — PASS.
- `git diff --check` — PASS.

No Provider or daemon was run. No fixtures were removed or modified outside
the named test file.
