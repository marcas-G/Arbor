# Critical Steer Option A Design Landing — Independent Review

**Reviewed landing commit:** `307f6f2d9ef25060a080cc85f8082669846dbe1a`  
**Reviewer:** `/root/p41_manifest_recovery_order_fix` (independent read-only review)  
**Review result:** PASS · Blocking = 0  
**Decision:** `ACCEPT_CRITICAL_STEER_NO_ACTIVE_MAIN_OPTION_A`  
**Fixed proposal SHA-256:** `41A732B1092CF2147BA319E0FEE5D7513CF899C53917051EF501AA8EBCDF8F20`

## Findings

- The only changed owner contract is `docs/design/implementation/P6/04-human-steer.md`;
  no upstream design contract was edited.
- The accepted Option A is represented faithfully: when the transaction-time
  Workspace lookup has no active main, SteerWork and HumanInput still commit,
  Work stays Open, and neither StopExecution nor
  `ExecutionStopRequested` is emitted.
- The contract states that a pre-transaction candidate is provisional. The
  transaction-time active main is authoritative, including one admitted after
  preparation; exact Stop authority is resolved for that row, and a partial
  Steer is forbidden if Stop cannot be applied.
- P6 §5 covers the no-active result, the stale-preparation/new-admission race,
  and all-or-none handling when the exact Stop leg fails.

The review checked the design landing only. Production implementation
qualification is recorded separately.
