# Design Gaps

A **Design Gap** is a question the frozen design does not answer, discovered
while projecting or implementing it. Per `AGENTS.md`, implementation stops
on the affected work and the gap is raised for **manual governance**.

## Rules

- A Design Gap is recorded here, **never** resolved by editing
  `docs/design/**` from planning or implementation.
- Only manual governance edits the design document that owns the semantics.
- A gap is closed only when the owning design document is updated and this
  record points to the resolving revision.
- Affected tasks are marked blocked until the gap is closed.
- Planning may fix citation/ownership/structure defects itself; it may not
  invent domain semantics to close a gap.

## Status legend

```text
OPEN     — awaiting manual governance
RESOLVED — owning design doc updated; see resolution
```

## Index

| ID | Title | Owning design doc | Affected tasks | Status |
|---|---|---|---|---|
| DG-01 | `hard-bound` Dependency predicate undefined | DID §1.4A, §12.11; System Design §4.9 | P0-006, P0-012, P0-016 | RESOLVED |
| DG-02 | `ExpectedDeliverable` schema & matcher undefined | DID §1.8, §3.6, §8.16, §9.4, §12.11 | P0-012, P0-016 | RESOLVED |
| DG-03 | Policy revision fields inconsistent across §3.x / §8.19 / §12.11 | DID §3.1, §3.2, §8.19, §12.11 | P0-005, P0-006, P0-016 | RESOLVED |
| DG-04 | `PermissionGrantId` missing from Appendix A prefix table | DID §2.1 vs Appendix A | P0-002 | RESOLVED |
| DG-05 | `Workspace.agentBinding` typing vs `AgentBinding` union | DID §1.6, §3.2 | P0-006, P0-015 | RESOLVED |
| DG-06 | Architecture test placement conflict | DID §10.1 vs `AGENTS.md` rule 5 | P0-001, P0-017 | RESOLVED |

All six gaps were resolved by the System Design v1.3 / DID v1.4 governance
patch. Resolution authority is recorded in each gap file.

## P1 Design Gaps (pre-implementation closure)

Discovered during P1 requirements extraction + independent gap review. P1
implementation is blocked until these are `RESOLVED` or explicitly closed by
P1 phase-scoped contracts.

| ID | Title | Owning design doc | Status |
|---|---|---|---|
| P1-DG-01 | Error algebra incomplete (`FencingRejected` / `PersistenceUnavailable`) | DID §6A.4, §6A.5, §4.1, §12.5 | RESOLVED |
| P1-DG-02 | Resolution states / receipt shape / attempt vocabulary | DID §4.1, §7.4, §9.9 | RESOLVED |
| P1-DG-03 | Idempotency identity: `payload_hash` vs `semanticRequestFingerprint` | DID §4.1, §9.9 | RESOLVED |
| P1-DG-04 | P1 fencing scope, predicate, Stop-quiescence interaction | DID §11, §6.3, §9.7, §12.3, §3.4 | RESOLVED |
| P1-DG-05 | `CreateProject` bootstrap paradox + root contents | DID §4.1, §3.1, §3.2, §12.11, §9.13 | RESOLVED |
| P1-DG-06 | Event journal: sequence scope, `eventVersion`, offset atomicity | DID §2.3, §5.2, §5.4, §9.9 | RESOLVED |
| P1-DG-07 | Schema precision: cyclic FKs, table↔domain mapping, root uniqueness | DID §9.1, §9.3, §9.13 | RESOLVED |
| P1-DG-08 | `resource_ownership` persistence lifecycle | DID §9.5, §1.4A, §1.5 | RESOLVED |
| P1-DG-09 | Retention / delete policy and migration mechanism | DID §9.1, §12.11, §5.4 | RESOLVED |
| P1-DG-10 | Port ownership, ID generation, `AssignWork` errors, child-workspace phase | DID §7.2, Appendix B, §0A.1, §11 | RESOLVED |

`P1-DG-01/02/03/04/05/10` were resolved by the **DID v1.4 → v1.5** governance
patch (`planning/p1-governance-patch.md`). `P1-DG-06/07/08/09` were P1 phase-scoped and are now closed by
`docs/design/implementation/P1/**` (4-way review round 4, Blocking = 0).

Items explicitly delegated to P1 by DID §13 (exact DDL/migration/indexes;
exact per-command contracts; exact repository/port signatures; resource-region
physical encoding) are **phase-closure**, not gaps; they are closed by the P1
phase-scoped contracts (`docs/design/implementation/P1/**`).

## Resolution process

```text
Design Gap (OPEN)
↓
manual governance edits the owning design doc
↓
update this record -> RESOLVED + resolving revision
↓
update affected planning tasks
↓
resume implementation
```
