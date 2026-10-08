# AH19 ProviderNative binding recovery — scoped qualification

Date: 2026-10-08

Status: **overflow-linked qualification passes; AH19 remains open**. This is
not evidence for ordinary non-overflow Native compaction, whose durable
source-step identity is not established by this batch.

## Evidence

The isolated functional daemon registers a test-only Native-capable Provider
adapter. Stock providers are unchanged and do not claim Native continuation.
The fixture uses the real composition root, daemon, SQLite database, P20
provider-turn chain, and a full `ResolvedModelBinding` fingerprint. It creates
an ordinary portable Session frontier, then a real Step-1 ContextLimit,
Native continuation receipt, and ProviderNative checkpoint. Secret material
and SecretRef values are not included in the fixture's request report.

The source identity for a checkpoint is resolved through the unique persisted
P20 link by `provider_turn_id`, not inferred from the current model-loop cursor
or parsed from the ProviderTurn ID. Recovery verifies the exact execution,
Step identity (logical step and repair attempt), `OverflowCompaction` role,
ordinal 0, context epoch, same-Step Inference predecessor, and its settled
`ContextLimitExceeded` result before using Native checkpoint data. The
provider-turn reverse lookup is covered by the SQLite store test.

The AH19 process file passed **19/19** in the final full-file run after the
terminal ConversationResponse cases and compiled-inference-hash integrity
follow-up. One preceding full-file run had 18/19 pass and timed out while the
nested no-leak test waited for the restarted daemon's health endpoint
(`last=undefined`). The test's fixture cleanup removed that run's temporary
directory before its process/database evidence could be retained. The nested
case then passed alone (1/1), the subsequent full AH19 file passed 19/19, and
the same case passed again inside the full functional suite. This establishes
the later passes but does not identify or claim to fix the earlier startup
timeout.

- Native checkpoint transaction before-commit and after-commit boundaries:
  **2/2**. Before commit the Session remains epoch 0 with no checkpoint; after
  commit there is one ProviderNative checkpoint from epoch 0 to 1 and one
  settled Native attempt.
- Same-binding restart after Native receipt but before checkpoint commit:
  **1/1**. Generation 1 commits the same settled receipt, does not request
  Native a second time, and uses the same opaque continuation reference only
  under the matching binding.
- Native ProviderTurn/Manifest committed but the success receipt not yet
  committed: **1/1**. The fixture proves a complete durable canonical prefix
  (`TurnStarted`, one `ContinuationState`, terminal `TurnCompleted(Stop)`),
  exact Native manifest/request/binding identity, complete known observation,
  and zero downstream delivery. Generation 1 atomically settles the original
  Attempt 0 and Turn from that evidence, then the Agent Runtime commits exactly
  one checkpoint; ProviderPort is not called again.
- Four independently corrupted Native success prefixes—truncated terminal,
  duplicate terminal, invalid/empty continuation ref, and mismatched
  `TurnStarted` identity—are **4/4 fail-closed**. None produces Attempt/Turn
  Success, a checkpoint, or another Native request.
- Corrupt source-manifest logical step, source-link repair attempt, role, and
  predecessor, each independently: **4/4 fail-closed**. Generation 1 reports
  `AgentLoopStepReplayBindingMismatch`, makes no Provider request under binding
  B, and leaves the committed epoch-1 checkpoint unchanged. The intentionally
  corrupted source remains unsettled (Execution active; source Step prepared);
  this evidence asserts rejection before reuse, not a new terminalization
  policy for corrupt stores.
- Committed Native checkpoint with full binding A changed to B: **1/1**.
  Recovery does not send the old opaque reference to B. It makes one portable
  Summary request using the source Step-1 identity (`..._1_compact_1`), commits
  the epoch-1→2 Summary checkpoint, then makes one Step-1/repair-0 replacement
  inference (`..._1_overflow_0`) and converges. The test adapter's final Wait
  is a successor step; the original ContextLimit and Native turns are not
  re-requested.
- Real nested Native frontier across Steps: Step 1 commits an A-bound Native
  checkpoint; Step 2's settled Native request (crashed before its checkpoint
  commit) durably contains that older opaque A ref. After generation 1 changes
  to binding B, recovery rebases Step 1 to a portable Summary and resumes its
  persisted Step 2 successor without changing Step 1's historical
  `OverflowReplacement` link. Step 2's nested Native frontier then fails
  closed before any B Provider request can receive the old opaque ref. The
  source also has two real fail-closed successor negatives: a Step 2
  predecessor pointing to Step 0, and a Step 1 successor that skips a logical
  step; both remain blocked before successor replay.
- AH11 `StepEffectsCommitted` with no successor on a Work episode: **1/1**. After A's original
  Native checkpoint and replacement `update_plan` action commit, gen0 is killed
  before StepEffectsCommitted→NextStepReady. Gen1 B commits one portable
  Summary rebase, atomically writes the exact Step+1/repair-0 successor, and
  continues without re-requesting either old ProviderTurn or repeating the
  action/Observation. The historical OverflowReplacement link's persisted
  fields remain unchanged at epoch 1; Step 2 runs under the rebased epoch 2.
- AH11 `StepEffectsCommitted` terminal ConversationResponse with no successor:
  **1/1**. Public `SubmitHumanMessage` produces the exact ConversationResponse
  episode; A's initial inference hits ContextLimit, then a real Native
  checkpoint and overflow replacement produce one sourced text answer. At the
  kill boundary, Step 0 is `StepEffectsCommitted`, has no successor/actions,
  and pins output hash + Session sequence 1. That Session row's source is the
  exact replacement ProviderTurn assistant ref, and its settled canonical
  events decode to the same text/Stop with no tools. Gen1 B includes its own
  `CompactionTurn` checkpoint in the execution-scoped timeline, accepts the
  contract's empty `SessionFrontier` (`null/null`), commits one portable
  Summary rebase, and settles the exact `ConversationResponseProduced(messageId)`
  without a successor or B inference. The original output/ProviderTurns remain
  unique and the response job converges to Answered once. The same binding,
  manifest, source sequence, decoded-output hash, and no-action checks fail
  closed if evidence is not exact.
- Compiled-request hash corruption for the pinned terminal output: **1/1
  fail-closed** in the post-follow-up focused run. The test changes only the
  settled source inference manifest's `compiledRequestHash` to a different
  8-hex value after generation 0 is killed. Generation 1 acquires lease 1,
  reports `AgentLoopStepReplayBindingMismatch`, sends no B Provider request,
  leaves the original epoch-1 Native checkpoint and `StepEffectsCommitted`
  row unchanged, and does not call portable Summary. Production recomputes the
  compiler's FNV-1a hash over
  `JSON.stringify({ request, toolRoutes })`; it does not apply the compaction
  SHA-256 rule to ordinary inference manifests.

Additional targeted checks:

- Model-context fingerprint/projector, P17/P20 SQLite store, SCRC Summary,
  pinned replay, P3 driver, Provider Runtime Phase 1/policy, and Application
  ProviderTurn recovery tests: **104/104**.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS.
- Focused terminal ConversationResponse process cases after hash follow-up:
  **2/2 PASS** (positive response settlement and corrupted-hash fail-closed).
- `pnpm architecture`: **31 files, 158 tests PASS**.
- Biome check on the AH19 source/test files: PASS (one existing
  `noNonNullAssertion` warning at `model-decision.ts:3091`).
- `git diff --check`: PASS.

## Final pre-commit integration verification

On the integrated working tree based on `042931a9a7f7c485726694c268c84cb04e21fe8d`
(AH18/AH19 changes still uncommitted), the complete AH19 process file passed
19/19 in 899.08s. Full `pnpm check` passed: Biome checked 963 files with one
`noNonNullAssertion` warning in `model-decision.ts`; typecheck passed;
architecture passed 158/158; core Vitest passed 1738 with 3 skipped; Web
typecheck/build passed; Web Vitest passed 223/223. Full `pnpm test:functional`
passed with Vitest 31 files / 102 tests and Playwright 3/3, including AH18
12/12 and AH19 19/19. The test-local diagnostic wrapper for the earlier
nested restart timeout did not trigger in the final AH19 run.

F20 passed both in the full functional batch and as a separate pre-commit
clean-checkout run. Since the test clones local `HEAD`, both F20 runs qualify
the base commit and do not include the uncommitted AH18/AH19 changes. The full
functional run verifies the changed working tree directly. `pnpm check` also
rewrote the P12 restore-drill timestamp/hash; those two generated fields were
restored to their pre-run values and the file is clean. AH19 remains open for
ordinary non-overflow Native compaction and the wider AH15–AH19 qualification.

## Remaining scope

The matching and mismatch restart cases here are overflow-linked. A normal
Native compaction without a P20 `OverflowCompaction` link does not currently
have the authoritative durable source-Step/repair identity used by this
recovery boundary; it must remain fail-closed and needs its own process
qualification before AH19 can be closed. Two bounded test-only attempts to
form that ordinary path through public setup (ContextWindow 4096 and 4400)
did not reach a Native checkpoint, so no ordinary-path PASS is claimed. This
result also does not close AH19 or qualify the entire AH15–AH19 matrix.
