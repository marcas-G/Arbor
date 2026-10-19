# Sandbox Policy Candidate Profile Binding Digest — Fixed Proposal V6

**Status:** FIXED PROPOSAL — awaiting manual governance decision; planning-only
**Date:** 2026-10-19
**Supersedes:** only the V5 placement of `sandboxHandleBindingDigest` in candidate-read `commonPreconditions` and its dependent candidate-to-command wording
**Suggested decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6`
**Design owners on acceptance:** P4 `05`, P10 `05`, P13 `03`/`06`, P1 `01` cross-reference only

## 1. Design Gap and counterexample

Accepted V5 adds a candidate read before the human has committed a policy.
Its `commonPreconditions` contain one `sandboxHandleBindingDigest`. P4 `05`
defines `SandboxHandleBindingDigestV1` over sorted mounts whose rows include
`access`; each `TargetIdentityDigestV1` also includes `access`. The accepted
full-boundary producer maps `ReadOnly` to all `ReadOnly` mounts,
`WorkspaceWrite` to `ReadWrite` only where the Workspace has an active exact
ownership claim, and `FullAccess` to logical `ReadWrite` mounts without an OS
isolation claim. Thus one current Workspace/boundary/ownership snapshot can
produce distinct digests for the offered profiles. Before the first decision,
there is no committed policy snapshot from which to take a neutral digest.

Concrete minimal counterexample: one current filesystem mount, exact active
ownership claim, identical Workspace and ResourceBoundary revisions. Its
`ReadOnly` candidate has `access=ReadOnly`; the `WorkspaceWrite` and
`TrustedLocalUnconfinedV1` candidates have `access=ReadWrite`. The inner target
identity and outer handle binding canonical bytes differ. A single common
digest cannot be the exact P1 `expectedSandboxHandleBindingDigest` for both
access projections. With no claim, `WorkspaceWrite` may equal `ReadOnly`,
while `FullAccess` differs; equality in one state does not make the field
profile-independent. An arbitrary common value would make at least one valid
choice fail its own CAS or would weaken the existing command check.

The evidence is a contract contradiction, not a request to change digest
algorithms or add persistence. Stop the affected implementation at this seam
until manual governance accepts an exact repair. No `docs/design/**` edit or
implementation is authorized by this proposal itself.

## 2. Fixed semantic decision

Move exactly the existing `sandboxHandleBindingDigest: Sha256` from
`SandboxPolicyCandidateReadV1.commonPreconditions` to **each** closed
`SandboxPolicyCandidateV1` variant. For every candidate, P10 projects the
complete current P11 ResourceBoundary and exact active Workspace
ResourceOwnership through the existing P4 `05` profile-specific producer,
using the candidate's profile and one coherent read barrier. The digest is
the existing `SandboxHandleBindingDigestV1` of that projection. A candidate
may share a digest with another candidate when their exact derived mounts and
access coincide; uniqueness is neither required nor inferred.

The fixed public shape is the V5 DTO with only this relocation:

```ts
type SandboxPolicyCandidateReadV1 = {
  readonly reason: "InitialDecision" | "RefreshStaleCommittedPolicy";
  readonly commonPreconditions: {
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly episodeBinding: ExecutionEpisodeBinding;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: Sha256;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: Sha256;
  };
  readonly candidates: ReadonlyArray<
    | {
        readonly kind: "OsEnforced";
        readonly candidateId: string;
        readonly sandboxHandleBindingDigest: Sha256;
        readonly providerId: string;
        readonly providerVersion: string;
        readonly profile: "ReadOnly" | "WorkspaceWrite";
        readonly networkMode: "Disabled" | "Restricted" | "Enabled";
        readonly providerRegistryRevision: number;
        readonly providerRegistryDigest: Sha256;
      }
    | {
        readonly kind: "TrustedLocalUnconfinedV1";
        readonly candidateId: string;
        readonly sandboxHandleBindingDigest: Sha256; // FullAccess projection
      }
  >;
};
```

The exact serialized key order is V5 order with the common digest removed and
the candidate digest immediately after `candidateId` in each variant.
`Sha256` remains lowercase 64-hex. The digest is a safe opaque CAS value in
this authorized human-only candidate view, not a disclosure of mounts, target
refs, paths, claims, or ownership regions. Existing public SandboxPolicy
summary, receipt, and Attention redaction remain unchanged.

P10 derives each offered profile projection from the same current P11 boundary,
ownership, Workspace identity/revisions and freshness barrier used for the
candidate read. It uses the exact P4 `05` canonical producer and does not
derive from the pending tool target, a caller subset, an old committed policy,
or a synthesized profile-neutral handle. The P11 read seam must provide the
complete current boundary and exact active ownership facts to that producer
under P10's existing read transaction; P10 must not open P11/P4 private stores
or acquire a second inconsistent snapshot. A missing, corrupt, ambiguous or
unprovable full-boundary/ownership projection is a typed read failure with no
partial candidate list. P4's read-only requirement proof and P5's validated
authority/host tuple snapshot remain independent requirements of that same
coherent response.

## 3. Selection, currentness and candidate identity

After an affirmative human selection, P13 copies the common fields and **only
the selected candidate's** `sandboxHandleBindingDigest` to the existing P1
`expectedSandboxHandleBindingDigest`. It copies the selected OsEnforced
registry pair only for OsEnforced; TrustedLocal remains the explicit
`FullAccess`/`Unconfined` branch with separate confirmation and no provider
registry branch fields. Existing network-policy matching and all other P1
payload mappings are V5. P1 recomputes the current full-boundary,
ownership-and-profile digest for the submitted variant and checks its existing
CAS. No P1 wire field, codec, command fingerprint, rejection variant, event,
SQL table, migration, or committed snapshot field changes.

`candidateId` remains the V5 `spc2_` presentation identity of variant and
provider/profile/network/registry tuple. The digest is deliberately **not**
added to the ID preimage: boundary or ownership drift can change the CAS while
the displayed option's identity stays the same. P1 never receives an ID.
Candidate order, exact duplicate collapse and conflicting-mapping failure
retain V5 rules; digest relocation cannot deduplicate two distinct V5 tuple
identities or reorder the list. TrustedLocal remains exactly once and last.

If an existing CAS basis changes after a read, P1's existing
`StaleSandboxPolicyInputs` durable receipt rejects the old submission without
committing a policy. A mount/ownership change that alters the selected
profile's projection uses the existing `SandboxHandleBindingDigest` stale
field; existing revision fields remain authoritative where they changed.
An ownership change that leaves the selected profile's digest and all other
CAS inputs equal does not independently create a new precondition. P13
discards the entire old candidate read after a stale receipt, waits for
existing invalidation or explicit refetch, and requires a fresh human choice,
even if `candidateId` is unchanged. There is no implicit reuse, automatic
submit, or fallback to TrustedLocal.

For a stale committed policy, P10 still reports V5 `NeedsDecision` only with
the exact pending requirement and returns a refreshed candidate set. Every
candidate digest is newly derived from the **current** complete boundary and
ownership snapshot, not the stale policy's stored handle digest. V5
full-authority-bundle currentness for both variants, P4/P9 execution gates,
and read-only ephemeral candidate semantics remain intact.

## 4. Owning-document landing package

| Owner | Exact accepted landing |
|---|---|
| P4 `05` | State explicitly that profile-specific current full-boundary/ownership projection produces the handle digest at initial and refresh candidate reads; preserve the existing access map and `SandboxHandleBindingDigestV1` codec. |
| P10 `05` | Replace the V5 DTO and surrounding common-handle wording with the closed shape above; require same-barrier P11 full-boundary/ownership inputs, one digest per offered candidate, typed all-or-nothing failure, and unchanged sort/ID/redaction. |
| P13 `03`/`06` | Copy the selected candidate digest to the existing P1 expected field; require whole-list refresh and deliberate reselection after stale receipt, including unchanged IDs. |
| P1 `01` | Cross-reference the selected-candidate mapping and existing profile-specific CAS; keep all command wire and persistence contracts unchanged. |

Only manual governance may land these edits after accepting this exact
proposal. Preserve the remaining V5 contracts, including the P4 requirement
port, full V2 bundle invalidation, provider tuple qualification, and
TrustedLocal safety presentation. Do not replace the singular legacy V21
`sandboxPolicyPreconditions` union outside the candidate-read case; it is a
different read shape and continues to carry its existing digest.

## 5. Required failing-first and acceptance evidence

After acceptance and implementation authorization, prove these before
claiming candidate-read closure:

1. **Counterexample first:** an initial no-decision, exact pending P4/P3
   requirement and one owned filesystem mount yields ReadOnly RO and
   WorkspaceWrite/FullAccess RW canonical mount projections. The read fails
   under old common-digest assumptions, then returns each candidate's exact
   independently computed P4 `SandboxHandleBindingDigestV1`; no committed
   policy snapshot exists. Include a no-claim fixture where WorkspaceWrite
   and ReadOnly may share a digest while FullAccess differs.
2. **Golden bytes:** fix canonical inner target-identity and outer handle
   preimages and expected lowercase SHA-256 for RO and RW access using the
   existing P4 `05` FileTree vector basis (`ws_v16_fixture`, mount
   `workspace`, boundary revision 2). Independently recompute from the
   frozen codec, assert RO != RW, and assert WorkspaceWrite equals the
   expected access projection for both claimed and unclaimed states. Keep
   the V5 TrustedLocal `spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d`
   candidate-ID golden unchanged across both digest states.
3. **P10/P11 seam:** one read transaction and freshness barrier supplies the
   complete current P11 boundary and active ownership used for all candidate
   digests; concurrent boundary/ownership revision drift yields existing
   lag/stale behavior or a coherent new read, never mixed candidates. Invalid
   or unavailable source, collision, or failed P4 requirement/host tuple
   proof yields a typed failure and no partial list. P10 has no private-store
   access.
4. **Selection and CAS:** P13 sends exactly the selected digest in the
   unchanged P1 field; both OS profiles and TrustedLocal commit with their
   own current digest. A changed ownership/access basis after read returns
   existing `StaleSandboxPolicyInputs`, no policy/event write, then a refetch
   with the same `candidateId` but new digest requires deliberate reselection.
   Same-CommandId replay remains the same durable receipt.
5. **Presentation and regression:** IDs/order/dedup stay V5; no mount,
   target ref, host path, claim or provider diagnostic leaks. TrustedLocal is
   labelled unconfined/high risk and never selected automatically. Full V2
   bundle drift and restart/reapproval cases from V5 remain green; no new
   endpoint, P1 command field, persisted fact, or migration appears.

## 6. Decision and audit

Manual governor acceptance of this exact file should record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_PROFILE_BINDING_DIGEST_V6
```

Record the accepted file's raw SHA-256, decision record, owning-document
revisions, and an independent post-landing consistency review with Blocking =
0 before resuming implementation at this seam. Acceptance authorizes only
that exact design landing package; implementation authorization remains a
separate decision.
