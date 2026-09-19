# DG-01 — `hard-bound` Dependency predicate undefined

## Status

RESOLVED — System Design v1.3 / DID v1.4.

## Resolution

The undefined "hard-bound" term was removed. Dependency producer is now
expressed by the frozen `ProducerBinding` ADT
(`AnyProducer | WorkspaceBound | WorkBound`), and the `Unfulfillable`
consequences are stated per variant.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 §1.8, §1.4A, §12.11
- `docs/design/02-system-design.md` v1.3 §3.7, §4.9

Resolved in: System Design v1.3 / DID v1.4 (repo not yet under VCS; commit
record pending P0-001).

## Owning design document

`docs/design/03-detailed-implementation-design.md` (§1.4A, §12.11) and
`docs/design/02-system-design.md` (Workspace retirement).

## Symptom

The design makes two domain transitions contingent on a Dependency being
"hard-bound", but never defines what makes a Dependency hard-bound:

- `RetireWorkspace` precondition: "no unresolved hard-bound incoming
  Dependency" (DID §1.4A:416; §12.11:3494).
- `CancelWork` / producer loss consequence: "Hard-bound producer Work
  cancelled / producer Workspace retired deterministically marks affected
  `Unsatisfied` Dependency `Unfulfillable`" (DID §12.11:3573).
- `02-system-design.md:466` repeats the precondition.

## Evidence

```text
grep -rni "hard-bound" docs/design/
03-...:416   no unresolved hard-bound incoming Dependency
03-...:3494  ... unresolved hard-bound dependency ...
03-...:3573  Hard-bound producer Work cancelled ...
02-...:466   ... hard-bound unresolved Dependency ...
```

No definition of the predicate exists anywhere in the frozen documents.
The `Dependency` field list (§1.8:618-626) has `producerWorkspaceId?`,
`producerWorkId?`, `expectedDeliverable`, `revision` — none of which is
stated to encode "hard-bound".

## Why planning cannot decide this

Implementing `RetireWorkspace` and the `Unfulfillable` consequence requires
choosing the predicate (producer workspace set? presence of `producerWorkId`?
an explicit flag? a contract property?). That is a **domain state
transition / ownership rule**, which planning must not invent.

## Required resolution

Manual governance must freeze, in the owning document:

1. the definition of "hard-bound" (which Dependency property/properties),
2. its relation to `producerWorkspaceId?` / `producerWorkId?`,
3. the exact trigger set for `MarkDependencyUnfulfillable` on producer loss.

## Affected planning tasks

- `P0-006` (RetireWorkspace precondition)
- `P0-012` (Unfulfillable consequence)
- `P0-016` (invariant tests)
