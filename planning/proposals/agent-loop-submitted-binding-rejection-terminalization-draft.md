# Submitted DecisionEpisode binding rejection terminalization — governance draft

Status: **DRAFT / awaiting manual governance decision**
Implementation: **not authorized beyond the isolated failure evidence**
Scope owners to review: P2 `06`, P3 `08`, P9 `07`, and P10 `02` only if a
public Attention outcome is selected.

## Failure evidence

The isolated pending test
`tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`
uses the real public Scheduler path to form a DecisionEpisode, then reaches the
test-only `AH9BeforeTerminalActionCommit` boundary after the SelectCurrentWork
Command is Committed and the DecisionRequest is Submitted. Before the crash,
the action is Pending, Observation is absent, and the exact Step is
`ActionsInProgress` at cursor 0. After killing gen0 and waiting for the real
lease to expire, the fixture changes exactly one persisted binding field:

1. the DecisionRequest `workspace_id` is changed to a second, real Workspace
   in the same isolated database; or
2. the Step `manifest_id` is changed to another real persisted Manifest in that
   database.

All other selected canonical rows are read back unchanged. Gen1 acquires the
same Execution at generation 1. In both cases the durable result is:

```text
Execution: settled_at != NULL, settlement_kind = Failed
AgentLoopStep: exact ProviderTurn, ActionsInProgress, cursor 0,
               settlement_json = NULL
Action: exact SelectCurrentWork LogicalAction, Pending,
        observation_source_ref = NULL
AgentLoopAction Observations for that Execution: none
```

No second Provider request, SelectCurrentWork Command, or CurrentWorkChanged
event is recorded. Both negative cases fail on the same orphan-state assertion.
The reproduction is isolated from the default functional batch:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts
```

The guard correctly rejects both mismatches, but the rejection path calls
`proposeSettlement(Failed)`. That helper only persists `SettlementProposed`
when the current Step is `Prepared`; for `ActionsInProgress`, it returns the
settlement without advancing the Step or resolving the Pending Action.

## Frozen constraints

- A mismatched Workspace or Manifest must not authorize a new Provider request,
  SelectCurrentWork Command, Work selection, Action effect, or Observation.
- Existing Committed receipts and canonical WorkSelection facts are immutable;
  no second Command, CurrentWorkChanged, DecisionRequest, or Execution may be
  created to hide the mismatch.
- P3 `08` binds Manifest once and requires the AgentLoopStep state machine to
  persist a proposal before the driver returns. P9 `07` requires
  `ActionsInProgress` recovery to converge a LogicalAction or execute its next
  Pending entry. P2 `06` recovery may not leave an unsettled resumable Step
  silently terminalized outside its durable proposal.
- `OutcomeUnknown(ReconciliationRequired)` is not an automatic fit: these
  fixtures involve a known committed canonical command, not an ambiguous P4
  ToolInvocation with unknown external effect.
- P9 `07` §3's legacy-adoption Attention rule does not by itself define a new
  generic Attention source for every malformed active Step. Do not infer or
  extend that projection without owning-document review.

## Decisions required before implementation

The governor should choose and record one durable disposition for a current
non-legacy `ActionsInProgress` Step whose submitted DecisionRequest or pinned
Manifest binding contradicts authoritative state:

1. **Terminal Step proposal.** Persist a typed `SettlementProposed(Failed)` for
   the exact Step, and define the exact Action ledger disposition/Observation
   that records the binding contradiction without claiming the canonical
   Command failed or was not applied.
2. **Durable recovery Attention / Action Required.** Keep the Step unresolved
   and prevent ordinary `SettleExecution`; define the fact owner, safe summary,
   unique identity/deduplication, severity, public projection, retry/clear
   conditions, and crash-consistent visibility. This route requires explicit
   P2/P9/P10 ownership and a compatible source vocabulary.
3. **Another explicit terminal rule.** The proposal may name a different
   existing owner/state only if it proves how the same Step and Pending Action
   reach a coherent durable terminal state without replay or fabrication.

These options are mutually exclusive at the terminal-state boundary. No code
path should use `SkippedEarlySettlement`, `OutcomeUnknown`, or an arbitrary
Attention source merely to make the current test green.

## Required post-decision qualification

After the accepted owning-document contract is landed and implementation is
separately authorized, retain both isolated corruption cases and prove:

1. each single-field mismatch is rejected before action/provider replay;
2. no extra Command, ProviderAttempt, CurrentWorkChanged, Work or Observation
   occurs;
3. Execution, AgentLoopStep and Action end in the selected coherent durable
   disposition on both sides of the relevant commit/crash boundary; and
4. the successful Committed-receipt takeover remains 3/3 green.

This draft is evidence and a decision request only. It does not amend
`docs/design/**`, accept a route, or authorize production implementation.
