# P4 / AH7 ToolInvocation settlement lease fence — result

## Scope

Implement the already-frozen P2 `03` §3 / P9 `02` W3/R4 requirement that an
old Worker generation cannot commit ToolInvocation settlement after takeover.
No `docs/design/**` was modified. RecoveryController remains on its existing
Execution/Attention path and does not write `tool_invocations`.

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

## RED evidence: real production dispatch and cross-generation takeover

The new real-daemon test is
`tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts`.
It uses the production `runExecution`/lease acquire path and production P4
ToolRuntime:

1. A public Root goal is approved; a Profile-backed Work waits for public
   Steer, then invokes a NonIdempotent shell effect.
2. Generation G0 is held after the shell effect and before P4 settlement. Its
   lease-renewal probe is paused and the test expires only the isolated fixture
   DB's lease row.
3. A second real daemon acquires generation G1 and is held by the
   `AH10AfterLeaseAcquired` probe before `driver.drive`.
4. Releasing G0 proves the old production Worker reaches the actual P4
   `settle` boundary after G1 owns the lease. Before the fix it emitted
   `AH7AfterToolSettlementCommit` and the row was durably `Success`—not an
   earlier renewal cancellation or pre-dispatch rejection.
5. The external shell marker occurred exactly once. The later
   AgentLoopStep/Session fence prevented any successful ToolResult Observation
   from being committed, but that is too late to satisfy P9 R4: the P4 row had
   already been mutated by the stale worker.

Baseline RED command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts
```

The baseline failed at the expected boundary: observed
`AH7AfterToolSettlementCommit`, expected `AH7ToolSettlementFenceRejected`; the
P4 row changed from unsettled to `Success` while G1's driver remained paused.

## Implementation

- Production `ExecutableToolHandler` now forwards the trusted ExecutionOrigin
  holder triple (`workerId`, `workerIncarnationId`, `fencingGeneration`) in
  `ToolExecutionContext`. The legacy executable route forwards it as well when
  it receives an ExecutionOrigin.
- P4 `ToolInvocationStore.settle` accepts that optional internal fence and
  returns whether its conditional settlement CAS updated a row.
- SQLite settlement checks the exact invocation→Execution binding, unsettled
  Execution, worker id, process incarnation, generation, and unexpired lease in
  the same `TransactionScope` transaction as the settlement update. A stale
  holder receives typed `LeaseFencingRejected` and performs no row mutation.
- `ToolRuntime` preserves lease-fence rejection, emits the test boundary, and
  never emits the settlement-committed probe after a rejected or zero-row CAS.
  On a zero-row CAS it rereads the canonical ToolInvocation in the same
  transaction: canonical `OutcomeUnknown` remains unknown; missing/incompatible
  canonical state is an operational failure, never a fabricated `Success`.
- The lease rejection propagates through Executable Invocation / AgentLoop to
  `ExecutionDriverOwnershipLost`, then `runExecution` maps it back to
  `LeaseFencingRejected`. Production dispatch consumes it as lost ownership;
  the stale worker does not persist a successful Observation.
- The current G1 replay does not re-execute the NonIdempotent effect. It settles
  the P4 invocation and Execution `OutcomeUnknown`; it does not invoke
  RecoveryController to write `tool_invocations`.

## Verification

- `pnpm build`: PASS.
- `pnpm typecheck`: PASS.
- P2/P4/ToolRuntime unit batch: 6 files / 20 tests PASS. This includes P2 live
  lease acquire/takeover, SQLite P4 settle applied-vs-zero-row CAS, and
  ToolRuntime canonical `OutcomeUnknown` on a zero-row settlement CAS.
- Real production cross-generation process test above: 1/1 PASS after fix.
  G0 was fenced while G1 owned the lease; the invocation stayed unsettled
  until G1 resumed, G1 did not repeat the shell effect, final P4/Execution
  outcomes were `OutcomeUnknown`, and no successful ToolResult Observation was
  recorded.
- Existing direct P4 concurrency adapter file: 3 passed / 1 skipped.
- Biome on all changed source/test files and `git diff --check`: PASS.
- No full `pnpm check` or full `pnpm test:functional` was run.

## Direct unleased P4 diagnostic disposition

The original deterministic direct-P4 RED is retained, with its assertions
unchanged, as a skipped pending diagnostic in
`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`.
It constructs two unleased ToolRuntime callers and does not prove production
same-generation dual-worker reachability; P2 lease acquisition blocks that
state. Its exact result projection remains unruled and must not be used to
invent a permanent intent-inserter ownership rule. The production stale-
generation requirement is independently proven by the real daemon test above.

## Remaining open item

Only the lower-layer direct/unleased P4 re-entry projection remains pending the
P4 owner decision. The P2/P9 old-generation fencing requirement is implemented
under its existing frozen clauses. No `docs/design/**` changes, no full gates,
no push, and no merge were performed.
