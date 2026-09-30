# P15 — Archive Convergence

Close is not hard delete and does not kill an Execution or cancel Work. It submits a deterministic existing cooperative StopExecution/Quiescence request for every Active execution. Runtime rechecks the closed gate before new ProviderTurn, ToolInvocation, AgentAction or successor admission.

Pending/unadmitted human turns become Declined(ProjectClosed) with Inbox retract. Claimed turns with committed execution settle/write back first. Failed/OutcomeUnknown turns on a Closed Project become Declined and never retry. Replayed HumanMessageSubmitted must observe canonical Declined state and not revive Inbox.

Close uses existing AgentLoopStep and settlement vocabulary: in-flight Provider without complete evidence cancels to existing terminal provider failure then Interrupted/Failed; OutcomeUnknown requires real nonempty unresolved ToolInvocation refs. OutputRejected Retry and NextStepReady ensure their already durable Prepared successor, but start no provider turn; StepEffectsCommitted has no successor and progresses via SettlementProposed Interrupted or real-tool-ref OutcomeUnknown. Existing SettlementProposed settles normally.

Initial name-policy adoption runs read-only preflight. Only unchanged compliant rows get idempotent metadata backfill. Noncompliant/normalization-changing legacy rows fail the P15 feature closed until a separately governed, auditable repair contract exists; direct SQL rewrite is forbidden.

