# P1-DG-08 — resource_ownership persistence lifecycle

## Status

OPEN — awaiting manual governance.

## Owning design document

`docs/design/03-detailed-implementation-design.md` §9.5, §1.4A, §1.5, §12.11.

## Symptom

§9.5:2816-2824 lists `resource_ownership` fields but only `created_at`.
It does not freeze: how a claim becomes inactive/released; whether an update
appends with a supersede link or updates in place; whether
`resource_boundary_revision` / `resolved_at_environment_revision` are CAS
columns; or the index supporting the `BEGIN IMMEDIATE` conflict load.
§1.4A:434 requires "no active ResourceOwnershipClaim" for retirement, which
presupposes a release concept.

## Evidence

```text
DID §9.5:2816   resource_ownership fields (created_at only)
DID §9.5:2828   BEGIN IMMEDIATE → conflict load → overlap → write
DID §1.4A:434   RetireWorkspace requires no active ResourceOwnershipClaim
DID §12.11      immutable durable records list excludes ownership (mutable)
```

## Why planning cannot decide this

Release/supersede semantics, CAS columns, and the conflict-load index are
**ownership persistence semantics** (the overlap algebra itself is already
frozen in P0/P1-DG region encoding).

## Required resolution

Freeze: claim release/supersede model; active-claim predicate; CAS column
set; and the index for conflict load.

## Affected P1 areas

`resource_ownership` DDL, ownership write transaction, retirement.
