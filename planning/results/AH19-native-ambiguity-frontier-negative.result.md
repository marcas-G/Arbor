# AH19 Native ambiguity and half-null frontier negatives

Date: 2026-10-09

Status: **three isolated ordinary Native fail-closed process negatives PASS.**
This is scoped evidence only; AH19 and the wider AH15–AH19/SCRC recovery
matrices remain open.

## Scope

The tests use the real daemon, isolated SQLite database, and public Work
formation/SteerWork history to create the original ordinary Native manifest and
successful receipt. No positive execution history is created by SQL. Database
changes occur only after killing the first daemon, to form the specified
negative condition.

### Multiple same-epoch candidates

At the real Native receipt boundary before checkpoint commit, the fixture
proves one settled Native Success receipt, Session epoch 0, and no checkpoint.
After process loss, the isolated test database receives one additional
same-Session/same-epoch ProviderTurn+manifest row using the existing schema.
The copied manifest binds its new ProviderTurn identity to the original real
source AgentLoopStep and retains the valid ordinary Native request/frontier.
The test queries the database before restart and proves that the
`findNativeCompactionsBySessionEpoch` selection has exactly two owned
ProviderNative candidates.

On generation 1 the Runtime reports
`NativeCompactionCandidateAmbiguity:count=2`, then rejects recovery. The test
proves zero additional Provider requests, unchanged epoch 0/checkpoint/step
state, and an unsettled Execution. This demonstrates the actual multiple
candidate branch rather than inferring rejection from a timeout.

### Half-null portable frontier

Two independent real process restarts start from a publicly formed ordinary
Native checkpoint at epoch 1. After process loss, the test changes exactly one
field in the persisted Native manifest's `inputFrontier`: either
`firstSequence = null` or `lastSequence = null`; the other side remains a
number. No source-step, receipt, request, or binding fields are changed.

Both restarts report
`NativeCheckpointEvidence:frontier=false:source=true:receipt=SettledSuccess`.
The `source=true` bit means only that the raw manifest `executionId` matches
and the other source-step fields have the expected shape. It is computed
independently of the full Store source-step binding check; it does not prove the
complete source identity. Both cases leave epoch 1, the committed checkpoint
and AgentLoopSteps unchanged; the Execution remains active and no Provider
request is emitted.

## Verification

- Multi-candidate process test: **1/1 PASS**.
- Half-null frontier process tests: **2/2 PASS**.
- Full `pnpm check`: **PASS** — Biome checked 964 files with one existing
  `noNonNullAssertion` warning at `model-decision.ts:3917`; typecheck passed;
  architecture 158/158; core 319 files, 1745 passed and 3 skipped; Web
  typecheck/build passed; Web 31 files, 223/223 passed.
- `git diff --check`: PASS.

## Integration verification

- Full AH19 process file: **34/34 PASS**.
- First full `pnpm test:functional` attempt: Vitest **31/31 files and 118/118
  tests PASS**; Playwright **2/3 PASS, 1 FAIL** at F22. Its old oracle expected
  exactly one `work-detail` request after a privacy route. WebSocket
  invalidation correctly triggered a same-view/same-target P13 freshness
  revalidation, so two POSTs were observed. Both returned the same 404
  `projection/work-not-found`; the page exposed no completed Work content.
  The old count assertion was over-constrained, not evidence of a production
  privacy leak.
- The F22 oracle now requires at least one captured `work-detail` request and
  checks every captured request has the exact current route target body. The
  shared 404 and target-content-not-visible assertions remain. Targeted F22
  Playwright passed **1/1** on two runs and passed in the final full browser
  suite. Independent review reported **Blocking = 0** and noted a P2 limit:
  the request observation window ends after the NotFound render and immediate
  assertions, so a later asynchronous request could fall outside that window.
  The current evidence therefore covers the observed requests in that window.
- Second full functional attempt, after the F22 oracle correction: Vitest
  **30/31 files, 117/118 tests PASS**, with one AH7 assertion failure at
  `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts:235`.
  It compared all `provider_turns` in the database, including a pending turn
  for another Execution, against the crashed snapshot's all-database rows.
  The extra row was `ptn_exe_a6a703dd-e8a2-7b1f-820f-33af8103c32a_0`
  (`finish_reason=null`, `settled_at=null`); the target probe turn was
  `ptn_exe_515cbfb1-3730-7a59-8941-eaa8f207b00f_0` and remained a settled
  `ToolCall`. The arrays differed by that unrelated row; the failure did not
  establish a replay in the target Work Execution. A focused diagnostic rerun
  of the NonIdempotent case passed and did not reproduce the mismatch. The
  fixture's `stop()` cleanup removes its temporary database and workspace, so
  the initial failure's detailed rows were not retained beyond the Vitest
  console diff.
- The AH7 oracle now scopes ProviderTurn reads to the exact probe
  `executionId`, asserts that Execution is the `WorkEpisode` for this case's
  `workId`, and compares only that Execution's ProviderTurns before/after.
  It also retains exact invocation, action, callRef and Execution bindings,
  `targetProviderCalls === 1`, `OutcomeUnknown`, and byte-identical effect-file
  content assertions. The AH7 process file passed **3/3** targeted and in the
  final full Vitest run.
- `pnpm check`: **PASS** — Biome checked 964 files with one existing
  `noNonNullAssertion` warning at `model-decision.ts:3917`; typecheck passed;
  architecture 158/158; core 319 files, 1745 passed and 3 skipped; Web
  typecheck/build passed; Web 31 files, 223/223 passed.
- Final full `pnpm test:functional`: build passed; Vitest **31/31 files,
  118/118 tests PASS**; Playwright **3/3 PASS**. P9 passed. F20 clean-checkout
  smoke passed but is **pre-commit baseline-only** because it validates the
  current committed `HEAD`, not these uncommitted changes.

AH19 remains **OPEN**. These tests do not qualify P20 half-null recovery or
other AH19 recovery branches, and do not close AH19. No design documents were
changed; no commit or push was made.
