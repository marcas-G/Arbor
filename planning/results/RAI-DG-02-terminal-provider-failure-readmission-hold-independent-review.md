# RAI-DG-02 terminal Provider failure hold — independent review

**Disposition:** **Blocking = 4; Nonblocking = 2. Not yet suitable for manual
acceptance at the reviewed hash.**

**Reviewed proposal:**
`planning/proposals/RAI-DG-02-terminal-provider-failure-readmission-hold-draft.md`

**Reviewed raw SHA-256:**
`4240722E39C6516F50E9FDCA6F43EE889BA282743157401425F78426D99C4499`

**Reviewed evidence:**
`planning/results/RAI-DG-02-real-S2-terminal-provider-failure-busy-loop.result.md`
and the retained read-only SQLite fixture named there.

**Review tree observed at:**
`1a09a90aaf9da4fe45b2e95fbf037aa54de5d0bd`

This is a read-only governance review. It does not accept the proposal,
authorize implementation, modify `docs/design/**`, change production code,
upgrade an existing database, or qualify real S2.

## Evidence verification

The RED is real and the reported cardinalities are reproducible from the
retained database without inspecting user/provider bodies:

- Executions: one failed `ConversationResponseEpisode` revision 0, one failed
  WorkEpisode revision 0, 615 failed WorkEpisodes revision 1, and one active
  WorkEpisode revision 1.
- ProviderAttempts: 617 `TerminalFailure / RequestRejected`, two `Success`,
  and one `InProgress`.
- ProviderTurns: 617 `Failed`, two `ToolCall`, and one unsettled.
- Canonical Work: exactly one `Open` Work at revision 1.
- All 617 failed Executions carry
  `Failed(ExecutionFailure("ProviderFailure:RequestRejected"))`.

This proves the common root cause: P3 correctly stops each terminal Turn, but
P2/P7 have no durable cross-Execution fact that prevents another admission of
the same Open Work revision. The proposed architectural direction is sound:
extend the existing exact-revision RAI gate; keep Work Open; keep P10
read-only; release execution only through an explicit authorized revision
advance; do not synthesize WorkWait, auto-cancel, auto-retry, or reinterpret
`Completed(Blocked)`.

## Blocking findings

### B1 — source cardinality and bounded identity are internally inconsistent

Section 1 says “A unique Execution exists ... with exact WorkEpisode binding
`(w,r)`”. The real evidence contains 616 WorkEpisode Executions for revision 1
(615 failed plus one active), and section 5 later explicitly permits multiple
validated sources and chooses the earliest witness. If “unique” means one
Execution for the Work tuple, the retained fixture becomes an integrity
failure instead of the promised derived hold; if it means that each candidate
`executionId` resolves to exactly one row, the current wording freezes the
wrong invariant.

The fixed proposal must state the latter explicitly: enumerate zero or more
candidate Executions bound to `(projectId, workspaceId, workId, revision)`;
each candidate identity, settlement-producing Step/Turn/final Attempt/Manifest
chain must be individually unique and exact; any valid candidate makes the
predicate true; equivalent candidates deduplicate only in P10. The bounded
source/witness contract must also include or explicitly internalize the
promised `(logicalStepNo, repairAttempt)` identity—the text says it is retained
but `TerminalProviderFailureSource` omits it.

The decision table also says a source from “another ... revision” has no
effect, while the next rows distinguish lower revision as stale and higher
revision as integrity failure. Replace the broad row with “lower/stale
revision”; future revision must remain fail-closed.

### B2 — P10 mechanics and integrity-failure visibility are not frozen

The proposal simultaneously requires P10 lag/ACK/reset/rebuild behavior and
claims no new source fact table, but it never chooses whether
`TerminalProviderFailure` is:

1. a query-time derived source over the terminal chain; or
2. a materialized marker driven by a specified event/outbox/queue.

There is no existing terminal-provider-failure event/queue named by the
package. Without this choice, “ACK”, dedup, rebuild, occurrence time, stale-row
removal and crash behavior are not mechanically implementable from one frozen
contract. Freeze query-derived semantics (the minimal option) or fully specify
the durable projection input and any schema/migration.

The same section says malformed historical chains require an
“operator-visible integrity Attention”, but defines only the valid-source
`TerminalProviderFailure` row. Freeze the integrity Attention source, target,
safe code/summary, dedup identity and freshness—or remove that claim and name
the already accepted bounded operational surface that exposes
`ReadmissionGateIntegrityFailure`. A fail-closed Work with no discoverable
operator surface is not a closed recovery path.

Also freeze `occurredAt` (the exact validated final Attempt settlement time is
the natural source) and its invalid-time disposition. Do not derive it from
query time or an Attention consumer clock.

### B3 — stale/terminal Attention and recovery disposition conflict

Section 4 says the Attention becomes inactive **solely** when its source
revision differs from the canonical revision. That leaves an ActionRequired
retry row live if an independently authorized governance path transitions the
Work to `Completed` or `Cancelled` without changing revision. The RAI gate is
an admission predicate for an Open Work; the presentation contract must not
claim retry is required for terminal Work.

Freeze the existing lifecycle rule: the hold is active only for canonical
`Open` Work at the exact revision; a terminal Work transition supersedes the
active Attention but does not delete source evidence. `SteerWork r -> r+1`
remains the only v1 path that resumes execution; it is not the only possible
governance disposition of the Work.

### B4 — negative and crash qualification omits decisive boundaries

The qualification list is insufficient for the frozen predicate:

- It tests retryable kinds only “while retry is eligible”. Current P3 can
  exhaust a retry budget and propagate the same retryable
  `ProviderFailure:<kind>` to Execution settlement. Add exhausted/deadline
  cases for `RateLimited`, `ProviderUnavailable`, and `StreamInterrupted` and
  prove they still do not become this terminal source merely because the
  Execution failed.
- The crash matrix names Attempt, Step and Execution settlement, but omits the
  ProviderTurn `finish_reason=Failed` commit that the predicate requires. Add
  both sides of Attempt, Turn, Step and Execution boundaries, including every
  partial-chain state yielding no guessed hold/admission.
- Add a synchronized two-connection/two-daemon race between final settlement,
  Work admission and `SteerWork`; assert commit-order linearization, at most
  one new-revision Execution, and zero same-revision admission.
- Add the retained 617-failure fixture (or an equivalent generated historical
  fixture with hundreds of exact repetitions) as a read-only upgrade/query
  qualification. “Fresh SQLite only” cannot prove the proposal's explicit
  historical-data behavior.

## Nonblocking findings

### N1 — remove an impossible integrity reason or define its comparison source

`FailureFingerprintMismatch` is listed although the proposal stores no
authoritative fingerprint in the source ledger and forbids the P2 gate from
reading P10. A freshly derived SHA-256 cannot mismatch itself. Remove this
reason from the gate union, or specify the immutable stored value against
which it is compared. P10 marker corruption, if materialization is selected,
belongs to P10 projection integrity rather than P2 source validity.

### N2 — correct the retry-exhaustion explanatory sentence

Section 1 says a retryable failure “later exhausts into a distinct
non-Provider ExecutionFailure”. That is not guaranteed by the current P3
policy: the Agent settlement path can preserve
`ProviderFailure:<retryable-kind>`. State the actual invariant instead: only
the three closed terminal kinds with `TerminalFailure + Stop` qualify; every
other kind/disposition is outside the source regardless of final Execution
reason text.

## Owner-boundary audit

Subject to B1–B4, the proposed ownership is aligned with the frozen chain:

- System Design owns Open-Work/user-visible recovery semantics.
- DID owns the cross-phase exact-revision invariant and crash ordering.
- P2 owns the canonical query and transaction-time admission recheck.
- P7 remains the sole runnability classifier and only consumes the P2 result.
- P3/P12 retain the closed Provider taxonomy and retry disposition; this
  package must not reclassify failures.
- P9 owns recovery ordering for the exact Attempt/Turn evidence and must not
  reconstruct from provider/session text.
- P6 owns the existing exact-revision `DirectionGuidance` /
  `ContractAmendment` mutation; no new retry command is introduced.
- P10/P13/Web present bounded facts and existing Steer affordance only; they
  never become scheduler authority.
- P17 ConversationResponse remains outside this Work gate.

The proposal does not weaken RAI-DG-01, `Completed(Blocked)`, WorkWait,
Permission, Sandbox, ResourceBoundary, Verification or Acceptance semantics.
No automatic cancel, synthetic wait, implicit retry, provider-config mutation
or raw provider body exposure is authorized.

## Required revision disposition

Revise B1–B4, recompute the proposal SHA-256, and obtain a new independent
review. The current hash must not be accepted or used for owner-document
landing. The RED evidence remains valid and should be retained unchanged.
