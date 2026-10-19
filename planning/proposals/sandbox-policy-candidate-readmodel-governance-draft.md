# Sandbox Policy Candidate Read Model — B0 (Superseded)

**Status:** SUPERSEDED — historical draft; do not accept or implement
**Replaced by:** `sandbox-policy-candidate-readmodel-governance-v2.md`
**Former decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL` — invalid
for current governance
**Scope:** Close the first-decision presentation gap found in Wave D after the
accepted Native Sandbox V21 and Producer Mapping Closure V3 contracts.

> This B0 draft failed independent review (B0=0, B1=3, B2=2). In particular,
> its CAS fields did not match the existing V21/P1 preconditions, it exposed
> internal invocation/interruption identities, and its candidate fields did
> not match the V3/P1 tuple. The fixed replacement is V2. This file is retained
> only as audit history; do not use its DTO, semantics, or token.

## 1. Decision requested

When a Workspace has no committed `SandboxPolicyDecision` and has the exact
pending P4 invocation interrupted by `SandboxPolicyRequiredInterruption`,
extend the existing P10 `WorkspaceDetail` read with a closed list of choices
derived from one consistent read barrier. Return the shared compare-and-set
(CAS) basis beside the candidates. A human explicitly selects one candidate;
the read never chooses, grants, or commits a policy. P1 continues to accept the
existing wire variants and is the only decision writer. It rechecks the CAS,
authority, and selected provider against current facts before committing.

This is the smallest read-contract closure for the observed gap: the current
`WorkspaceDetailReq = { workspaceId}` has only
`sandboxPolicyPreconditions`, which cannot represent several supported
`OsEnforced` tuples alongside `TrustedLocalUnconfined` without silently
choosing one.

## 2. Accepted contracts and bounds

This proposal takes the following as fixed inputs and does not reopen them:

- Native Sandbox V21: P4 `06` owns `SandboxPolicyRequiredInterruption`; the
  exact interrupted invocation remains the recovery target.
- P10 `05` V21: `WorkspaceDetailReq = { workspaceId }` is the existing
  transport-neutral view request and keeps its existing freshness/barrier
  semantics.
- P1 `01`: the human decision uses the existing closed wire variants
  `OsEnforced` and `TrustedLocalUnconfined`; `OsEnforced` carries the required
  registry precondition; the trusted-local variant carries no registry data.
- Producer Mapping Closure V3: only supported provider/profile/network tuples
  are eligible for the `OsEnforced` projection. The accepted mapping remains
  the source of truth; this proposal does not add a provider or profile.
- P13 `03`/`06`: neither variant may be automatically selected or submitted.

The proposal does not change the P4 interruption, P1 command variants or
authority rules, SandboxPolicyDecision persistence, provider mapping, profile
semantics, or Work/Execution lifecycle.

## 3. Additive P10 DTO

Add one optional field to the existing Workspace Detail response:

```ts
type SandboxPolicyChoiceView = {
  readonly status: "Ready" | "NoEligibleCandidates";
  readonly cas: {
    readonly workspaceId: WorkspaceId;
    readonly workspaceRevision: Revision;
    readonly resourceBoundaryRevision: Revision;
    readonly invocationId: ToolInvocationId;
    readonly interruptionId: string; // exact P4 SandboxPolicyRequiredInterruption identity
    readonly registryRevision: string;
    readonly registryDigest: string; // canonical digest, not a bearer token
  };
  readonly candidates: ReadonlyArray<SandboxPolicyCandidate>;
};

type SandboxPolicyCandidate =
  | {
      readonly _tag: "OsEnforced";
      readonly candidateId: string; // deterministic opaque identity for this exact tuple
      readonly provider: {
        readonly id: string;
        readonly displayName: string;
        readonly version: string;
      };
      readonly profile: {
        readonly ref: string;
        readonly version: string;
        readonly displayName: string;
      };
      readonly network: "Disabled" | "Restricted" | "Enabled";
      readonly registryRevision: string;
      readonly registryDigest: string;
    }
  | {
      readonly _tag: "TrustedLocalUnconfined";
      readonly candidateId: "trusted-local-unconfined";
    };

type WorkspaceDetailRes = ExistingWorkspaceDetailRes & {
  readonly sandboxPolicyChoice?: SandboxPolicyChoiceView;
};
```

`candidateId` is a presentation identity derived from the canonical variant
and exact tuple. It is not an authorization, capability, approval, or P1
payload replacement. The human submits the exact existing P1 wire variant,
including its registry precondition for `OsEnforced`; P1 does not trust
`candidateId` as proof.

The registry revision/digest in the shared CAS binds the candidate list to the
snapshot used to establish that the list is complete. It does not add a
registry precondition to `TrustedLocalUnconfined`; that candidate and its P1
wire variant contain no registry data.

The field is present only when all of these facts hold in the same read
snapshot: the Workspace exists and is in the queried authority scope; it has
no committed SandboxPolicyDecision; the exact P4 invocation is pending; and
that invocation has the matching `SandboxPolicyRequiredInterruption`. When
these conditions do not hold, the field is absent. The detail response and
candidate list are read-only.

### 3.1 Shared CAS and read barrier

`cas` is shared by every candidate in the response. It binds the exact
Workspace revision, resource-boundary revision, P4 invocation and interruption,
and the provider registry snapshot. All fields are obtained under one
consistent database read snapshot and the existing P10 query freshness
barrier. The outer P10 `QueryResult` watermark/lag remains authoritative for
journal freshness; it is not replaced by the registry revision.

The returned bindings are the complete shared read-side CAS basis for this
choice. The human submission continues to use the existing P1 wire variant;
P1 compares its existing precondition fields and the current canonical
Workspace, boundary, pending invocation/interruption, and provider registry
facts against this exact basis before commit. No candidate ID or new wire
field is required.

## 4. Candidate construction

1. Build `OsEnforced` candidates only by projecting tuples that Producer
   Mapping Closure V3 marks Supported for the current invocation's applicable
   resource/provider constraints. Include only the provider, profile, network,
   and registry identity fields shown in §3. Do not infer support from a
   provider name, family, default profile, or successful prior decision.
2. Include exactly one `TrustedLocalUnconfined` candidate, without any
   registry revision, digest, provider, profile, or network field. This is a
   human choice only; it is never a default, fallback, or automatic retry.
3. Sort `OsEnforced` candidates by ordinal `(provider.id, provider.version,
   profile.ref, profile.version, network)` and place the trusted-local
   candidate last. Deduplicate only identical canonical tuples; if one tuple
   maps to conflicting metadata, fail the view as an integrity error instead
   of choosing a row.
4. `candidateId` is a stable digest of the canonical variant and tuple under a
   versioned canonical encoding. It is stable for identical inputs and has no
   authority meaning.
5. If the registry is valid but contains no supported OS tuple, return the
   trusted-local candidate only and `status: "Ready"`. If the registry cannot
   be read or validated, return a typed query failure; do not turn that failure
   into an apparently empty registry or TrustedLocal fallback.
6. If the exact P4 invocation or interruption no longer matches, or a decision
   appears during the read, return the existing typed stale/conflict outcome
   (or omit the conditional field only when the same snapshot proves the
   interruption has already settled). Never return candidates assembled from
   different snapshots.

## 5. Redaction and UI behavior

The projection is path-free and secret-free. It must not return host paths,
mount paths, environment variables, credentials, raw registry configuration,
process arguments, raw provider errors, or filesystem diagnostics. Display
names and opaque provider/profile identifiers are returned only when the V3
mapping explicitly classifies them as safe display fields. Registry revision
and digest are opaque comparison values, not registry contents.

P13 presents the candidates as an explicit human choice. It does not preselect
one, submit on page load, interpret a timeout as consent, or replace an
unavailable `OsEnforced` choice with `TrustedLocalUnconfined`. Submission uses
the existing P1 command and exact selected variant. The view may explain that
an empty supported OS set leaves only the trusted-local option; the user must
still select it deliberately.

## 6. Stale, error, and Attention relationship

- A P10 freshness-barrier miss follows the existing typed stale-query behavior
  in P10 `03`/`05`; it does not return a partial candidate list.
- A changed workspace revision, boundary revision, invocation/interruption
  identity, or provider registry snapshot invalidates the displayed CAS. P1
  rejects a stale submit using its existing typed conflict/rejection contract;
  the client rereads Workspace Detail and requires a fresh human choice.
- Registry unavailable, invalid registry digest, conflicting duplicate
  metadata, or inconsistent snapshot is a typed query failure with no raw
  details. It is not an empty candidate list and does not settle the P4
  invocation.
- `NoEligibleCandidates` is reserved for a valid, consistent snapshot where
  the frozen policy makes even the trusted-local variant ineligible. In that
  case `candidates` is empty and the exact P4 interruption remains pending.
  (With the current V21 choice contract, a valid registry with zero OS tuples
  still has the explicit TrustedLocal candidate and is `Ready`.)
- Candidate availability adds no Attention source, severity, status, or
  governance action. The existing P4 interruption retains its existing
  ActionRequired/Attention presentation and exact target. A pending choice
  does not change Workspace lifecycle/status or P5 current-work selection.

## 7. Ownership and implementation seam

| Owner | Responsibility under this proposal |
|---|---|
| P4 `06` | Owns the exact `SandboxPolicyRequiredInterruption` and pending invocation identity; no new interruption or settlement semantics. |
| P10 `05` (with `03` freshness) | Owns the additive Workspace Detail DTO, consistent read snapshot, CAS projection, candidate redaction, typed stale/error result. |
| Producer Mapping V3 owner | Supplies the existing Supported tuple set and its registry revision/digest; no mapping expansion. |
| P13 `03`/`06` | Owns explicit rendering and human selection; never auto-selects, auto-submits, or converts unavailable OS choice to trusted-local. |
| P1 `01` | Owns the existing decision command, authority, wire variant, exact CAS/provider recheck, and durable decision. |
| P5 | Continues to gate execution dispatch on the canonical P1 decision; it does not choose a candidate or derive a policy. |

P10 remains a read model and cannot write `SandboxPolicyDecision`, mutate
provider state, settle the invocation, or authorize execution. P13 uses the
existing route and command surface. No new route, command type, approval type,
table, column, event, or migration is introduced.

## 8. TDD and acceptance evidence required after acceptance

The implementation plan must add focused failing tests before implementation,
then demonstrate:

1. Exact pending P4 invocation and no decision produce the candidate view under
   one snapshot; no matching interruption, settled invocation, or existing
   decision omits it.
2. Several Supported OS tuples project in deterministic order, duplicates
   collapse only when canonical tuples and metadata agree, and an integrity
   conflict fails closed.
3. A valid empty OS registry returns the single TrustedLocal candidate with no
   registry fields; an invalid/unavailable registry returns typed failure and
   never silently falls back.
4. All projected values are path/secret-free, including error paths and
   candidate identifiers.
5. Workspace/boundary/invocation/interruption/registry changes between read
   and P1 submission cause stale rejection; an unchanged exact choice commits
   through P1 only after authority and provider revalidation.
6. Concurrent selections cannot commit two decisions or resume two different
   policy branches; the exact P4 invocation is resumed only through the
   existing P1/P4 contract.
7. P13 has no automatic selection or submission, while P5 dispatch remains
   blocked until the canonical P1 decision exists.
8. Existing P4 interruption Attention and Workspace status remain stable while
   the candidate view is read, stale, empty, or failed.

No implementation authorization is requested by this draft. Acceptance would
authorize only the owning-contract landing package, subject to the repository
governance process; implementation still requires the explicit phase
authorization applicable to P10/P13/P1/P5.

## 9. Acceptance

If the exact read-model and ownership contract is accepted, record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL
```

The accepted proposal hash, decision record, owning-document revisions, and
post-landing consistency review must be recorded before implementation begins.
