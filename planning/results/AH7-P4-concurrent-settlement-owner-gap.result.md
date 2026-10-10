# AH7 / P4 Concurrent Settlement Owner Gap — Evidence

## Scope and tree

- Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`
- Base HEAD: `6073ed9ad53816b8bca7444ca070f0ee924478d5`
- No production code or `docs/design/**` changed.
- This record accompanies the draft proposal
  `planning/proposals/AH7-P4-concurrent-invocation-settlement-ownership-draft.md`.

## Initial integrated gate evidence

At the base HEAD, the one full `pnpm check` stopped in Core Vitest:

- Biome: 994 files, no errors; one existing warning at
  `packages/agent-runtime/src/model-decision.ts:4070`.
- Typecheck: PASS.
- Architecture: 31 files / 158 tests PASS.
- Core: 332 files; 331 passed, 1 failed; 1811 passed, 3 skipped, 1 failed.
- The sole failure was the third case in
  `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`.
- Expected durable `{ intents: 1, settled: 1, settlement_kind: "Success" }`;
  observed the same unique intent/settled counts but
  `settlement_kind: "OutcomeUnknown"`.
- The test's assertions immediately before that failure establish one external
  effect marker and exactly one runtime `Success`; therefore the issue is that
  durable state disagrees with the active effect owner's known success.
- Web typecheck/build/tests were not run because Core Vitest failed.

After restoring only the `planning/results/P12.restore-drill.json`
timestamp/hash written by this gate, the tracked worktree was clean at the same
HEAD.

## Focused reproduction

- The old nondeterministic test was run once after the full-check failure and
  then five more times: all six focused reruns passed. This establishes that
  the original full-check failure is timing-sensitive, not that the contract
  conflict is absent.
- A new deterministic test holds worker A after its real external effect and
  before settlement, then allows worker B to re-enter with the exact same
  invocation. It waits for B's result before releasing A to persist `Success`.
- Command:

  ```text
  pnpm exec vitest run adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts -t "does not let a concurrent reentry settle unknown over the active effect owner"
  ```

- Result: **RED**, 1 failed / 3 skipped. The observed failure is exactly the
  durable settlement mismatch: expected `Success`, received `OutcomeUnknown`.
- Before the failing assertion, the deterministic test verifies distinct
  worker processes, ordered A-effect-before-B-reentry, results `A=Success` and
  `B=OutcomeUnknown`, and exactly one effect marker.
- Full focused file rerun: **3 passed / 1 failed**; only the new deterministic
  settlement-owner case failed. The existing SQLite insert, two-connection,
  and nondeterministic two-process cases passed.
- `pnpm typecheck`: PASS. Biome on the changed test and child helper: PASS;
  `git diff --check`: PASS.

## Interpretation and next step

P4 freezes intent-before-effect and prohibits blind replay of ambiguous
non-idempotent effects, but does not state whether an overlapping same-key
re-entry may write terminal `OutcomeUnknown` while the unique effect owner is
known to be live. The runtime currently permits that write; SQLite's
settlement update is conditional on `settled_at IS NULL` and silently affects
zero rows when the competing unknown settlement wins.

This is a **Design Gap candidate**, not yet classified as an implementation
defect or a test-contract error. The proposal asks governance to decide how
active-owner settlement differs from crash-abandoned intent. Do not alter
production code or frozen design until that ruling is independently reviewed.

No full check or functional suite was run for this isolated RED; no fixes were
attempted. Test-only edits, proposal, and evidence record are isolated for
independent review.
