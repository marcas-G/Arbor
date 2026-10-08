# AH17 CompactionCheckpoint ↔ ContextEpoch Crash Qualification

Status: **PASS — both atomic transaction boundaries qualified with real
process kill/restart (2/2).**

The dedicated real-process test is
`tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts`, with
an AH17-only first-daemon probe in
`tests/functional/support/ah17-compaction-crash-child.mjs`. The probe brackets
the production `TransactionPort.transact(sessions.commitCompaction(...))` call:
one boundary before the transaction begins and one after it resolves. The
SQLite implementation updates `sessions.context_epoch` and appends the
CompactionCheckpoint within the same transaction
(`adapters/persistence-sqlite/src/session-repository.ts`,
`commitCompaction`). This matches DID §9.10 and SCRC-006 T20's atomic boundary;
the real-process qualification below exercises both sides of that boundary.

## Credential propagation fix

The first coordinator-level test run established the bug: both Summary and
Native compaction omitted the optional deployment `SecretRef` from their
`ProviderRunInput`. The test now captures the run input for each path and
asserts that it receives the exact same reference supplied by the caller.
Those two assertions failed before the fix and pass after it. The minimal
implementation change passes `options.secretRef` from both
`runModelDecision` compaction paths through `SummaryCompactionInput` and into
the corresponding `ProviderRunInput`. It does not expose the credential
material, place the reference in the manifest/request/checkpoint, or relax
adapter authentication. `pnpm build` completed successfully.

## Attempted qualification

Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts --reporter=verbose
```

The initial process run before credential propagation did not reach either
boundary: the local Provider received the context-overflow request, no summary
request was issued, and daemon stderr reported
`ProviderFailure(AuthenticationFailed, invalid_api_key)`. The fixture's first
HTTP 400 encoding was also corrected to a 200 SSE error event, which is the
adapter-supported representation for `context_length_exceeded`.

During integration, the first full Vitest run also produced 25 failures among
27 `tests/p3-driver.test.ts` cases: the initial Prepared-step recovery gate
queried `agent_loop_step_provider_turns` for ordinary non-overflow steps on a
P17 schema. A dedicated P17 RED regression now verifies that ordinary Prepared
steps do not touch the P20 table. Recovery first checks the highest persisted
terminal Attempt classification and only queries the chain for an explicit,
supported ContextLimit failure; the P3 driver suite is now 37/37.

Two intermediate runs provided implementation-failure evidence, not PASS:
the before-commit restart initially settled the step from the failed original
inference instead of replaying the successful summary receipt; the after-commit
restart exposed `AgentLoopStepReplayBindingMismatch` when that epoch-0
inference was compared with the epoch-1 checkpoint. The recovery path now
requires the exact ordinal-0 Inference/OverflowCompaction links, the original
failed inference and successful compaction receipt, matching persisted
manifest/request hash and binding, and a non-empty canonical summary. It
reconstructs the checkpoint from that same receipt, commits it idempotently
(covering both epoch-0/no-checkpoint and epoch-1/already-committed states),
ensures the one deterministic OverflowReplacement link, and resumes that same
logical step. Incomplete or conflicting evidence fails closed. A pure guard
negative test first failed because the old guard accepted an OverflowCompaction
link with the wrong predecessor; after the fix it rejects that link, and new
normal overflow creation persists the original Inference ProviderTurn as the
compaction link's predecessor.

Latest run: both process cases PASS. In the **before-commit** case, the
independent SQLite view showed epoch 0/checkpoint count 0 before kill; after
real lease expiry, gen1 promoted the original successful Summary receipt to
one checkpoint and epoch 1. In the **after-commit** case, the pre-kill view
showed epoch 1 and the one checkpoint; gen1 reused the same compaction receipt
and continued without adding another checkpoint. Both sides ended with the
same three ProviderTurn identities (original inference, `*_compact_0`,
`*_overflow_0`), a unique successful replacement attempt, one checkpoint
referencing the original CompactionTurn, a Manual WorkWait, and Completed
Execution. Provider requests were exactly `[context-overflow, summary, wait]`;
neither the original inference nor the summary was requested again.
The oracle verifies the same logical step `(logicalStepNo=0, repairAttempt=0)`,
exactly three ordinal-0 links with expected predecessors/context epochs, and
checkpoint `summaryText` equal to the successful Summary attempt's canonical
TextDelta aggregation.

## Observed recovery evidence

The credential omission was a frozen-contract implementation defect and is
fixed in this batch. The receipt-first recovery preserves the original
Inference/Compaction ProviderTurn identities and does not rewrite their
manifest or session binding. `commitCompaction` remains the atomic SQLite
checkpoint+epoch transaction; no design documents changed.

## Checks

- `pnpm exec vitest run packages/agent-runtime/test/scrc-summary-compaction.test.ts --reporter=verbose`:
  PASS, 3/3 (including before-fix red for each SecretRef assertion).
- `pnpm exec vitest run packages/agent-runtime/test/model-decision-pinned-replay.test.ts --reporter=verbose`:
  PASS, 4/4 (including the predecessor-mismatch red→green guard).
- `pnpm exec vitest run packages/agent-runtime/test`: PASS, 21 files / 128 tests.
- `pnpm build`: PASS.
- `pnpm exec tsc -p packages/agent-runtime/tsconfig.json --noEmit --pretty false`:
  PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false`: PASS.
- `pnpm architecture`: PASS, 30 files / 155 tests.
- `pnpm exec biome check` on the five AH17-specific/agent-runtime files: PASS.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts --reporter=verbose`:
  PASS, 1 file / 2 tests; both real-process crash sides recovered.
- `git diff --check`: PASS.

Integration rerun at working source `021b6bf` plus this batch, after
`pnpm build`: the dedicated real-process file passed again, 1 file / 2 tests
(Summary profile, before/after commit; latest rerun 74.99s). The full `packages/agent-runtime/test` suite
passed, 21 files / 128 tests. `pnpm build` passed before the reruns. The
recovery tests verify all three ordinal-0 links, exact predecessors and epochs,
the original logical Step `(0, 0)`, one replacement, and no second request for
the failed inference or successful Summary receipt. SecretRef propagation is
only through the separate `ProviderRunInput.secretRef`; the compaction request
and manifest constructors contain no SecretRef field or material, and no
SecretMaterial is read or logged by this change. These results do not qualify
AH18 repeated overflow or AH19 ProviderNative binding, and do not close
SCRC-008.

Integration review also tightened the original-Inference gate: the recovery
reader uses only the highest persisted terminal ProviderAttempt, with exact
`phase1-v2` taxonomy and a recognized failure kind. Missing kind or unsupported
taxonomy returns existing `SettledEvidenceInvalid` and follows the existing
`SettledProviderEvidenceInvalid` / `ProviderReplay` fail-closed path. The P3
driver regression suite passes 37/37, including P17 ordinary Prepared,
ordinary RequestRejected, latest-terminal-attempt selection, missing/legacy
classification rejection, P19 ContextLimit with missing P20 chain table, and
P20 empty ordinal-0 chain reconstruction from a durable ContextLimit receipt.
The empty-chain test is deterministic in-process evidence, not a process-kill
AH18 qualification. A separate crash window remains open: when the ordinal-0
OverflowCompaction link is durable but its Summary ProviderTurn is NotFound or
Unsettled, recovery currently fails closed instead of starting/resuming that
same deterministic Summary turn. Track this under AH18; it is not closed by
the AH17 checkpoint/epoch result.

This qualifies the two specified AH17 checkpoint/epoch boundaries only. It
does not qualify repeated context overflow (separate AH18 case) or P16
cross-deployment binding (separate AH19 qualification).

The real-process qualification above exercises Summary compaction only. Unit
tests verify that both Summary and ProviderNative compaction pass the caller's
opaque SecretRef separately from their request/manifest. ProviderNative
match/mismatch behavior and Native checkpoint/epoch crash recovery remain
unqualified under AH19; no all-profile AH17 closure is claimed.

Final integrated `pnpm check` passes: Biome 953 files, typecheck, architecture
155, core 316 files / 1723 passed / 3 skipped, Web typecheck/build and 31 files /
216 tests. P12 restore-drill generated-field drift from the check was restored
to the committed timestamp and hash.

Committed F20 and full functional-suite results are recorded in
`planning/results/AH15-AH17-direct-child-release-validation.result.md`.
