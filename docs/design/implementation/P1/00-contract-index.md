# P1 — Contract Index

**Authority:** DID v1.5 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P1-owned implementation contracts authorized
by DID §13.

```text
Detailed Implementation Design (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P1/**   (these contracts)
```

Once reviewed, a small DID v1.6 governance patch adds the authority index line
pointing here. Until then these documents are drafts for review and
`P1-DG-06..09` remain `OPEN`.

## Documents

| Doc | Owns | Closes |
|---|---|---|
| `03-transaction-model.md` | TransactionPort / TransactionScope / single-transaction command resolution / fence hook | A3 |
| `01-command-contracts.md` | P1 command payload/result/rejection/event; generic pipeline | A1, P1-DG-02, P1-DG-05, P1-DG-10 sub-items |
| `02-port-contracts.md` | P1 repository/port method sets + Effect A/E/R + tx participation | A2, P1-DG-08 access, P1-DG-10 port ownership |
| `04-sqlite-schema.md` | Exact DDL, cyclic FKs, indexes, migration, retention | A4, P1-DG-07, P1-DG-08, P1-DG-09 |
| `05-event-journal.md` | sequence scope, eventVersion, offset atomicity | A6, P1-DG-06 |
| `06-recovery-matrix.md` | crash-point matrix | A8 |
| `00-contract-index.md` | this index | — |

## P1 command set

`CreateProject`, `CreateChildWorkspace`, `AssignWork` (DID §11 P1). All other
commands close in their owning phase.

## Open items carried into review

1. `AssignWork` rejections `WorkspaceNotFound` / `ProjectClosed` /
   `ResponsibilityViolation` (DID §0A.1) are not yet in the frozen
   `DomainError`; proposed for the DID v1.6 patch.
2. Resource-region physical encoding per resource kind is a P1 contract for
   `ProjectEnvironmentPort` (overlap stays in the domain function).

## Status

DRAFT — awaiting four-way review. No `docs/design/**` frozen document was
modified while producing these contracts.
