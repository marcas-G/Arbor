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
