# P15 — Archive Convergence

Close is not hard delete and does not cancel Work. It closes the authoritative Gateway admission gate and requests existing StopExecution/Quiescence for every unsettled project execution.

Within the Close command transaction:

- Pending messages become Declined and their humanmsg:* Inbox rows are consumed.
- Claimed messages with no committed execution, or a settled Failed/OutcomeUnknown execution, become Declined and their Inbox rows are consumed.
- Active executions receive stop requests and remain on the normal settlement path.
- Settled Completed/Interrupted conversations retain the normal Answered write-back path.

In local v1, Declined means ProjectClosed exclusively. settledAt and claimedByExecutionId provide its audit correlation; no generic decline-reason taxonomy is introduced.

Pending → Claimed is one SQL CAS guarded by an EXISTS Project lifecycle = Open predicate, so Close-first cannot claim. Delayed trigger passes can only observe and converge durable state; they are not the lifecycle authority.

