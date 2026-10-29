# Sandbox Policy Candidate Profile Binding Digest V6 — Fixed Implementation Addendum

**Status:** planning-only; V6 implementation authorization pending
**Date:** 2026-10-19
**Suggested token:** `AUTHORIZE_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6_IMPLEMENTATION`

## 1. Authority and relation to the V5 plan

This is an additive, narrow amendment to
`planning/tasks/sandbox-policy-candidate-readmodel-v5-implementation-plan-v2.md`,
whose authorized Git-blob raw SHA-256 is
`B99C2682F30F277AA9E3C7C135E4A8A2C5C5811C3B44C380604ABB3B6F1CC3B9`.
The V5 implementation token and initial V5-A integration are recorded in
`planning/results/sandbox-policy-candidate-readmodel-v5-a-authorization-and-integration.record.md`.
The V5 plan remains the work plan for its P5, P4, P1, P2, P10, P13, policy
injection, and real-process slices. This addendum changes only the V6
candidate handle-digest seam within those slices; it does not silently expand
the V5 authorization to new semantics.

Manual governance accepted the fixed V6 proposal with raw SHA-256
`90300163BA7F2EE31314E63A028A3D67F9DD87D79895796F6DB81304D846DCB2`.
The design landing is `24307d68` (DID v1.57; owning P4/05, P10/05,
P13/03/06 and P1/01 contracts). Its independent post-landing consistency
review reports B0/B1/B2 = 0. That design acceptance authorizes the owner
landing only. The implementation below waits for the exact V6 token above.

At this addendum's base, the unified implementation checkout contains V5-A
candidate DTO/codec and Workspace Detail API/projection mirrors that still put
one `sandboxHandleBindingDigest` in `commonPreconditions`. It must be updated
as one coordinated closed-shape change; no dual V5/V6 candidate wire form or
fallback decoder is authorized. The legacy singular V21
`sandboxPolicyPreconditions` union is a separate form and remains unchanged.

## 2. Authorized scope if the token is accepted

| Slice | Exact V6 work | Boundary |
|---|---|---|
| Domain DTO/codec | Remove `sandboxHandleBindingDigest` from candidate `commonPreconditions`; require it immediately after `candidateId` in each OsEnforced and TrustedLocal candidate; reject missing, misplaced, extra and malformed fields under the closed codec. Preserve V5 `spc2_` tuple-only candidate IDs, golden vector, ordering and duplicate semantics. | Candidate read only; no change to the singular V21 preconditions codec. |
| API/projection | Mirror the new closed candidate shape through existing Workspace Detail response and projection codecs. Keep candidate/singular mutual exclusion, authorized-human visibility and safe redaction. | No route, ViewId, Problem, persisted row or Attention source. |
| P10/P11 read seam | In the existing Workspace Detail transaction/freshness barrier, obtain P11's complete current ResourceBoundary and exact active Workspace ResourceOwnership for one coherent source snapshot. Reuse the existing P4/05 profile-specific full-boundary producer for each offered candidate: ReadOnly all RO, WorkspaceWrite RW only on exact active owned regions, TrustedLocal FullAccess logical RW without an OS isolation claim. Put the resulting `SandboxHandleBindingDigestV1` on that candidate. | P10 does not read P11/P4 private stores, substitute a pending-tool subset, old committed policy, or neutral profile; failed/unprovable source or projection returns typed failure and no partial list. P4 requirement proof and P5 host tuple proof remain required. |
| P13/Web choice | Render the V6 candidate shape and, after affirmative selection, copy only that candidate's digest to existing P1 `expectedSandboxHandleBindingDigest`. Preserve OS-only registry pair, human-supplied matching NetworkPolicyV1 and separate TrustedLocal high-risk confirmation. Clear whole old read and selection after stale receipt, even when the refreshed candidate ID is identical. | No automatic choice/reuse/fallback; no candidate ID or candidate-only field enters P1. |
| V5 functional qualification | Update the V5 candidate/barrier, stale/reapproval, and dual-daemon scenarios so their expected candidate digests are per profile and from the current full P11 boundary/ownership snapshot. | Preserve all V5 zero-lease/zero-dispatch/zero-effect and one-decision recovery oracles. |

P1's existing profile-specific command CAS, payload/codec/key order,
fingerprint, receipt variants, committed decision/snapshot and transaction
linearization are unchanged. No schema, migration, authority grant, provider
qualification rule, ResourceBoundary widening, P4/P9 dispatch gate, or new
durable fact is included. The V6 adjustment must not change V5's full V2
bundle invalidation for both policy variants.

## 3. Failing-first DAG

```text
G0 owner landing + review + authorization gate
  → A domain canonical DTO/codec and independent digest vectors
  → B API/projection mirror and strict mutual exclusion
  → C P10/P11 same-barrier source + P4 producer reuse
  → D P13/Web selected candidate mapping + stale reselection
  → E V5 real-process dual-daemon adjustments
  → F candidate-specific and full authorized V5 gates
```

**G0 — integration gate.** Verify the V5 plan blob SHA and V5 authorization
record, the accepted V6 proposal SHA, `24307d68` DID/owner landing, and the
independent V6 B0/B1/B2 = 0 review. Once the V6 implementation token is
recorded, integrate the exact V6 design landing into the unified candidate
checkout before modifying code; inspect any conflict without rewriting owner
semantics. Do not treat the presence of design files in another branch as an
implementation token. Keep the V5-A baseline and its focused tests as the
starting evidence, not completion evidence.

**A — domain red then green.** First add a failing closed-codec test asserting
that a V6 candidate read has no common handle digest, each candidate requires
one lowercase 64-hex digest immediately after `candidateId`, and old
common-digest or mixed shapes reject. Add an independent P4/05 canonical
known-answer pair using `ws_v16_fixture`, mount `workspace`, boundary
revision 2 and the same FileTree target: RO and RW inner
`TargetIdentityDigestV1` and outer `SandboxHandleBindingDigestV1` preimages
and SHA-256 must each be fixed as golden values. With one owned mount,
ReadOnly digest differs from WorkspaceWrite/FullAccess; without a claim,
ReadOnly and WorkspaceWrite may coincide while FullAccess differs. Keep the
existing TrustedLocal `spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d`
ID golden unchanged across these source states. Implement only the V6 DTO
and codec after these tests fail for the intended reason.

**B — transport red then green.** Add failing API/projection tests for exact
candidate field placement and serialization order, authorized visibility,
strict rejection of old/mixed shapes and candidate/singular mutual exclusion.
Update the API/projection mirrors together; assert no mounts, target refs,
paths, claims, RecoveryBinding or provider diagnostics enter the response.

**C — query red then green.** Add an initial no-decision/P4-proven pending
action case with no committed policy snapshot. In one Workspace Detail read
barrier, all offered candidates must be derived from the same P11 complete
boundary and ownership facts, using the existing P4 producer for each
profile. Add claimed/unclaimed and multi-mount cases, including a stale
committed policy refresh that uses current facts rather than the old policy
digest. Exercise source corruption, collision, unprovable ownership-source evidence,
unprovable host tuple/authority source, and a failed P4 requirement proof:
each returns the existing typed failure/lag outcome without a partial list.
Force boundary/ownership drift across the barrier and prove either one
coherent old read or one coherent new read, never mixed candidate digests.
Use a public P11 read seam under the caller's `TransactionScope`; no P10
direct read of private P11/P4 tables.

**D — selection red then green.** Add a form/command mapping test that chooses
each available OS profile and TrustedLocal and sends only its digest in the
unchanged P1 field. Keep all V5 human choice, network mode/destination, and
TrustedLocal warning/confirmation tests. Change a claim or mount after read
so the selected digest changes while `candidateId` remains the same: P1
returns the existing durable `StaleSandboxPolicyInputs` with
`SandboxHandleBindingDigest`, writes no decision/event, and P13 discards the
entire old read. A manual refetch supplies the new digest and requires a new
selection. An ownership change that leaves the selected digest and all other
CAS inputs equal is not invented as an independent stale condition. Assert
same-CommandId receipt replay and no new P1 payload field/fingerprint input.

**E — process qualification.** Amend the V5 real SQLite two-daemon
restart/reapproval test: initial and stale candidate reads expose per-profile
digests; restart before reapproval keeps the exact P3 Action Pending,
invocation NotAdmitted, RecoveryBinding unchanged, lease/worker/provider/
effect/Observation counts zero, and no new marker/Attention. Old selected
digest is rejected; a human refetches and reselects even if the ID is stable.
After the existing P1 command commits, kill/restart the other daemon and
prove one current decision, one resumed admission at most, no duplicate
command/event/decision, and no automatic provider call caused merely by a
read or approval. Include an owned-versus-unowned mount transition and the
V5 registry-only full-bundle drift path for TrustedLocal and OsEnforced.

**F — exit.** Run the affected domain, API, P10 query, P13/Web, P1 gateway,
P4/P2 admission and dual-daemon suites; `pnpm check`; then the V5 plan's
functional/restart gate on a disposable migrated database. Verify the exact
diff contains only implementation and test files within this authorized
candidate-read seam and the remaining authorized V5 slices. Record failures
and repairs without broadening a focused result into full release evidence.
Only the V5 plan's own final closure criteria can close the whole V5 feature.

## 4. Independent planning self-review

- The addendum changes the candidate DTO placement and selected-value flow,
  while preserving the singular V21 read shape and all P1 wire/persistence
  contracts.
- The canonical RO/RW counterexample is tested without relying on a
  committed initial policy or on candidate ID as CAS.
- The P10/P11 seam requires one source snapshot and existing P4 producer;
  every proof failure is all-or-nothing.
- Stale refetch requires an affirmative new selection even when the
  presentation ID is unchanged; the two-daemon case preserves V5's
  zero-side-effect and single-convergence oracles.
- This document is planning-only. V6 implementation starts only after its
  separate token; design files and production code are outside this commit.

## 5. Authorization record

If the manual governor authorizes this exact addendum, record its Git-blob
raw SHA-256 and the following token before beginning slice A:

```text
AUTHORIZE_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6_IMPLEMENTATION
```

The authorization is limited to this V6 delta layered on the already
authorized V5 v2 plan. A newly found semantic contradiction stops at its
own Design Gap rather than being resolved by implementation code.
