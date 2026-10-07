# AH10 DecisionEpisode expired-lease takeover dispatch — implementation disposition

Status: **RESOLVED AS AN IMPLEMENTATION DEFECT UNDER EXISTING FROZEN CONTRACTS;
implementation authorized by DID v1.21 ALS-I1; no new semantic choice or design
change.**
Date: 2026-10-08
Scope: AH10 generation takeover for the frozen `DecisionEpisode` binding.

## Original failure evidence

The isolated real-process test
`tests/functional/pending/ah10-select-current-work-takeover.functional.test.ts`
used public Project/Work setup and real production daemons/30-second lease. The
Scheduler persisted a Pending `WorkSelectionDecisionRequest` for two runnable
candidate Works and admitted an exact `DecisionEpisode`. The model returned
`select_current_work`; the gen0 action intent was durable. After the gen0 lease
expired, a second daemon acquired no lease within 45 seconds. The DecisionRequest
remained Pending/revision 0, the action remained Pending without Observation,
and no SelectCurrentWork receipt or Workspace mutation existed. This was RED
before the FencingRejected receipt boundary, not an AH10 takeover PASS.

## Frozen-contract disposition

P2-06 §4A requires an unsettled Execution with resumable durable AgentLoopStep
progress to remain Active and be re-dispatched under a current lease. P9-02
W3/L4/DF2 and P9-07 AH10 require lease-generation takeover and receipt-first
Command recovery. EGP-2/EGP-5 define DecisionEpisode as an exact durable
Workspace episode that uses the same Agent Loop. DID v1.21 ALS-I1 already
authorizes the AH1–AH14 recovery implementation and tests.

The defect was the production tick's Work-only filter in
`apps/single-workspace/src/main.ts::resumeActiveWork`: after Scheduler Noop for
the existing Active Main Execution, it returned for non-Work episodes. It did
not reach the existing `preDispatchCheck` / `runExecution` path for an active
DecisionEpisode. The implementation now resumes the existing Active Workspace
Execution for any exact episode binding. Scheduler Noop remains in place, so no
second Execution or DecisionRequest is admitted. Existing lease/fence and
pending-approval gates remain on the resume path; `runExecution` resumes the
same durable AgentLoopStep.

This is implementation of an existing contract, not a new DecisionEpisode
priority, replay, or settlement rule. No manual semantic acceptance or
`docs/design/**` landing is required for this fix. No frozen design document
was changed.

## Qualification result

The test now lives at
`tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts`
and passes two real dual-daemon cases using the production TTL:

1. Gen0 FencingRejected receipt transaction held before commit; an independent
   read cannot see it; killing gen0 rolls it back; gen1 commits once.
2. Gen0 FencingRejected receipt committed and observed; killing gen0 lets gen1
   receipt-first converge and commit once.

Both preserve ExecutionId, DecisionRequest, ProviderTurnId, LogicalActionId and
callRef; DecisionRequest is Submitted at revision 1; there is one canonical
selection/CurrentWorkChanged/Observation; the public Current Work is the
selected candidate; no second Decision Provider request occurs. Full evidence:
`planning/results/AH10-select-current-work-takeover.result.md`.

The SelectCurrentWork dispatch defect is closed. AH10 remains PARTIAL until its
other canonical control actions, additional state combinations and independent
Deliver/VCS governance gaps receive their required qualification.
