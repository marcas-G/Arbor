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
  pnpm exec vitest run adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts -t "shows direct unleased P4 reentry can terminalize unknown"
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

## Production dispatch / lease reachability audit

The RED test calls two standalone `ToolRuntimeLive` instances and does not
provide P2 `ExecutionOrigin` or a lease fence. It proves a P4 lower-layer
counterexample, not that two production Workers can own one live Execution.

Read-only path audit:

- `apps/single-workspace/src/production.ts:639-646` runs the targeted
  `preDispatchCheck`, then enters `runExecution`.
- `packages/execution-runtime/src/execution-runtime.ts:170-193` acquires the
  execution lease before invoking `driver.drive`; failed live acquisition is
  `LeaseFencingRejected`.
- `adapters/persistence-sqlite/src/execution.ts:389-403` uses a unique lease
  row and only replaces it when `expires_at <= now`, assigning the next
  monotonic generation.
- `packages/agent-runtime/src/model-output-journal.ts:111` processes model
  tool invocations serially in a `for` loop.
- The production executable handler builds `ToolExecutionContext` at
  `apps/single-workspace/src/executable-tool-handler.ts:170`; it omits the
  lease-holder triple. `ToolInvocationStore.settle` at
  `adapters/persistence-sqlite/src/tool-invocations.ts:125-140` also has no
  fence input/check.
- The direct lease qualification
  `pnpm exec vitest run adapters/persistence-sqlite/test/p2-lease.test.ts`
  passed: 1 file / 2 tests. It asserts a second live holder is rejected and
  a later holder receives the next generation.

Thus a **same-generation second Worker** is excluded by production lease
acquisition and sequential model-call dispatch. A different generation can
take over after expiry. For that old-generation state, P2 `03` §3 explicitly
lists ToolInvocation settlement among writes requiring same-transaction
authoritative fencing, and P9 `02` W3/R4 requires stale settlement rejection
with the invocation left unsettled. These existing clauses are sufficient to
require a P4 fence; the current P4 `ToolExecutionContext` / store signature
does not carry it. This is an implementation seam gap under existing P2/P9
semantics, not a reason to grant an intent inserter permanent settlement
authority. The static audit does not prove a stale P4 write actually commits;
the P9 contract requires that it be rejected if attempted.

P2 `06` and P9 `01` make RecoveryController a separate recovery authority:
the recovery drive does not invoke the effect. In the stopped/quiescence path,
it enumerates unresolved P4 refs and escalates rather than blindly replaying a
non-idempotent invocation. An active unsettled Execution without a deterministic
settlement remains Active for scheduler re-dispatch after the lease permits
takeover; the new Worker must not re-execute an existing non-idempotent intent.

## Review disposition

The independent review's blocking concern is addressed in scope and wording:

- The direct RED is now explicitly named an **unleased P4 re-entry** case and
  is not claimed as proof that production dispatch permits two same-generation
  workers.
- The proposal no longer recommends “the intent inserter permanently owns
  settlement.” It distinguishes same-generation live duplicate, stale old
  generation, and RecoveryController takeover.
- P2 `03` §3 + P9 `02` W3/R4 already resolve old-generation authority; no new
  design rule is needed there. The implementation must thread/check the
  existing lease fence at P4 settlement.
- The remaining P4 clarification is zero-row CAS behavior: settlement must
  report Applied vs not-applied; an authorized caller rereads canonical state
  before reporting an outcome, while stale generation is fenced before the
  read. Exact same-generation direct-P4 projection is explicitly left for the
  P4 owner; the RED remains unchanged.

This disposition is not a claim that an independent reviewer accepted the
revision. No production source or `docs/design/**` was changed.

## Interpretation and next step

The RED shows that unleased direct callers can make the runtime observation
disagree with the durable settlement. Production same-generation Worker
duplication is blocked by P2 lease acquisition, but P2/P9's existing stale
generation settlement-fence requirement is not represented in the P4 call
signature. The proposal records the existing-contract implementation gap and
the narrower P4 CAS/canonical-read question for independent review. Do not
alter production code or frozen design before that review.

No full check or functional suite was run for this isolated RED; no fixes were
attempted. Test-only edits, proposal, and evidence record are isolated for
independent review.
