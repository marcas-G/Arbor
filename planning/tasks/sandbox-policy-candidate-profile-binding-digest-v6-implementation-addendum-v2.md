# Sandbox Policy Candidate Profile Binding Digest V6 — Fixed Implementation Addendum v2

**Status:** planning-only; V6 implementation authorization pending
**Date:** 2026-10-19
**Supersedes:** `sandbox-policy-candidate-profile-binding-digest-v6-implementation-addendum.md`, Git-blob raw SHA-256 `DFE26F95A8AD5CC3C8C5DAB0D6761EC7E8DBAF9D74ED7DACEFAF81E8106CD464`
**Suggested authorization token:** `AUTHORIZE_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6_IMPLEMENTATION`

## 1. Authority, review disposition and scope

This fixed v2 addendum overlays the already authorized
`planning/tasks/sandbox-policy-candidate-readmodel-v5-implementation-plan-v2.md`
(Git-blob raw SHA-256
`B99C2682F30F277AA9E3C7C135E4A8A2C5C5811C3B44C380604ABB3B6F1CC3B9`).
The V5 token and V5-A integration are recorded in
`planning/results/sandbox-policy-candidate-readmodel-v5-a-authorization-and-integration.record.md`.
V5's P5, P4, P1, P2, P10, P13, production injection and real-process slices
remain governed by that plan. This document adds only the V6 candidate
handle-digest changes within those slices.

The accepted V6 proposal has raw SHA-256
`90300163BA7F2EE31314E63A028A3D67F9DD87D79895796F6DB81304D846DCB2`.
Its DID v1.57 and P4/05, P10/05, P13/03/06, P1/01 owner landing is
`24307d68`; independent design post-landing consistency review reports
B0/B1/B2 = 0. Design acceptance is not implementation authorization.

The v1 implementation-addendum review reported B0 = 0, B1 = 1. Its B1
finding is accepted here: a proposed P10/P11 seam containing only a complete
ResourceBoundary and active claims cannot call the existing
`produceSandboxBoundaryV1`. That producer additionally requires the full
`resolvedRegions`, the exact current Workspace responsibility revision, and
the exact active primary managed GitWorktree region. V2 pins all of those to
one read snapshot and adds failure tests. It also separates a pure
claim/access digest drift from a ResourceBoundary revision drift when
asserting the P1 stale receipt field. No v1 plan text remains authority for
implementation where this file differs.

The implementation scope is candidate DTO/domain codec, Workspace Detail
API/projection mirror, P10 same-barrier P11 inputs with reuse of the P4/05
producer, P13/Web selected-candidate mapping, and corresponding V5 tests.
P1 wire/payload/codec, schema, migration, authority, command fingerprint,
receipt variants and committed policy snapshot remain unchanged. The
singular V21 `sandboxPolicyPreconditions` form also remains unchanged.

## 2. Complete same-barrier P10/P11 seam

For one authorized Workspace Detail candidate read, the P11 seam supplies
the following as **one coherent source snapshot** inside P10's existing
`TransactionScope` and freshness barrier:

1. Exact current Workspace identity and its current responsibility revision.
2. Full current `ResourceBoundary`, its `basisResponsibilityRevision`, and
   current `resourceBoundaryRevision`; the responsibility revision must equal
   the boundary basis revision.
3. Complete `resolvedRegions` from resolving **all** boundary addresses in
   that same P11 observation, with the existing alias/duplicate collapse and
   exact resolved-set consistency proof. A pending tool target, one address,
   cached subset, or a new independent resolution is not a substitute.
4. Exact current Workspace ownership records, including active and released
   status, from the same snapshot. Only exact active claims at the current
   boundary revision affect WorkspaceWrite access.
5. Exactly one active primary managed GitWorktree binding for that Workspace,
   including its exact canonical GitWorktree region. It must be current,
   non-retired, and represented in the complete resolved set; a path, prefix,
   display name, or guessed `workspace` mount is not evidence of the binding.

P10 hands those pinned inputs and each offered candidate's policy kind/profile
to the existing `produceSandboxBoundaryV1`. P4's producer performs the frozen
canonical validation and derives target refs, mounts/access, and the exact
`SandboxHandleBindingDigestV1`. ReadOnly yields all RO mounts;
WorkspaceWrite yields RW only on exact active owned regions; TrustedLocal
FullAccess yields logical RW mounts without an OS isolation claim. Candidate
digests may coincide when the resulting mount/access projections coincide.
P10 cannot obtain a second P11 observation between candidates, infer an
address from the pending tool, or read P11/P4 private stores directly.

Missing, duplicate, retired or stale primary binding; non-GitWorktree
primary; primary absent from resolved regions; resolved-set mismatch;
responsibility-revision mismatch/drift; malformed ownership or boundary;
ambiguous target/mount identity; or unavailable P11 proof fails the **whole**
candidate read through the existing typed read/lag failure path. It never
emits a partial list or substitutes an old committed policy digest. A valid
snapshot with zero active claims is allowed and does not fail by itself.
P4's exact pending-requirement proof and P5's validated full bundle/current
host tuple proof remain separate prerequisites in the same coherent response.

## 3. Closed candidate shape and selection

Move `sandboxHandleBindingDigest: Sha256` out of candidate-read
`commonPreconditions` and require it immediately after `candidateId` in
**each** closed OsEnforced and TrustedLocal candidate. Update the domain
codec, API and projection mirrors as one shape; reject missing/extra/mixed
old and new forms. Retain V5 common fields, candidate ordering, exact
duplicate/conflict behavior, safe redaction and `spc2_` tuple-only ID
preimage. Boundary or ownership change can change a candidate's digest while
its presentation ID remains the same. P1 never receives the ID.

After deliberate human selection, P13/Web maps **only that candidate's**
digest to existing P1 `expectedSandboxHandleBindingDigest`. OsEnforced alone
gets its existing registry pair and the human-supplied matching
NetworkPolicyV1; TrustedLocal remains explicitly FullAccess/Unconfined with
separate high-risk confirmation. A stale receipt clears the entire read and
choice, waits for existing invalidation or explicit refetch, and requires a
new selection even if the ID is unchanged. No automatic reuse, submit or
fallback is added. P1's existing profile-specific CAS and same-CommandId
receipt replay remain authoritative.

## 4. Failing-first DAG and exit evidence

```text
G0 verify V5/V6 authority + integrate V6 design landing after token
  → A domain codec and independent RO/RW golden vectors
  → B API/projection closed-shape mirror
  → C complete same-barrier P11 seam and P4 producer reuse
  → D P13/Web selection, stale reason and reselection
  → E V5 real SQLite dual-daemon restart adjustments
  → F focused/full authorized V5 gates and scope review
```

**G0.** Verify the V5 v2 blob SHA and authorization, V6 accepted proposal
SHA, `24307d68` owner landing, independent design B0/B1/B2 = 0 review, and
this addendum's exact implementation token. Only then integrate the V6
design landing into the unified implementation checkout and begin code work.
The current V5-A DTO/codec and API/projection mirrors are a foundation,
not V6 implementation evidence. Resolve integration conflicts against the
accepted owner text; do not edit `docs/design/**` as coding work.

**A.** Write the closed-codec red test first: no common digest; one
lowercase 64-hex digest immediately after `candidateId` in every candidate;
old/mixed or malformed forms reject. Independently fix canonical inner
`TargetIdentityDigestV1` and outer `SandboxHandleBindingDigestV1` preimages
and SHA-256 golden values for RO and RW access using the existing P4/05
`ws_v16_fixture` FileTree basis, mount `workspace`, boundary revision 2.
With one owned mount, ReadOnly differs from WorkspaceWrite/FullAccess;
without an active claim, ReadOnly and WorkspaceWrite may coincide while
FullAccess differs. The TrustedLocal
`spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d`
candidate-ID golden remains unchanged. Implement the V6 domain codec only
after the red test fails for the intended field placement.

**B.** Write API/projection red tests for exact candidate key order,
authorized visibility, candidate/singular mutual exclusion, old/mixed-form
rejection and no mount, target ref, host path, ownership record,
RecoveryBinding or provider diagnostic leakage. Update both mirrors together.

**C.** Write an initial no-decision/P4-proven pending-action test with no
committed policy snapshot. Require one P11 observation containing all five
input groups in §2 and exactly one producer result per offered candidate.
Cover claimed/unclaimed and multi-mount profiles; current stale-policy
refresh must derive from current source facts, never the old snapshot.
Add separate red negatives for missing primary, duplicate primary, retired
primary, stale/foreign primary, non-GitWorktree or unresolved primary,
resolved-set mismatch, and responsibility revision drift. Also cover
malformed ownership/boundary, target collision, unavailable P11 source,
P4 requirement error and P5 authority/host tuple failure. All must yield a
typed failure/lag with no partial candidate list. Force a boundary or
ownership change during the read barrier: the result is one coherent old
snapshot or one coherent new snapshot, never mixed digests. Assert no second
P11 observation, address inference, pending-tool subset or P10 direct private
store read.

**D.** Write P13/Web mapping red tests for each available OS profile and
TrustedLocal. For the **digest-specific stale reason**, change the active
claim/access projection after the read while keeping Workspace revision,
ResourceBoundary revision, Episode/policy revision and every other P1 CAS
input fixed. The selected candidate's digest changes; P1 must return the
existing durable `StaleSandboxPolicyInputs` with field
`SandboxHandleBindingDigest`, no decision/event write, and same-CommandId
receipt replay. The refreshed list can retain the same `candidateId`, but
P13 must require manual reselection and submit the new selected digest.
Test mount/boundary revision drift **separately**: P1 may report its earlier
`ResourceBoundaryRevision` stale field, so that case must not demand a digest
reason. An ownership change that leaves selected digest and all other CAS
inputs equal is not invented as a new stale condition. Preserve OS network
input and TrustedLocal warning/confirmation.

**E.** Amend the V5 real SQLite two-daemon journey to read per-profile
digests from one complete current P11 source snapshot and then exercise
claim/access drift with unchanged revisions, old-digest rejection, explicit
refetch and reselection despite stable candidate ID. Before reapproval,
the same P3 Action remains Pending, invocation NotAdmitted, RecoveryBinding
unchanged, and lease/worker/provider/effect/Observation counts zero; no new
marker or Attention appears. After the existing P1 command commits,
kill/restart the other daemon and prove one current decision, at most one
resumed admission, no duplicate command/event/decision and no provider call
caused merely by read or approval. Keep a separate boundary-revision drift
oracle and V5 registry-only full-bundle drift paths for TrustedLocal and
OsEnforced; do not conflate their stale fields.

**F.** Run affected domain, API, P10 query, P13/Web, P1 gateway, P4/P2
admission and two-daemon suites; `pnpm check`; then the V5 plan's functional
restart gate on a disposable migrated database. Record red-to-green evidence
and any failure; focused pass is not full release evidence. Verify the
implementation diff stays in the V6 seam and other already authorized V5
slices, with no P1 wire/schema/migration/authority change. Only the V5
plan's final closure gates may close the whole candidate feature.

## 5. Self-review and authorization

- B1 is repaired at the input contract: exact Workspace responsibility
  revision, full boundary, complete resolved set, ownership and exactly one
  active primary managed GitWorktree binding are pinned together.
- Producer reuse is executable from those inputs without a second P11 read,
  an inferred primary mount or a committed initial policy snapshot.
- Negative tests distinguish valid zero claims from unprovable ownership,
  and distinguish digest-only claim/access drift from boundary-revision
  drift in P1's ordered CAS.
- V5 ordering, ID, redaction, full-bundle currentness, P4/P9 gates and
  two-daemon zero-effect/single-convergence oracles remain in force.
- This file is planning-only and supersedes the v1 addendum. No design,
  production code, test or migration change is authorized by committing it.

If the manual governor authorizes this exact v2 file, record its Git-blob
raw SHA-256 and the token:

```text
AUTHORIZE_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6_IMPLEMENTATION
```

Implementation remains stopped at this V6 seam until that authorization.
A new semantic contradiction must return to manual Design Gap governance.
