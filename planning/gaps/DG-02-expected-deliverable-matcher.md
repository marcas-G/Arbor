# DG-02 — `ExpectedDeliverable` schema & deterministic matcher undefined

## Status

RESOLVED — System Design v1.3 / DID v1.4.

## Resolution

`ExpectedDeliverable` is frozen as `{ kind: DeliverableKind,
requiredArtifactRoles: readonly ArtifactRole[] }`; `Deliverable` gains
`kind` and role-tagged artifacts; the matcher input `DeliverableMatchView`
and the deterministic algorithm
(`matchesExpectedDeliverable(producerBinding, expectedDeliverable, candidate)`)
are frozen in DID §1.8.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 §1.8, §3.6, §8.16
- `docs/design/02-system-design.md` v1.3 §3.7, §3.8

Resolved in: System Design v1.3 / DID v1.4.

## Owning design document

`docs/design/03-detailed-implementation-design.md` (§1.8, §3.6, §8.16,
§9.4, §12.11).

## Symptom

`SatisfyDependency` is gated by "a pure deterministic `Deliverable`
matcher" against the Dependency's `expectedDeliverable`, but neither the
`ExpectedDeliverable` schema nor the matching rule is defined.

- `Dependency.expectedDeliverable` is declared a versioned contract
  (§1.8:622-628; §3.6:928-936).
- `SatisfyDependency` precondition: "`targetDependencyRevision == current`
  + pure deterministic `Deliverable` matcher returns true" (§12.11:3568).
- The design says only that it must be "machine-matchable" (§12.11:3566)
  and "structured" (§8.16:2496); §9.4:2715 says JSON VO.

## Evidence

The frozen docs specify no fields to compare, no equality/normalization
rule, and no failure behaviour for a non-matching Deliverable. A Coding
Agent cannot implement or test the matcher without inventing the contract.

## Why planning cannot decide this

The matcher is the **central satisfaction semantic** of the Dependency
aggregate. Choosing its schema and equality rule is a domain decision, not
an implementation detail.

## Required resolution

Manual governance must freeze, in the owning document:

1. the `ExpectedDeliverable` schema (fields, types, versioning),
2. the deterministic match rule (fields compared, normalization, equality),
3. behaviour when the matcher returns false (reject, no state change).

## Affected planning tasks

- `P0-012` (Dependency satisfaction)
- `P0-016` (invariant tests)
