# Runtime Refactoring Phase — Detailed Execution Plan

Date: 2026-11-04
Scope: PP-W203, PP-W204, PP-W205

This phase changes internal ownership and module structure while preserving the
existing durable semantics. No `docs/design/**` changes are authorized by this
plan. PP-W401–PP-W405 remain a separate governance stream.

## Exit target

The Agent Runtime must expose three reviewable seams:

1. Recovery decision — reads durable facts and returns a typed recovery choice;
2. Step/action transition — interprets one provider/action outcome as a pure
   transition or an explicit effect plan;
3. Settlement commit — one Application-owned commit path for a settlement
   proposal.

The existing public process lifecycle, restart behavior, idempotency identity,
fencing, and ProviderTurn bindings must remain unchanged.

## Work packages

### R1 — Snapshot and recovery decision (PP-W203)

Files:

- `packages/agent-runtime/src/model-decision.ts`
- new `packages/agent-runtime/src/recovery-decision.ts`
- focused tests under `packages/agent-runtime/test/`

Tasks:

- Define a readonly `DurableDecisionSnapshot` containing the persisted step,
  ProviderTurn result, provider links, Session frontier, and binding identity.
- Move pure checks for Prepared/ProviderResultAvailable/OutputRejected/
  DecisionStale/ContextLimit successor selection into the new module.
- Keep all reads in the driver until the extracted function has a complete
  snapshot; the decision module must not read repositories or call Provider.
- Return explicit `Continue`, `EnsureSuccessor`, `Repair`, `Settle`, and
  `BindingMismatch` outcomes.
- Preserve exact ProviderTurn/AgentLoopStep identities in every successor.

Acceptance:

- unit matrix covers every current recovery branch;
- no Provider or repository symbol imported by the pure decision module;
- existing AH18/AH19 focused tests pass;
- one process restart test proves the same successor identity.

### R2 — Step/action transition (PP-W204)

Files:

- `packages/agent-runtime/src/agent-loop-actions.ts`
- new `packages/agent-runtime/src/step-transition.ts`
- action/step tests

Tasks:

- Define a transition input containing current step/action, decoded provider
  result, freshness decision, and effect facts.
- Move action-state classification into a pure transition function returning
  `Applied`, `SkippedStale`, `SkippedEarlySettlement`, `TerminalRejected`,
  `OutcomeUnknown`, or `RepairRequired`.
- Keep Session/action/Observation writes in the existing fenced transaction;
  the transition function may only produce an effect plan.
- Preserve one LogicalActionId, one ToolResult/Observation, and deterministic
  cursor successor behavior.

Acceptance:

- existing AH7/AH8/AH9/AH10 focused tests pass;
- transition matrix proves duplicate/idempotent and stale branches;
- a failure before commit rolls back the entire effect plan;
- no transition function imports Clock, SqlClient, ProviderPort, or global APIs.

### R3 — Settlement boundary (PP-W205)

Files:

- `packages/agent-runtime/src/agent-loop-driver.ts`
- `packages/application/src/` settlement consumer/command seam
- new settlement boundary tests

Tasks:

- Define `SettlementProposal` as an immutable Agent Runtime output.
- Ensure Agent Runtime returns proposals and does not directly mutate Work
  lifecycle or public projection state.
- Centralize the final Execution settlement commit at the existing Application
  transaction owner.
- Preserve OutcomeUnknown/ReconciliationRequired as a hard gate; never turn it
  into ordinary retry.
- Preserve exact receipt/Command identity and restart absorption.

Acceptance:

- settlement proposal tests cover Completed/Interrupted/Failed/OutcomeUnknown;
- transaction test proves proposal commit atomicity;
- public/process tests prove unchanged lifecycle and restart behavior;
- no duplicate settlement or second Provider request after restart.

## Change batches and validation frequency

The implementation is intentionally grouped to reduce repeated expensive gates:

### Batch A — contracts and pure modules

Implement R1/R2 ADTs, pure functions, and unit matrices in one batch. Run:

- Biome on changed files;
- package typecheck for `agent-runtime`, `model-context`, and `testkit`;
- focused pure tests only.

### Batch B — driver/action wiring

Wire R1/R2 into `model-decision.ts`, `agent-loop-actions.ts`, and the driver in
one batch. Run:

- package builds;
- all Agent Runtime tests;
- AH7–AH10/AH18/AH19 focused process tests.

### Batch C — settlement boundary

Implement R3 and its Application transaction seam in one batch. Run:

- Application and Execution Runtime builds;
- settlement/recovery tests;
- P1/P8/P9/P17 focused tests.

### Batch D — release validation

Only after A–C are green:

- architecture suite;
- controlled single-worker core suite on Windows;
- Web typecheck/build/test;
- functional process/UI suites as available.

Do not run the 336-file default-parallel core suite during intermediate batches;
it is known to exhaust Windows memory. The controlled single-worker command is
the authoritative interim core gate.

## Stop conditions

Stop implementation and record a Design Gap if extraction reveals a missing
durable identity, a new settlement meaning, a changed public disposition, or
an ambiguity in Work/Session provenance. Do not solve those by adding a
fallback branch.

## Batch C follow-up — process identity fixes

The first full process batch produced two isolated failures that now have
separate work items:

### C1 — AH7 ActionIntent probe

- reproduce only `AH7AfterActionIntentCommit` with the same scripted provider;
- prove whether the action intent is never admitted or only the qualification
  probe is skipped;
- acceptance requires one durable Action Pending row, one P4 intent, and one
  post-restart convergence without relaxing the crash boundary.

Current result: the isolated `AH7AfterActionIntentCommit` case passes 1/1 after
rebuild. Keep the full Batch C result as historical evidence because the prior
full run observed one probe miss; rerun C1 during final release validation
before closing it permanently.

### C2 — AH10 direct-child opaque WorkspaceRef

- capture the rootWorkspaceId, childWorkspaceId, and revision used by
  `WorkspacePlacementPort.childRef` before and after takeover;
- preserve the exact opaque ref as a durable binding fact across generation
  takeover, or prove the projection query must derive the same tuple;
- acceptance requires all direct-child takeover variants to return the exact
  original `wref_` and still preserve one Work/receipt/action.

Current evidence: the functional batch reports 13 direct-child ref mismatches;
the returned Work/receipt/action facts otherwise converge. Do not change
`childRef` hashing or relax the public ref assertion until the before/after
rootWorkspaceId, childWorkspaceId, and revision tuple has been logged from
the same public read chain.

These are process-level identity tasks, not unit-level transition changes.

Diagnostic result: the persisted placement row's `wref_` matches the current
`(rootWorkspaceId, childWorkspaceId, revision)` tuple, while the model-authored
`targetWorkspaceRef` came from a stale WorkspaceRef in the Work Session
context. This is direct evidence of cross-episode/shared-Session context
pollution. It is governed by PP-W401 (Session provenance/context frontier), so
do not patch `childRef` or accept stale refs in Runtime before that gate is
accepted.

Migration bridge note: until every Work write path is provenance-aware, an
entirely legacy Session (zero bound Work rows) retains its previous projection
so formation/inbox admission is not bricked. This bridge is temporary and must
be removed before G-01 is marked implementation-complete; once any bound Work
row exists, the Work frontier remains exact and fail-closed.
