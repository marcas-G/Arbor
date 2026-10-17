# AH19 Work Pre-Checkpoint Bounded Frontier — Implementation Result

Status: **Scoped AH19 Work bounded-frontier implementation and fixed
qualification matrix COMPLETE.** The full repository `pnpm check` is deferred
to the clean mainline candidate; this result does not claim full AH19 closure.

## Authority and fixed scope

- Implementation token: `AUTHORIZE_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_IMPLEMENTATION`.
- Fixed plan: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-implementation-plan.md`.
- Fixed plan SHA-256 after LF normalization: `C4A0775DA83AE9623D46639E760A4A45E372B5A380AF44B5FE699E068D374957`.
- Work-only implementation; no schema or migration changes.
- No `docs/design/**` changes; Conversation continues to use its existing history reader.

## Implementation

Added `SessionRepository.listWorkActiveFrontier`. Its API accepts no caller
limit; the SQLite adapter owns the fixed 64-row pre-checkpoint bound. Before
the first typed checkpoint, it returns the latest 64 schema-v2 Session
Timeline rows in sequence order and never fetches older ToolCalls to close a
ToolResult. After a typed checkpoint, it returns that checkpoint and every
later typed row without applying the pre-checkpoint limit. Generic timeline
readers remain unchanged.

Work startup checkpoint discovery, Native checkpoint receipt inspection,
context projection, and post-repair projection now share the Work frontier
reader. Non-Work episodes retain `listRecentEntries`. Existing P3 projection
and fail-closed decisions are unchanged. Work canonical hard instructions
(including the Work-bound Objective/Constraints/CompletionExpectation/
VerificationMission and Workspace Responsibility/ResourceBoundary fragments)
and the current control/authorization basis are carried in Summary and Native
compaction requests/manifests, including portable Summary recovery paths.

## Focused evidence

- P2 SQLite + P3 projector/runtime + compaction coordinator targets: `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p2-session-append.test.ts packages/model-context/test/scrc-context-projector.test.ts packages/model-context/test/p3-prepare-turn.test.ts packages/agent-runtime/test/scrc-summary-compaction.test.ts` — **4 files, 30/30 tests PASS**. Covers exact 64-row selection/no causal refill, a filtered row retained in selected input but omitted from P3 projection, exact fail-closed orphan result, a 71-row checkpoint-plus-tail frontier, explicit `NeedsCompaction/BudgetPressure`, and pinned Work instruction/control-basis propagation into Summary and Native Provider requests/manifests.
- Public Work→Native compaction: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "enters ordinary Native compaction from public Work Session history"` — **1/1 PASS**. The Manifest `inputFrontier` matches the persisted typed Session rows considered by that real Work request. This scenario contained 28 pre-checkpoint typed rows; it does not itself demonstrate the >64 process boundary.
- Public Work pre-checkpoint restart: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "reconstructs the public latest-64 Work frontier after pre-checkpoint restart"` — **1/1 PASS** (about 50s). Public SteerWork creates over 64 durable typed rows without a checkpoint; after daemon crash/restart the Provider manifest names the exact latest-64 sequence interval, prior rows remain durable, and current input occurs once. Every ProviderTurn Manifest in the Work execution carries its own Work revision-pinned C0/C1 fragments and control/authorization basis.
- Filtered HumanConversation row, before checkpoint commit: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "keeps a filtered HumanConversation row uncovered across compaction AH17BeforeCheckpointEpochCommit and restart"` — **1/1 PASS**. A valid test-seeded typed HumanConversation row is at offset 2 in the exact selected 64-row frontier. The Native PortableInput, `contextRefs`, checkpoint content, and retained coverage omit it while the Timeline row remains durable. After the pre-commit kill/restart, current binding change is handled by a distinct portable Summary ProviderTurn/checkpoint with the same bounded source frontier; previously settled ProviderTurns/actions are not replayed, and any new action belongs to a new Inference turn.
- Filtered HumanConversation row, after checkpoint commit: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "keeps a filtered HumanConversation row uncovered across compaction AH17AfterCheckpointEpochCommit and restart"` — **1/1 PASS**. The real Native checkpoint is committed before kill. Restart uses a distinct Summary rebase ProviderTurn for the changed binding (epoch 1→2); its source step and exact original bounded frontier are validated. No old settled ProviderTurn/action is replayed. The filtered row remains durable and absent from the Native/Summary requests, refs, and checkpoint contents.
- Post-checkpoint >64 production-layer integration, exercised by the same after-commit public Work case: after the real Summary checkpoint, 17 public SteerWork turns append exactly 71 typed rows. The actual SQLite `SessionRepository.listWorkActiveFrontier` returns that checkpoint plus all 71 rows. The production P3 projector and `ModelContext.prepareTurn` receive that exact frontier under a constrained Work budget and return `NeedsCompaction/BudgetPressure`; the production `runCompaction` coordinator then emits a Native request whose Manifest frontier/context refs match the projection. The deterministic Provider and checkpoint-commit dependency in this additional host-side integration seam are test doubles; real daemon checkpoint commit/crash/restart is separately covered by the Native boundary cases above. All 71 tail rows remain durable after the integration compaction call.
- Per-Provider Work pin audit: the >64 pre-checkpoint restart case inspects every ProviderTurn's Portable request instructions and Manifest. For all six C0/C1 Work pins, the request slot/authority/text hash exactly matches that turn's manifest identity/revision/hash/source/scope; each turn's control basis independently carries project/workspace/responsibility/resource-boundary/environment revisions and the authorization digest.
- Filtered-row after-commit recovery now switches model binding A→B. It asserts exactly one distinct Summary rebase ProviderTurn plus its new Inference turn, preserves the settled-turn/action boundary, and verifies the filtered row is absent from all Native/Summary request, refs, and checkpoint content while the original row remains durable.
- Native recovery, checkpoint commit not yet applied: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "recovers ordinary Native source identity at AH17BeforeCheckpointEpochCommit without replaying the ProviderTurn"` — **1/1 PASS**; real daemon crash/restart, no duplicate ProviderTurn.
- Native recovery, checkpoint and epoch commit complete: `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts -t "recovers ordinary Native source identity at AH17AfterCheckpointEpochCommit without replaying the ProviderTurn"` — **1/1 PASS**; real daemon crash/restart, no duplicate ProviderTurn.
- `pnpm exec biome check` on all nine tracked implementation/test files — **PASS**.
- `pnpm typecheck` — **PASS** after final changes.
- `pnpm architecture` — **32 files, 164/164 tests PASS**.

## Gates and remaining qualification

Final scoped gates: **30/30 focused unit tests PASS**, the real-daemon
pre-checkpoint >64 restart case **1/1 PASS**, and both filtered-row
before/after checkpoint process cases **1/1 PASS each** (the after case also
contains the post-checkpoint >64 P2→P3→compaction production-layer integration).
`pnpm typecheck`, Biome on all nine tracked implementation/test files, and
`git diff --check` PASS. The earlier checkpoint also recorded architecture
164/164 PASS.

The full core suite was started: batch 1/20 passed (20 files, 59 tests); it was
stopped after that batch under the focused-gate scope. Full `pnpm test` and full
`pnpm test:functional` were not completed. Full `pnpm check` was not run for
this final checkpoint and is intentionally deferred to the clean mainline
candidate.

The pre-checkpoint >64 process restart, both filtered-row Native checkpoint
crash boundaries, exact adapter/projector causal cases, post-checkpoint
unbounded tail/budget case, and Work-pinning propagation are qualified above.
The full core suite, full `pnpm test:functional`, and final full repository
`pnpm check` remain unrun in this worktree. Those mainline gates do not block
closure of this fixed implementation scope, but this result does not close all
AH19 work or claim release qualification.

## Changed scope

- `packages/ports/src/repositories.ts`
- `adapters/persistence-sqlite/src/session-repository.ts`
- `packages/agent-runtime/src/compaction-coordinator.ts`
- `packages/agent-runtime/src/model-decision.ts`
- `adapters/persistence-sqlite/test/p2-session-append.test.ts`
- `packages/agent-runtime/test/scrc-summary-compaction.test.ts`
- `packages/model-context/test/scrc-context-projector.test.ts`
- `packages/model-context/test/p3-prepare-turn.test.ts`
- `tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts`
- `tests/functional/support/ah19-native-daemon-child.mjs`
- this result record
