# P1 — Contract Index

**Authority:** DID v1.6 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P1-owned implementation contracts authorized
by DID §13.

```text
Detailed Implementation Design v1.6 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P1/**   (these contracts)
```

DID §13 now points at `docs/design/implementation/P1/**`; a conflict resolves
in favor of the DID.

## Documents

| Doc | Owns |
|---|---|
| `03-transaction-model.md` | `TransactionScope` service, single-transaction command resolution, fingerprint comparison, concurrent duplicate protocol, fence/stop split |
| `01-command-contracts.md` | failure vocabulary, generic pipeline, fingerprint algorithm, P1 command payload/result/rejection/event |
| `02-port-contracts.md` | P1 repository/port method sets, Effect A/E/R, transaction participation |
| `05-event-journal.md` | sequence scope + durable counter, `eventVersion`, offset/projection boundary, poison handling |
| `04-sqlite-schema.md` | DDL, cyclic FKs, indexes, resource-region encoding, migration, retention |
| `06-recovery-matrix.md` | crash-point matrix, durability, attempt recording |
| `00-contract-index.md` | this index |

## Gap closure mapping

| Gap | Status | Closed by |
|---|---|---|
| P1-DG-01 | RESOLVED (DID v1.5) | DID §6A.15 |
| P1-DG-02 | RESOLVED (DID v1.5) | DID §9.9; implemented by 01/03/04 |
| P1-DG-03 | RESOLVED (DID v1.5) | algorithm frozen in 01 §4 |
| P1-DG-04 | RESOLVED (DID v1.5) | DID §9.7; implemented by 03/04 |
| P1-DG-05 | RESOLVED (DID v1.5) | DID §12.11; implemented by 01 |
| P1-DG-06 | **RESOLVED** (phase-scoped) | 05 (+ 04 sequence table) |
| P1-DG-07 | **RESOLVED** (phase-scoped) | 04 |
| P1-DG-08 | **RESOLVED** (phase-scoped) | 04 (+ 02) |
| P1-DG-09 | **RESOLVED** (phase-scoped) | 04 (+ 06) |
| P1-DG-10 | RESOLVED (DID v1.5, port classification) | sub-items closed by 01 (AssignWork, child-workspace, ID generation) and 02 (port ownership) |
| P1-DG-11 | **RESOLVED** (phase-scoped, authority-as-input-fact) | 01 §2A (VerifiedCommandAuthority + exact-match), 03 §3.1 (replay before authority), 02 §4A (boundary input) |

## P1 command set

`CreateProject`, `CreateChildWorkspace`, `AssignWork` (DID §11).

## Status

FROZEN (contracts) — 4-way review rounds 1–4 complete, **Blocking = 0**.
All P1-DG-01…11 are RESOLVED. **P1-DG-11** was resolved by manual governance as
"authority as a trusted Application input fact" (`01` §2A): P1 defines only the
`VerifiedCommandAuthority` shape and a deterministic exact-match rule; it does
not implement a Permission/RBAC/Authority Resolver and has no default-allow.
No frozen DID document was modified while producing these contracts (DID v1.6
was a separate governance patch).
