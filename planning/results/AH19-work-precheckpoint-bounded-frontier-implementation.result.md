# AH19 Work Pre-Checkpoint Bounded Frontier — Implementation Result

Status: **Implementation changes and focused qualification complete; the fixed
full matrix and full repository release gates remain open.**

## Authority and fixed scope

- Implementation token: `AUTHORIZE_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_IMPLEMENTATION`.
- Fixed plan: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-implementation-plan.md`.
- Fixed plan SHA-256 after LF normalization: `C4A0775DA83AE9623D46639E760A4A45E372B5A380AF44B5FE699E068D374957`.
- Work-only implementation; no schema or migration changes.
- No `docs/design/**` changes; Conversation continues to use its existing history reader.

## Implementation

Added `SessionRepository.listWorkActiveFrontier`. Before the first typed
checkpoint, SQLite returns the latest requested number of schema-v2 Session
Timeline rows in sequence order and never fetches older ToolCalls to close a
ToolResult. After a typed checkpoint, it returns that checkpoint and every
later typed row without applying the pre-checkpoint limit. Generic timeline
readers remain unchanged.

Work startup checkpoint discovery, Native checkpoint receipt inspection,
context projection, and post-repair projection now share the Work frontier
reader. Non-Work episodes retain `listRecentEntries`. Existing P3 projection
and fail-closed decisions are unchanged.

## Focused evidence

- P2 SQLite + P3 projector targets: `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p2-session-append.test.ts packages/model-context/test/scrc-context-projector.test.ts` — **2 files, 15/15 tests PASS**. Covers exact 64-row selection/no causal refill, a filtered row retained in the selected input but omitted from P3 projection, an orphan result's exact `Blocked/ContradictoryTimeline` frontier, and a 71-row checkpoint-plus-tail frontier.
- Public Work→Native compaction: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "enters ordinary Native compaction from public Work Session history"` — **1/1 PASS**. The Manifest `inputFrontier` matches the persisted typed Session rows considered by that real Work request. This scenario contained 28 pre-checkpoint typed rows; it does not itself demonstrate the >64 process boundary.
- Native recovery, checkpoint commit not yet applied: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "recovers ordinary Native source identity at AH17BeforeCheckpointEpochCommit without replaying the ProviderTurn"` — **1/1 PASS**; real daemon crash/restart, no duplicate ProviderTurn.
- Native recovery, checkpoint and epoch commit complete: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "recovers ordinary Native source identity at AH17AfterCheckpointEpochCommit without replaying the ProviderTurn"` — **1/1 PASS**; real daemon crash/restart, no duplicate ProviderTurn.
- `pnpm exec biome check` on the six changed TypeScript files — **PASS**.
- `pnpm typecheck` — **PASS**.
- `pnpm architecture` — **32 files, 164/164 tests PASS**.

## Gates and remaining qualification

`pnpm check` stopped in its first Biome stage because an interrupted exploratory
functional run left the untracked generated directory
`.arbor-functional-schema44-aBwzvE/`; Biome reports that generated
`schema44-manifest.json` is not formatted. Recursive cleanup was rejected by
the execution policy, so this directory is excluded from the implementation
commit and reported as workspace residue. Full `pnpm check` must run on a clean
integration candidate.

The full core suite was started: batch 1/20 passed (20 files, 59 tests); it was
stopped after that batch under the focused-gate scope. Full `pnpm test` and full
`pnpm test:functional` were not completed.

The >64 selection and post-checkpoint >64 tail are qualified at the SQLite
adapter level. The real daemon crash/restart cases exercise both sides of the
Native checkpoint commit boundary but do not create >64 pre-checkpoint rows.
The filtered-row case is covered at the SQLite/P3 boundary, not yet through a
real checkpoint commit and restart. Per-request C0/C1 pinning remains on the
existing independent source/revision path; this increment did not change that
assembly, and the complete pinned-fragment matrix was not rerun here. These are
remaining qualification items, not claims of full AH19 closure.

## Changed scope

- `packages/ports/src/repositories.ts`
- `adapters/persistence-sqlite/src/session-repository.ts`
- `packages/agent-runtime/src/model-decision.ts`
- `adapters/persistence-sqlite/test/p2-session-append.test.ts`
- `packages/model-context/test/scrc-context-projector.test.ts`
- `tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts`
- this result record
