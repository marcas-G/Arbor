# Transaction Ownership Inventory

This table records the current intended owner before implementation cleanup.
It is an engineering boundary map, not a change to transaction semantics.

| Boundary | Transaction owner | Must not own a new transaction |
|---|---|---|
| External command gateway | `packages/application/src/gateway.ts` | handlers and projections |
| Domain command handler | gateway/application command boundary | repository helper |
| Agent action effect commit | Agent Runtime step transaction | provider adapter |
| Provider attempt/turn settlement | Provider Runtime transaction seam | Web or projection |
| Session append + AgentLoopStep cursor | Agent Runtime/application handoff | model compiler |
| Verification conclusion | verification command/application consumer | read projection |
| Verification wake | wake delivery boundary; scheduler re-drive outside | nested scheduler call |
| Deadlock evaluation | one read snapshot transaction | detector pure function |
| Web view query | server query boundary | browser component |

## Current risk markers

- `wait-graph.ts` and `verification-wake.ts` explicitly support ambient
  transaction reuse because the SQLite adapter rejects nested transactions.
- Several repository methods require `TransactionScope`, but the ownership is
  not visible in their names or types.
- `runModelDecision` mixes reads, repairs, provider calls, and writes, making
  transaction ownership difficult to review.

## Refactoring rule

New code must identify the owner in the function/module name or its port type.
If a helper can run both inside and outside a transaction, expose two named
faces (for example `readInTransaction` and `readSnapshot`) rather than making
the behavior implicit.

## Acceptance evidence

PP-W301 is complete only after a transaction-boundary test proves that a
failure before commit rolls back all facts and a retry does not duplicate them.
