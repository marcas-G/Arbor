# S3 Child Workspace Resource Ownership Governance Proposal

**Status:** Fixed proposal for manual governance acceptance  
**Date:** 2026-10-26  
**Scope:** S3 formation, activation, and resource admission for child Workspaces  
**Design files:** No edits to `docs/design/**` are included in this proposal.

## 1. Failure evidence and bounded gap

The S3 public journey forms Parent and Child Workspaces and gives the Child a
ResourceBoundary that is a subset of the Parent boundary. The committed
`resource_ownership` state, however, contains an active claim only for Root.
PermissionGrant authorizes a capability but does not create or widen resource
ownership. Consequently, the Child's patch reaches P4 resource admission and is
rejected with `ResourceAdmissionDenied` despite its boundary including the
intended FileTree. The child cannot perform its assigned responsibility.

This is a governance gap in the relationship between P6 formation and P4
resource admission: the boundary ceiling is established, but no governed
ownership claim is activated for the new child. It is not a request to make
PermissionGrant an ownership mechanism or to let admission mutate ownership.

## 2. Proposed minimal semantics

1. A Child Workspace receives a write-ownership claim only through a durable,
   explicit ownership delegation from its Parent. Formation may carry that
   delegation in the same approved formation package as the Child boundary;
   absent a delegation, the Child remains non-writable and resource admission
   fails closed.
2. Every delegated claim is resolved by the existing Environment resolver to
   a `CanonicalResourceRegion`; raw path strings are never ownership truth.
   Each claim is contained by both the Child's current ResourceBoundary and the
   delegating Parent's active ownership region. A PermissionGrant cannot
   enlarge either ceiling.
3. The existing global no-overlap rule for canonical write regions continues
   to apply across active owners. A child claim may carve a strict subregion
   from a parent claim only by atomically narrowing/splitting the Parent claim
   and adding the Child claim; the post-state must have no overlap. If the
   resolver cannot prove containment, disjointness, or an unambiguous split,
   reject the whole governance change with a typed conflict/integrity result.
   Do not use string-prefix comparisons or silently choose one owner.
4. Formation/ownership activation is one logical, idempotent convergence:
   durable Child + boundary + ownership-delegation intent commit atomically;
   post-commit activation resolves the persisted boundary and delegation,
   then in one `BEGIN IMMEDIATE` transaction rechecks Parent/Child revisions,
   canonical containment, global overlap, and exact source identity before
   writing ownership state and its event. Retries converge on the same claim;
   changed environment mapping fails closed and requires a new human-governed
   revision rather than rebinding.
5. Parent retains ownership of its non-delegated remainder. Parent may not
   write in a region assigned to Child. Re-delegation requires an atomic
   governance change that first revokes/narrows the old claim and then grants
   the successor claim, with revision checks and no intermediate committed
   overlap. Child ownership cannot be further delegated unless separately
   authorized by an explicit governance change; v1 default is no onward
   delegation.
6. Reclaim/revoke is likewise an atomic ownership governance change. A Parent
   may reclaim a Child region only after the Child has no active execution,
   open Work, or unresolved effects bound to that region, or through a typed
   quiescence/recovery path that preserves known in-flight outcomes. Retiring a
   Child consumes/revokes its ownership in the same semantic change. No
   implicit ownership transfer occurs on retirement, boundary edit, or grant
   revocation.
7. P4 remains validate-only: it reads the exact active claim and boundary and
   rejects missing, stale, overlapping, or out-of-bound ownership. It never
   creates, repairs, or expands claims during effect admission.

## 3. Atomicity, concurrency, and error behavior

The canonical ownership repository remains the serialization point. A single
transaction must include the complete post-image of Parent and Child claims,
revision CAS checks, canonical overlap evaluation, durable state changes, and
the corresponding events. Concurrent formation/activation or competing
delegations linearize there; exactly one compatible post-image may commit.
Any failure rolls back all ownership and event writes. Duplicate/retried
activation is idempotent by the durable formation/delegation identity.

Typed outcomes must distinguish at least: stale Parent/Child revision,
boundary/claim containment failure, canonical overlap conflict, resolver
mapping drift, missing delegation, and ownership integrity failure. Rejections
must leave the complete ownership post-image unchanged. Unknown resolver or
storage outcomes must not be converted into success or a guessed owner.

## 4. Commands, events, and migration contract

The accepted owning-document landing must freeze the exact command/event
contract. Proposed shape:

- Formation carries a bounded optional `ResourceOwnershipDelegation` intent
  (resource address refs plus Parent-approved scope); it is part of the exact
  formation decision, not model-authored authority.
- A dedicated semantic ownership change records the exact Parent and Child
  identities, expected Workspace/boundary/ownership revisions, canonical
  resolved post-image, delegation source, and actor/authority provenance.
- Existing `ResourceOwnershipChanged` is extended only if its current version
  can represent the complete atomic transfer. Otherwise add a versioned event;
  never reinterpret historical events.
- Persist active delegated ownership and provenance (delegating Workspace,
  source formation/delegation identity, claim revision, canonical region,
  source address snapshot/ref, resolved environment revision). Preserve the
  existing resolved-claim fields.
- Add an additive migration that backfills no child ownership by inference.
  Existing Root claims remain unchanged. Any legacy child state lacking exact
  durable delegation evidence remains unowned and requires an explicit new
  governance delegation. Migration is transactional, restart-safe, and does
  not activate filesystem access.
- Runtime activation consumes the durable formation/delegation record, uses
  the persisted boundary as F21 requires, and exposes durable typed failure
  evidence to the public process surface. It does not fall back to a new path.

The design landing should assign command/event/schema ownership to the current
P1/P6/P4 owners and specify exact migration number only after inspecting the
current migration head. This proposal intentionally does not fabricate those
implementation-level identifiers.

## 5. S3 acceptance matrix

| Case | Setup/action | Required public and durable result |
|---|---|---|
| S3-1 delegated child write | Form Child with explicit Parent-approved region; activate; execute patch | Child has one active canonical claim within both boundaries; patch succeeds; one claim/event; Parent retains only remainder |
| S3-2 no delegation | Form Child with boundary but no ownership delegation; attempt patch | Formation may exist; no child claim; P4 returns typed `ResourceAdmissionDenied`; no filesystem effect |
| S3-3 grant cannot expand | Grant Child patch capability beyond its ownership region; attempt patch | Permission is insufficient to widen ownership; denied with no effect |
| S3-4 overlap/alias | Competing claims resolve to overlapping canonical backing through aliases/worktree mapping | One atomic conflict result; no partial claim/event; no effect |
| S3-5 boundary escape | Delegation exceeds Child or Parent ceiling | Reject activation/ownership transaction; no claim and no effect |
| S3-6 activation restart | Crash before and after activation transaction commit; restart and retry | Before: no partial state; after: exact same claim converges once; no path rebinding |
| S3-7 concurrent activation | Two processes activate the same delegation or competing overlapping delegations | Same delegation is idempotent; conflicting delegation has one winner and one typed rejection; unique post-image |
| S3-8 parent/child revision race | Change boundary/delegation after intent but before activation | Stale intent fails closed; no claim; fresh human-governed revision required |
| S3-9 revoke/reclaim | Attempt reclaim while child has active execution/open Work/unresolved effect, then after quiescence | First is rejected/held; after safe quiescence atomic transfer leaves no overlap and preserves audit |
| S3-10 migration | Upgrade existing Root-only database with historical formed children | Root ownership preserved; child ownership remains absent absent explicit evidence; migration restart-safe |
| S3-11 S3 public journey | End-to-end formation, child patch, verification, delivery/acceptance | Child can write only its delegated region; Parent/Child ownership split is inspectable and survives restart |

Qualification requires public-process evidence for S3-1/2/3/11, real SQLite
transaction/restart evidence for S3-4/6/7/8/9/10, and no reliance on private
store reads as the sole proof of user-visible behavior.

## 6. Implementation plan after governance landing

1. Land the accepted semantics in the owning frozen document(s), preserving
   the proposal hash, manual decision record, revisions, and independent
   post-landing consistency review. Do not begin implementation before this
   acceptance and landing review.
2. Freeze phase contracts for the exact formation payload, ownership command,
   event versions, typed errors, ports, and migration. Add isolated failing
   S3 tests first, including alias overlap and crash/restart boundaries.
3. Implement the canonical ownership transaction and event persistence;
   implement post-commit activation from durable boundary/delegation evidence;
   keep P4 admission validate-only.
4. Implement explicit revoke/reclaim/quiescence behavior and additive migration
   with legacy children fail-closed.
5. Qualify the acceptance matrix in phase order, including clean database
   upgrade, public API/browser journey, real process restart, concurrency, and
   full repository gates. Record evidence and residual limitations; do not
   claim S3 closure if any row is missing.

## 7. Fixed manual decision

The manual governor is asked to accept or reject this exact semantic package:

`ACCEPT_S3_CHILD_WORKSPACE_RESOURCE_OWNERSHIP_DELEGATION_V1`

Proposal SHA-256 is computed over the exact UTF-8 file bytes and recorded in
the acceptance decision. Acceptance authorizes only design landing and
planning; implementation requires the resulting owning-document landing and
its explicit implementation authorization. No production code, database,
or `docs/design/**` changes are authorized by this proposal itself.
