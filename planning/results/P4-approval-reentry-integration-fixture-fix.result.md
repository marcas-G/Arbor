# P4 approval reentry integration fixture fix

## Finding

At baseline `f56dd869`, both focused approval reentry files failed before the
approval claim path. P40 Runtime now reads the current Workspace resource
boundary before resource resolution and checks it again during admission. The
older test layers supplied only `ProjectEnvironmentPort`, so the missing
`WorkspaceRepository` correctly produced `Denied(ResourceResolutionDenied)`.
That early denial caused the apparent missing Runtime approval ID and prevented
the expected pre-effect sandbox interruption.

The tests now supply the current same-project workspace, boundary revision,
and `/repo` worktree; each lookup asserts the requested WorkspaceId. No
production logic or approval assertion changed.

## Verification

- Focused P4/AH7 reentry plus P4 pipeline:
  `pnpm exec vitest run packages/tool-runtime/test/p4-ah7-approval-consumption-reentry.test.ts packages/tool-runtime/test/p4-approval-reentry.test.ts packages/tool-runtime/test/p4-pipeline.test.ts`
  — **3 files, 27 tests passed**. This includes same-invocation approval
  consumption/replay and the post-consumption authority-denial/no-executor
  case.
- First issuance durable-ID regression:
  `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/executable-approval-issuance.functional.test.ts`
  — **1 test passed**; it asserts the exact Pending approval is persisted and
  its durable ID/revision are returned.
- `pnpm build` — passed.
- `pnpm typecheck` — passed.
- Biome on both changed test files — passed.
- `git diff --check` — passed.

An independent review of the final test diff found no blocking issues. It
confirmed that WorkspaceId is checked and approval, freshness, and effect
assertions remain intact. No full `pnpm check`, functional release suite,
daemon, live environment, or existing database was run.
