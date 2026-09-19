# DG-03 — Policy revision fields inconsistent across §3.x / §8.19 / §12.11

## Status

RESOLVED — DID v1.4.

## Resolution

`Project` now has `projectPolicyRevision` and `Workspace` has
`workspacePolicyRevision`, distinct from the aggregate `revision`:
`UpdateProjectPolicy` / `UpdateWorkspacePolicy` increment both; other
mutations increment only the aggregate `revision`. §12.11 truth tables use
the precise field names. `ControlBasis` now has real canonical sources.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 §3.1, §3.2, §8.19, §12.11

Resolved in: DID v1.4.

## Owning design document

`docs/design/03-detailed-implementation-design.md` (§3.1, §3.2, §8.19,
§12.11).

## Symptom

The truth tables require a policy revision to increment, and the control
basis reads policy revisions, but the aggregate field lists do not define
those fields.

- §12.11 Project: `UpdateProjectPolicy → Open, revision++`
  (DID:3476). §12.11 Workspace: `UpdateWorkspacePolicy → policy revision++`
  (DID:3491).
- §8.19 `ControlBasis` reads `projectPolicyRevision` and
  `workspacePolicyRevision` (DID:2600-2601).
- §3.1 `Project` fields list `revision` but no policy revision
  (DID:721-730). §3.2 `Workspace` fields list `revision`,
  `ResponsibilityRevision`, `ResourceBoundaryRevision` but no policy
  revision (DID:742-756).

## Evidence

Two frozen sections imply `projectPolicyRevision` / `workspacePolicyRevision`
exist as distinct fields; the aggregate state model does not include them.
A Coding Agent cannot know whether `UpdateWorkspacePolicy` increments a
dedicated field or the aggregate `revision`.

## Why planning cannot decide this

Whether policy revisions are dedicated fields or folded into the aggregate
revision is a **domain state model** decision.

## Required resolution

Manual governance must freeze, in the owning document:

1. whether `projectPolicyRevision` / `workspacePolicyRevision` are distinct
   fields,
2. which counter `UpdateProjectPolicy` / `UpdateWorkspacePolicy` increments.

## Affected planning tasks

- `P0-005` (Project transitions)
- `P0-006` (Workspace transitions)
- `P0-016` (invariant tests)
