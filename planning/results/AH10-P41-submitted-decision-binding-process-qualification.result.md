# AH10 P41 Submitted DecisionEpisode binding process qualification

Date: 2026-10-16
Implementation base: `436ab3c6`
Scope: accepted DID v1.42 / P41 behavior only; no new design semantics.

## Qualified public setup and three-generation sequence

The four-case process matrix is in
`tests/functional/process/agent-loop-ah10-submitted-decision-binding-takeover.functional.test.ts`.
Each case creates the Root Work through `SubmitHumanMessage`, Root
`assign_work`, public GrantPermission and ResolveControlApproval. The Work
waits while the fixture creates two runnable candidates. For the Workspace
mismatch cases, an alternate child Workspace is created only through Root
`propose_workspace` → public Governance Inbox → `RecordDecision(Approve)` →
formation consumer. The Manifest mismatch cases use a second real AgentLoopStep
Manifest already persisted by the fixture. The only test DB mutation is the
selected DecisionRequest Workspace binding or pinned Step Manifest; the test
checks the other rows remain unchanged before recovery.

Each case then proves the same real P9 predicate across three owners:

1. Gen0 has the committed original `SelectCurrentWork` receipt and selection,
   successful settled ProviderResult, and still-Pending SelectCurrentWork
   action. It is forced-killed at the existing AH9 ActionResult pre-commit
   boundary after the one binding field is corrupted.
2. Gen1 acquires the next lease and detects the exact submitted-decision
   mismatch through `isPinnedSubmittedDecisionReplay`. Its test-only probe is
   inside the P9 fact/event transaction after the immutable write for the
   before-commit case, and immediately after transaction commit for the
   after-commit case. The gen1 process is force-killed at that exact boundary.
3. Gen2 recovers. Before-commit must find no gen1 fact/event and creates one
   pair; after-commit reads the existing pair idempotently. It does not issue
   a Provider request, replay the control action, add a Command/Observation,
   change the original receipt/selection, or settle the active Execution.
   The public Attention view contains exactly one `ActionRequired` row bound to
   the exact P9 fact.

The owner-exit lease expiry used between generations is the existing
`expireExecutionLeaseAfterOwnerExitForQualification` exact-tuple CAS, only
after the corresponding daemon process is confirmed exited. It is a bounded
takeover qualification, **not** evidence of natural TTL timing. Forced process
termination uses the existing Windows-aware daemon lifecycle.

After fact-first recovery, the test issues public `StopExecution`. It then
force-stops the blocked gen2 process, applies the same owner-exit-qualified
lease CAS if a lease row remains, and starts gen3 so the existing
RecoveryController performs the accepted P41 fact-first Stop close. Final
truth is one `Interrupted` Execution, exact `SettlementProposed` Step and
terminalized selection Action; the original selection, Command receipt, P9
fact/event and one public Attention row remain unchanged/present.

## Implementation correction found by the qualification

The first Stop-close attempt acquired the Recovery lease, passed the P4 gate,
and then failed closed at pinned action reconstruction. The real P3 Step stored
the current typed `AssistantMessage` ModelOutput, while the P41 stop-only
reconstructor accepted only the legacy full decoded-output JSON shape. P3's
normal `StepEffectsCommitted` replay validator already accepts both shapes.
The fix extracts the shared `matchesPersistedModelOutput` validator and uses
it in both P3 replay verification and P41 stop-only reconstruction. It keeps
the exact output hash, Session sequence, ProviderTurn source, content ref,
text, finish reason and manifest output-contract binding checks; it does not
relax identity or alter the P41 control flow. P41 additionally verifies the
provider result's exact ProviderTurn/Execution/Session/Manifest metadata and
reconstructs action callRef, route, logical action id and input hash before
the accepted Stop-only close.

`packages/agent-runtime/test/persisted-model-output.test.ts` covers typed and
legacy positive representations plus source, sequence, ProviderTurn,
output-contract/Manifest, decoded hash, text, finish-reason and missing-source
negative cases. `packages/agent-runtime/test/submitted-decision-stop-close-plan.test.ts`
proves that an internally valid Provider Manifest can reconstruct the exact
pinned action despite the deliberate Step-vs-Provider Manifest mismatch, and
fails closed for wrong Manifest ProviderTurn/Execution/Session/context/model/
output-contract/step/repair identity, wrong decoded hash, or changed action
callRef/input hash.

The RecoveryController diagnostic probe is test-only, synchronous and
fail-silent. It records the target fact/Stop state, lease acquire result, P4
gate count, reconstruction inputs/result, stop-close plan/transaction result,
and SettleExecution resolution; it neither pauses nor changes the recovery
decision. Ordinary production composition leaves the probe absent.

## Verification

```text
P41 real daemon matrix, serial, --retry=0:
  1 file / 4 tests PASS (245.59s)
  workspace × fact transaction before/after: PASS
  Manifest × fact transaction before/after: PASS

P41 focused unit/store set:
  9 files / 46 tests PASS

pnpm typecheck: PASS
Biome on 12 changed TS/MJS files: PASS
node --check tests/functional/support/ah10-process-child.mjs: PASS
git diff --check: PASS
```

The test file is in the default functional process discovery tree. The prior
unsupported-origin/corrupted-terminalization reproduction remains in
`tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`
unchanged as historical RED evidence; it is not counted as passing coverage.
No full `pnpm check` or `pnpm test:functional` was run. AH10 remains PARTIAL
overall because the P8 verification-control replay/snapshot governance and
full release gates remain open.
