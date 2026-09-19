# P1-DG-04 — P1 fencing scope, predicate, and Stop-quiescence interaction

## Status

RESOLVED — DID v1.5.

## Resolution

DID §9.7/§11 separate authoritative fence validation from stop/quiescence
mutation admission. `FencingRejected` is only for invalid ownership/fence;
a still-valid worker rejected due to `stopRequestedAt` returns Application
`ExecutionStopping` (not `FencingRejected`). P1 owns the persistence hook +
transaction integration; P2 owns lease lifecycle; the exact SQL predicate is
a P1 phase contract.

Authority: DID v1.5 §9.7, §11, §6A.15.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §11, §6.3, §9.7, §12.3,
§3.4; P0 artifact `packages/domain/src/execution.ts`.

## Symptom

1. Scope contradiction: §11:3176 puts "authoritative fencing" in **P1**,
   while §11:3183 puts "Lease / Fencing" in **P2**. P1's three commands are
   `External`/`System` origin and carry no fence token.
2. The exact fence predicate and the repository/step that performs it are
   not frozen. §7.3:1870-1879 lists `ExecutionRepository` methods but no
   fence-validation method for a canonical command; Appendix B shows
   `CommandGateway`/`CommandStore`/`TransactionPort` with no signatures.
3. Stop-quiescence: §3.4:960-962 / §12.11 require `StopExecution` to
   immediately block new Execution-originated canonical commands, but the
   design does not say whether this is part of the fence predicate, a
   separate precondition, or the stop fact. A predicate using only
   `generation + settled_at IS NULL` would violate it.
   `stop_requested_at` appears nowhere in the frozen schema.

## Evidence

```text
DID §11:3176    P1 atomic State + Receipt + Event + authoritative fencing
DID §11:3183    P2 Lease / Fencing
DID §6.3:1461   fence validation shares the canonical transaction
DID §9.7:2860   same transaction/session for canonical command
DID §7.3:1870   ExecutionRepository method example (no fence method)
DID §3.4:960    StopExecution blocks new Execution-originated commands
DID §9.3:2747   table list only; no executions/leases columns
```

## Why planning cannot decide this

Which phase builds lease/fencing, the exact CAS predicate, its owning
repository method, and the stop-vs-fence interaction are **concurrency /
authority semantics**.

## Required resolution

Freeze: P1 vs P2 fencing scope; the exact predicate and owning step; the
`executions`/`execution_leases` columns needed; and how stop-requested
interacts with fence validation.

## Affected P1 areas

Transaction model, DDL, command contracts, recovery matrix.
