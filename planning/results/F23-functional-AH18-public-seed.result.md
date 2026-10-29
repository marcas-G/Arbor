# F23 AH18 overflow public Work seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Baseline: `612c81204e3162958df16b71a4d654902f591236`, detached and clean after
confirming the AH7 multi-action source commit was patch-equivalent in the
shared branch. Only
`tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts`
and this result record changed. No production code, `docs/design/**`, shared
fixture, or other test was modified.

## Change

The three direct external `/commands` `AssignWork` setups now share the public
Root admission path: human `SubmitHumanMessage` → Root Agent `assign_work` →
exact Governance Inbox CAPA approval → public `ResolveControlApproval(Approve)`
→ Open `current-work`.

The AH18 file's existing local overflow Provider test server now separates its
safe public-seed stage from measured AH18 requests. Root seed calls receive the
model-authored `assign_work`; the newly approved Workspace Work's first turn
receives a legal Manual wait. Those requests are recorded separately in
`seedRequests`; they do not increment AH18 inference/summary counters or enter
the target `requests` sequence. The fixture confirms the Work is Open, revision
0, idle, its seed Execution is not Failed, the seed ProviderTurn/Attempt
completed without a ContextLimit, its Work wait is Manual, its session remains
at context epoch 0 with no checkpoint, and the target request list is still
empty.

Only after that seed is complete does the test crash/restart with the selected
AH18/AH4 probe and issue public `SteerWork` at revision 0. A unique guidance
marker opens the provider gate for the measured Work Execution, which must be a
different Execution from the Manual-wait seed. AH18 `requests` therefore
continues to represent only the original measured chain; assertions retain the
exact ContextLimit → Summary → Replacement order and strict ProviderAttempt,
ContextEpoch, summary manifest/ref, overflow link, and recovery counts. The
terminal test scopes its empty durable-output assertion to the measured
Execution's ProviderTurn/Observation source refs so Root and Manual-wait seed
entries in the shared Workspace session cannot mask or contaminate AH18
evidence.

## RED / verification

- After `pnpm exec tsc -b --force` refreshed the isolated daemon build, each
  original seed independently reproduced HTTP 403
  `authority/denied` / `UnsupportedOrigin:AssignWork`:
  - `startAtBoundary` representative: AH18BeforeOverflowLinksCommit, 1/1 RED.
  - Summary Attempt `in-progress`, 1/1 RED.
  - Second-ContextLimit terminal proposal AH4BeforeSettlementProposal, 1/1
    RED.
- Revised representative focused cases passed individually:
  - AH18BeforeOverflowLinksCommit: 1/1 PASS (46.41s).
  - Summary Attempt `in-progress`: 1/1 PASS (44.40s).
  - AH4BeforeSettlementProposal: 1/1 PASS (48.55s).
- Biome on the changed test: PASS.
- `pnpm typecheck`: PASS.
- `git diff --check`: PASS.
- The full AH18 file, `pnpm check`, and `pnpm test:functional` were not run.

This is focused test-seed migration evidence only; it does not claim full AH18
or release-functional closure.
