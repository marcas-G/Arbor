# S3 Canonical Ownership Carve-out Governance Supplement

**Status:** Fixed proposal for manual governance acceptance  
**Date:** 2026-10-26  
**Scope:** Exact representation of Parent remainder after child resource delegation  
**Design files:** No edits to `docs/design/**` are included.

## 1. Parent proposal and bounded gap

This supplement narrows the representation gap in the accepted
`ACCEPT_S3_CHILD_WORKSPACE_RESOURCE_OWNERSHIP_DELEGATION_V1` package. That
package requires a child delegation to atomically narrow/split the Parent
claim, preserve the Parent's non-delegated remainder, and leave globally
non-overlapping active ownership. The current canonical claim is one region
with no subtraction operator. A prefix region such as `/repo` minus
`/repo/child` cannot be represented by one remaining prefix. Enumerating
filesystem siblings is neither finite nor stable, and a raw string prefix is
not canonical ownership evidence.

## 2. Fixed minimal representation

Adopt a canonical claim set:

```text
OwnershipRegion = {
  allow: CanonicalResourceRegion,
  exclusions: CanonicalResourceRegion[]
}
```

The effective owned set is the canonical `allow` region minus the union of
the finite `exclusions`. Each exclusion is a strict canonical descendant of
`allow`, in the same resource space and canonical region kind. Exclusions are
stored in normalized canonical form, sorted by the existing canonical region
ordering, unique, and prefix-antichain (no exclusion contains another).
Excluded regions are denied to this owner; they are not implicitly owned by
anyone. A child claim for an excluded scope is a separate explicit active
claim. This keeps the global rule over *effective* owned sets: distinct active
owners may share intersecting allow envelopes only when exclusions prove
their effective sets disjoint.

This representation is sufficient for v1 delegated path subtrees and exact
database/external-resource regions: delegation adds one finite exclusion to
the current owner's claim and creates the child's claim for exactly that
resolved canonical scope. It does not enumerate possible path siblings. It
does not support arbitrary geometric subtraction, wildcard patterns,
case-sensitive aliases that the resolver has not canonicalized, or
unbounded/dynamic exclusion rules. If the canonical comparator cannot prove
the set operation, reject the whole change as a typed ownership-integrity or
canonical-conflict result; do not approximate it.

An active claim must have a nonempty effective set. Empty `exclusions` means
the full allow region. Empty effective claims are released, never retained as
active. The canonical algebra is defined only over the existing resolver's
normalized region model and `resourceSpaceId`; source path strings are never
compared to decide ownership.

## 3. Canonical containment and overlap rules

For canonical prefix regions in one resource space:

1. `A` contains requested delegated base `B` only when the resolver-backed
   comparator proves `A.allow` contains `B.allow`, and no exclusion of `A`
   intersects only part of `B`. If one exclusion contains all of `B`, the
   request is outside A's effective ownership and is rejected. A partial
   intersection means the proposed child scope is not wholly owned by Parent
   and is rejected; silently subtracting that part would alter the approved
   child scope.
2. Two effective claims overlap when their allow regions overlap and neither
   claim has an exclusion that completely covers the intersection region.
   Partial exclusion of the intersection does not prove disjointness.
3. A child claim must be wholly contained by both the Parent's effective
   claim and the child's current ResourceBoundary. Parent/Child boundary and
   ownership revisions are checked in the ownership transaction.
4. For aliases or mapped worktrees, the resolver's canonical
   `resourceSpaceId` and normalized region are authoritative. Alias inputs
   resolving to the same canonical region conflict unless the exact
   post-image's exclusions prove disjoint effective sets. Resolver drift from
   the durable activation intent is a typed failure requiring a new governed
   revision.
5. Canonical region kinds with equality-only semantics permit only exact
   delegation/reclaim; no descendant carve-out is inferred.

The domain API must return a typed `Contained`, `NotContained`, `Overlap`, or
`Disjoint` result rather than relying on application code to reproduce these
rules. It must reject malformed, noncanonical, empty, cross-space, or
non-antichain exclusions.

## 4. Atomic delegation, re-delegation, and reclaim

Delegation remains explicit Parent-approved formation intent. The durable
intent identifies the exact formation proposal/revision and resolved
canonical child scope. In one `BEGIN IMMEDIATE` ownership transaction:

- re-read and CAS Parent Workspace, Parent boundary, Child Workspace/boundary,
  and ownership revisions;
- verify exact durable delegation identity and resolver mapping;
- verify the delegated scope is inside Parent effective ownership and Child
  boundary;
- add the canonical scope to Parent exclusions, preserving the other
  exclusions in normalized antichain form;
- create the Child claim for the delegated canonical scope with empty
  exclusions and full provenance;
- check the complete post-image for effective overlap against every active
  claim; and
- write the ownership state, revision changes, and versioned ownership event
  atomically.

No intermediate Parent/Child overlap or moment with unowned delegated scope
may commit. A retry uses the exact formation/delegation identity and returns
the already committed result without adding another exclusion, claim, or
event. Replaying an identity with different canonical mapping or revisions
fails closed.

V1 does not authorize onward child delegation or arbitrary transfer to a
third Workspace. Re-delegation to a successor is allowed only as one
governance change that removes the old child's exact claim, adds the
corresponding Parent exclusion (or updates the same delegator's exclusion),
creates the successor claim, and verifies the entire post-image atomically.
It does not broaden any other owner's allow region.

Reclaim is an explicit Parent ownership change after the existing typed
quiescence condition is satisfied: no active execution, open Work, or
unresolved side effect is bound to the child-owned scope, or an explicit
recovery path preserves each known in-flight outcome. In the same transaction,
release the Child claim, remove the exact canonical exclusion from Parent,
CAS revisions, and append the event. Child retirement consumes/revokes its
ownership in that same semantic transaction. Boundary edits, grant
revocation, and Workspace retirement alone never remove exclusions or
transfer ownership.

## 5. P4 admission semantics

P4 remains validate-only. For a requested effect region, admission must prove
all of the following from the current durable snapshot:

- the exact Workspace has an active claim whose effective set contains the
  complete requested canonical effect region;
- that region is within the Workspace's current ResourceBoundary;
- the claim's owner, boundary revision, and canonical mapping are current;
- the effective ownership post-image has no overlap with another active
  owner; and
- the required capability grant separately authorizes the operation.

An effect intersecting any exclusion is denied, including when the requested
effect only partially intersects it. A matching grant cannot remove an
exclusion, create a claim, or widen `allow`. Missing, stale, malformed,
overlapping, or unprovable ownership fails closed before the external effect.
P4 does not repair/re-resolve durable claims or activate pending intents.
Normal admission checks continue to use resolver-produced canonical regions;
they never use raw path-prefix tests.

## 6. Schema and migration contract

At proposal time the current migration head is schema 52. The implementation
phase should use the next sequential additive migration after rechecking the
actual head; the proposed identifier is 53. Migration adds a durable
canonical exclusions field (empty array for existing rows) and provenance
needed to bind delegated claims: delegating Workspace, exact formation /
delegation source identity, ownership claim revision, source address snapshot
or durable ref, and resolved Environment revision. Activation intent stores
the exact Parent/Child and their expected Workspace, boundary, and ownership
revisions plus the resolved delegation identity. Exact SQL names and JSON
codec version belong to the authorized phase contract.

Migration is transactional, restart-safe, and creates no ownership claims or
exclusions by inference. Existing Root claims remain effective over their
existing regions. Historical child claims without exact delegation evidence
remain unowned/fail-closed; do not synthesize Parent exclusions or Child
provenance. New columns must have deterministic defaults only where that
default is semantically neutral (empty exclusions); unknown delegated
provenance must remain explicitly absent and unusable for activation.

The event must represent the complete Parent and Child post-image/provenance
and exact identity. Use the existing `ResourceOwnershipChanged` version only
if its frozen payload can encode all of it; otherwise add a new event version
and preserve historical decoding without reinterpretation.

## 7. Required qualification and isolated REDs

Before production changes, add isolated pending tests outside the default
suite for:

1. Parent `/repo` delegating `/repo/child`: Parent effective ownership denies
   the child subtree but retains `/repo/other`; Child owns only its delegated
   subtree; effective sets are disjoint.
2. Partial exclusion, nested/non-antichain exclusion, malformed canonical
   region, cross-space alias, and resolver mapping drift all fail closed.
3. Child effect inside its delegated scope passes P4; effect touching or
   crossing an excluded/undelegated scope fails before filesystem effect;
   capability grant cannot expand either claim.
4. Atomic transaction rollback at each write/event boundary leaves the full
   Parent/Child/other-owner post-image unchanged; commit/restart retry
   converges to one claim set and event.
5. Reclaim while active execution/open Work/unresolved effect exists is held;
   safe quiescent reclaim removes the child claim and exact Parent exclusion
   atomically. Competing delegations serialize with one compatible winner.
6. Schema-52 upgrade preserves Root claims and produces no inferred Child
   ownership; interrupted/retried migration has the same result.
7. Public S3 delegated, no-delegation, and grant-cannot-expand journeys pass
   through the public process surface.

No S3 closure claim is permitted until the accepted S3-1…S3-11 matrix and
these representation-specific cases have evidence.

## 8. Fixed manual decision

Accept or reject this exact semantic supplement:

`ACCEPT_S3_CANONICAL_OWNERSHIP_CARVEOUTS_V1`

Acceptance authorizes only landing this fixed representation in the owning
frozen documents and planning. It does not authorize implementation,
migration execution, database mutation, or release claims. Record the exact
proposal SHA-256 and obtain separate implementation authorization after
landing review.
