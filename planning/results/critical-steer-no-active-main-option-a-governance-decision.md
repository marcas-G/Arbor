# Critical Steer No-Active-Main Governance Decision

**Decision:** `ACCEPT_CRITICAL_STEER_NO_ACTIVE_MAIN_OPTION_A`  
**Accepted:** 2026-10-24  
**Fixed proposal SHA-256:** `41A732B1092CF2147BA319E0FEE5D7513CF899C53917051EF501AA8EBCDF8F20`

The accepted Option A says: if the target Workspace has no active main at the
Critical Steer transaction's current-state selection, commit the outer
SteerWork and its HumanInput in that transaction, keep Work Open, and do not
invoke StopExecution or emit `ExecutionStopRequested`. If the transaction sees
an active main, Critical Steer must stop that exact current main in the same
outer transaction. A pre-transaction selection is preparation only; it cannot
cause a newly active main to be skipped.

The owning landing is limited to `docs/design/implementation/P6/04-human-steer.md`
§4 and §5. P1 still owns the outer receipt/transaction, P2 still owns
StopExecution, and P12 still produces the exact external Stop authority. No
upstream design, domain type, command payload, schema, or migration is changed.

## Exact decision

- No active main in the outer SteerWork transaction: SteerWork and HumanInput
  commit; Stop has no target, with no `ExecutionStopRequested` event.
- Active main in the outer transaction: use the current Workspace active main,
  without filtering by WorkId; bind/resolve its exact P12 Stop authority and
  stop it in the same transaction.
- If the transaction-time active main differs from the prepared candidate,
  re-resolve against the transaction-time row. Failure to obtain/apply the
  exact Stop means the composite cannot commit partial SteerWork facts.
