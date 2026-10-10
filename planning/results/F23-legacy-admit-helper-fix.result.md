# F23 Legacy AdmitExecution Helper Fixture Convergence

Date: 2026-10-10
Scope: minimal compatibility fix required by F23 Wave 3 typed internal validation

## Result

The legacy `apps/single-workspace/src/loop.ts::admitExecution` helper emitted
both the superseded `focus` field and the current `episode` field in new
`AdmitExecution` payloads. The registered closed descriptor permits the exact
`episode` contract and rejects `focus` before Gateway transaction entry.

The helper now writes only the current `WorkEpisode` binding. The `focus`
argument remains the helper's way to select and read the Work; its value is
represented in the persisted payload by the exact `WorkEpisode` and observed
Work revision. No legacy compatibility write, authority change, or test-only
Gateway bypass was added.

## RED / GREEN evidence

- Before the change, `pnpm exec vitest run apps/single-workspace/test/i0-send-message-durable.test.ts`
  failed with `InternalCommandContractDefect` for `AdmitExecution`, issue rule
  `unknown-field`. The helper's pre-fix payload contained both `focus` and
  `episode`.
- After the change, `pnpm exec vitest run apps/single-workspace/test/i0-send-message-durable.test.ts apps/single-workspace/test/p5-slice-acceptance.test.ts`
  passed: 2 files / 2 tests.
- `pnpm typecheck` — PASS.
- Biome check on `apps/single-workspace/src/loop.ts` — PASS.

This fix only addresses the helper defect. Other old test fixtures that
directly submit legacy episode or settlement shapes remain to be migrated by
the fixture task; no full check or functional suite was run.
