# P11 — 10 Ownership Claim/Release Wiring (GQ1b — scope-fenced)

**Authority:** GQ1(b) 裁决 (scope fence verbatim); P1 `02` §3 (OwnershipWriteService frozen), v1.8 G4 (validate-only admission unchanged).
**Status:** DRAFT.

## 1. Minimal wiring (IN scope)

- **Real claim call sites**: workspace boundary activation (CreateProject
  Profile recovery / CreateChildWorkspace / UpdateResourceBoundary paths)
  resolves and writes claims via OwnershipWriteService (the P1 CAS sequence
  becomes live). CreateProject recovery is limited to the exact root
  Workspace, committed boundary, and `WorkspaceResourceActivationIntent`
  revision; it never reads the Profile catalog or request path.
- **Real release call sites**: boundary shrink; **RetireWorkspace enforces the frozen §1.4A precondition** (`no active ResourceOwnershipClaim`, DID:653/:4217) — the typed rejection points operators at the release paths (boundary shrink / worktree retirement) first; retirement itself never auto-releases claims (B1 fix: no silent §1.4A semantics change).
- **Worktree↔ownership consistency**: worktree retirement requires released claims (`09` §3).
- **Idempotency/atomicity**: command-owned claim/release are
  command-receipt-idempotent; failure atomicity is the P1 single-transaction
  sequence (stale → bounded re-resolve per `04` §2). CreateProject OPEN-3
  activation is idempotent on the unique `(projectId, workspaceId,
  resourceBoundaryRevision)` intent and its Pending→Active compare-and-set; it
  does not create another command receipt.

## 1A. CreateProject post-commit activation (FT-DG-01 OPEN-3)

CreateProject's Project, root Workspace boundary, Primary Session, existing
ProjectCreated/WorkspaceCreated v1 events, Pending activation intent, Pending
status event, and Committed receipt are already committed before this P11
operation begins. An activation failure is therefore never reported as a
CreateProject rollback and never rewrites/duplicates its receipt or original
events.

For each Pending intent, P11 loads the current canonical Workspace and requires
its `resourceBoundaryRevision` to equal the intent's pinned revision. It
resolves the persisted boundary through the existing ProjectEnvironmentPort
outside the write transaction; it never queries ProjectResourceProfilePort or
chooses another boundary. `OwnershipWriteService.activatePendingWorkspaceResource`
then opens one `BEGIN IMMEDIATE` transaction: it rechecks intent state and the
environment revision, loads active overlaps, inserts the complete claim set,
CASes the exact Pending intent to Active, and appends
`WorkspaceResourceActivationChanged(Active)`. Claim, CAS, and event commit or
roll back together. The P1 ownership service's ordinary self-transactional
`resolveAndWrite` is not nested or used as a second commit.

If another daemon/replay already committed Active for the same tuple, P11
returns `AlreadyActive` without another claim or Active event. Competing
Pending activations serialize through SQLite `BEGIN IMMEDIATE` and the intent
CAS; the winner creates one canonical claim set, while the loser observes the
winner. A crash before commit leaves Pending and no partial claim; a crash after
commit leaves Active + claims + event and cannot repeat the claim write. There
is no durable Processing lease. Resolver, stale-revision, or ownership errors
leave the intent Pending and do not broaden authority. A different boundary
requires a separate, explicitly authorized ownership operation; this contract
does not perform it.

## 2. Scope fence (verbatim, OUT of scope)

Ownership protocol redesign; lease/TTL/preemption; multi-owner; distributed locking; arbitration extensions.

## 3. Unchanged neighbors

P4 admission remains validate-only (`ResourceOwnership ⊆ ResourceBoundary`); ownership changes remain governance commands (v1.8 G4).

## (mapping: CI-3)
