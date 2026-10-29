# RAI-DG-01 v2 — independent governance review

**Disposition:** **Blocking = 0. Suitable as a fixed manual-acceptance package.**

**Reviewed proposal:** `planning/proposals/RAI-DG-01-readmission-hold-governance-draft.md`

**Proposal LF SHA-256:**
`0CEB2DAA2E6128F86CBD1CAA185B9847EAAB240360011F94425E0856F39AA106`

**Proposal worktree HEAD:**
`2e320e9cf742f24385cb96635d22c5bf7e88c7b8`

This review was prepared in a separate detached worktree at the proposal HEAD.
It records an independent contract review only. It does not accept the
proposal, authorize implementation, modify `docs/design/**`, or change the
proposal.

## Prior blocking findings

The three v1 blockers are closed in v2:

1. **P9 source inventory is closed and matches the current source types.** The
   proposal enumerates all eight `DeliverReplayFailureCode` values and all
   fourteen `AssignWorkBindingFailureCode` values, matching the existing
   unions in `packages/ports/src/assign-work-target-binding.ts`. AssignWork is
   limited to the direct-child committed-receipt binding proof owned by P9
   `07`. It separately names the `ReconciliationEscalated` journal event and
   `OutcomeUnknown(ReconciliationRequired(nonempty refs))` settlement. The
   latter is an explicit independent hold source even when no P10 row exists.
   The proposal excludes ephemeral `RecoveryBlocked`, unsettled
   `ReconciliationSourceError`, and ordinary settlements as independent hold
   sources. Its qualification matrix covers every listed code and excluded
   outcome.

2. **Malformed or ambiguous Episode/source bindings now have a typed,
   bounded, fail-closed contract.** The lookup tuple includes project,
   workspace, Work and current revision; source Executions and the EGP episode
   state are joined by exact Execution identity. The proposal specifies
   canonical scope checks, a closed `ReadmissionGateIntegrityFailure` reason
   set, propagation through classification and admission, and no inference
   from Session, current-work pointer, Message, Attention target or Parent
   workspace. Admission commits no Execution on an integrity error. P10 has a
   corresponding typed `ProjectionIntegrityFailure` contract and bounded
   fields.

3. **P10 stale-revision behavior covers lag, rebuild and restart.** Active
   Attention is filtered against canonical Work revision in the same read
   snapshot; this is not driven only by consuming `WorkSteered`. Materialized
   reads apply that filter, catch-up removes stale rows, rebuild reconstructs
   only active rows, and immutable source facts/events remain available for
   audit. The qualification plan checks stale rows before catch-up, during
   rebuild, and after restart.

## Scope and governance semantics

- Every Work-bound `Interrupted(RuntimeSafetyStop)` settlement creates a hold,
  including a stop with no P9 fact. This is a deliberate new choice and is
  explicitly called out in the proposal.
- A revision-advancing authorized `SteerWork` releases the old revision's
  hold. There is no same-revision dismissal or implicit resolution. P10 queue
  ACK remains housekeeping and cannot release the gate.
- The gate is keyed to the exact Work Episode `(WorkId, WorkRevision)` and
  validates project and owning Workspace. Valid non-Work Episodes are outside
  the rule. A Parent, child, sibling, different Work, or later revision is not
  held by another tuple's source. P7 remains the sole classifier; its input
  set is extended with the durable gate, and authoritative Work admission
  rechecks in `BEGIN IMMEDIATE`.
- Source facts/settlements, not the P10 Attention projection, drive admission.
  P10 remains read-only over canonical state. `OutcomeUnknown` can hold without
  synthesizing an Attention row; this is explicit, so it is not an unresolved
  contract gap.
- The P37 causal evidence is bounded: the later `619f727` result records the
  original Execution's normal `ExecutionOrigin` settlement as
  `Interrupted(RuntimeSafetyStop)` with `stop_requested_at = NULL`, then a
  different Execution/LogicalAction/ProviderTurn admitted on the same Work
  revision 85 ms later and committed the second Deliver receipt. The result
  does not claim the original Action was replayed.

## Nonblocking note

The gate scans candidate source Executions within the requested
project/workspace. A malformed or unknown-version binding in that workspace
returns an integrity error for an admission query rather than becoming a
guessed Work hold. This fail-closed behavior can temporarily prevent admission
of another Work in the same affected Workspace until the integrity issue is
addressed. That bounded operational blast radius is explicit and does not
create a false Attention association or spread to another project/workspace.

## Verification limits

No tests were run, as requested. This is a read-only governance-contract
review; the listed process, restart, concurrency, scope and projection cases
remain post-acceptance qualification requirements, not evidence claimed by
this review.
