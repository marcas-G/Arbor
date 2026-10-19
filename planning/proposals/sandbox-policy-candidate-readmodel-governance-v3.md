# Sandbox Policy Candidate Read Model — V3 (Superseded)

**Status:** SUPERSEDED — historical fixed draft; do not accept or implement
**Replaced by:** `sandbox-policy-candidate-readmodel-governance-v4.md`
**Former decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V3` — invalid
for current governance
**Scope:** Close initial-choice and stale-policy refresh presentation under
the accepted Native Sandbox V21 and Producer Mapping Closure V3 contracts.

> V3 failed independent review (B1=2). Its committed TrustedLocal
> currentness wording and P4 requirement-read boundary are superseded by V4.
> Retained as audit history only; do not use its semantics or token.

## 1. Decision

Add an optional candidate read to P10 `WorkspaceDetail` for (a) the initial
policy decision required by the exact P4 V21 interruption, and (b) refreshing
a committed decision that the existing V21 predicate marks stale. It returns
the complete V21 common policy preconditions once, plus a closed list of
currently applicable candidates. Each OS candidate carries the exact
V21/V3 provider-registry revision and digest needed to construct the existing
`OsEnforced` precondition. The `TrustedLocalUnconfinedV1` candidate carries no
provider-registry branch precondition.

`authorityBundleRevision` and `authorityBundleDigest` bind the full validated
V2 authority bundle, including its provider registry. A change anywhere in
that bundle makes the complete read/common preconditions stale, including for
a displayed trusted-local choice. After refresh, trusted-local remains
selectable and still has no provider-registry branch precondition. This
refresh rule follows from the common authority-bundle CAS; it does not make
TrustedLocal depend on an OS provider.

The read never selects, grants, commits, or resumes policy. P13 requires a
deliberate human choice. P1 remains the only decision writer and applies the
existing V21 command codec and final precondition/authority checks.

## 2. Exact V21 fields and existing P1 wire mapping

The P10 response's existing `sandboxPolicyPreconditions` is the V21
`SandboxPolicyPreconditionsV1` discriminated union. Its common fields, in the
existing exact order and spelling, are:

```text
expectedEpisodeRevision
latestCommittedPolicyRevision
episodeBinding
workspaceRevision
resourceBoundaryRevision
sandboxHandleBindingDigest
authorityBundleRevision
authorityBundleDigest
operatorConfigRevision
operatorConfigDigest
```

The P10 OS branch adds exactly `providerRegistryRevision` and
`providerRegistryDigest`; its trusted-local branch has `kind:
"TrustedLocalUnconfinedV1"` and no registry fields. The P1 command payload
uses its distinct, already-frozen `expected...` spellings. P13 maps the read
preconditions into the existing P1 payload as follows; these are mappings,
not new aliases or wire fields:

| P10 `SandboxPolicyPreconditionsV1` read field | Existing P1 payload field |
|---|---|
| `expectedEpisodeRevision` | `expectedEpisodeRevision` |
| `latestCommittedPolicyRevision` | `expectedPolicyRevision` |
| `episodeBinding` | `episodeBinding` |
| `workspaceRevision` | `expectedWorkspaceRevision` |
| `resourceBoundaryRevision` | `expectedResourceBoundaryRevision` |
| `sandboxHandleBindingDigest` | `expectedSandboxHandleBindingDigest` |
| `authorityBundleRevision` | `expectedAuthorityBundleRevision` |
| `authorityBundleDigest` | `expectedAuthorityBundleDigest` |
| `operatorConfigRevision` | `expectedOperatorConfigRevision` |
| `operatorConfigDigest` | `expectedOperatorConfigDigest` |
| OS-only `providerRegistryRevision` | OS-only `expectedProviderRegistryRevision` |
| OS-only `providerRegistryDigest` | OS-only `expectedProviderRegistryDigest` |

The accepted P1 payload continues to contain the exact canonical
`episodeBinding`, `profile`, `providerId`, `networkPolicy`, and decision
expiry fields already required by its selected variant. An OS candidate's
`networkMode` is the V3 supported tuple selector; the projection does not
invent network destinations. The human supplies the existing P1
`networkPolicy` whose mode matches that tuple. Trusted local uses the exact
existing `TrustedLocalUnconfinedV1` command encoding and has no provider
registry fields.

## 3. Additive P10 DTO and selection assembly

The current singular `sandboxPolicyPreconditions` can describe only one
variant. When the new candidate view is present, P10 omits that singular
field so it does not appear to select a branch. Instead, it returns one
shared common object using the exact V21 common field names above, without
`kind` or provider-registry fields, and the candidate list:

```ts
type SandboxPolicyCandidateReadV1 = {
  readonly reason: "InitialDecision" | "RefreshStaleCommittedPolicy";
  readonly commonPreconditions: {
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly episodeBinding: ExecutionEpisodeBinding;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly sandboxHandleBindingDigest: Sha256;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: Sha256;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: Sha256;
  };
  readonly candidates: ReadonlyArray<SandboxPolicyCandidateV1>;
};

type SandboxPolicyCandidateV1 =
  | {
      readonly kind: "OsEnforced";
      readonly candidateId: string; // always spc2_<lowercase-sha256>
      readonly providerId: string;
      readonly providerVersion: string;
      readonly profile: "ReadOnly" | "WorkspaceWrite";
      readonly networkMode: "Disabled" | "Restricted" | "Enabled";
      readonly providerRegistryRevision: number; // positive safe integer
      readonly providerRegistryDigest: Sha256;
    }
  | {
      readonly kind: "TrustedLocalUnconfinedV1";
      readonly candidateId: string; // same spc2_<lowercase-sha256> form
    };

type WorkspaceDetailRes = Omit<
  ExistingWorkspaceDetailRes,
  "sandboxPolicyPreconditions"
> & {
  readonly sandboxPolicyPreconditions?: SandboxPolicyPreconditionsV1; // absent when sandboxPolicyCandidateRead is present
  readonly sandboxPolicyCandidateRead?: SandboxPolicyCandidateReadV1;
};
```

This DTO is only a P10 read addition; it changes no P1 command field or
codec. P13 combines `commonPreconditions` with the selected candidate's
existing branch fields to construct a canonical `SandboxPolicyPreconditionsV1`
and the existing P1 wire payload. For OS, the P10 registry pair maps to the
P1 `expectedProviderRegistryRevision` / `expectedProviderRegistryDigest`.
For trusted-local, P13 constructs the exact trusted-local V1 variant and
omits both registry fields. No `candidateId` is submitted to P1.

The common object must contain and validate every V21 field listed in §2.
Revisions use the exact V21 range rules: episode, latest policy, Workspace,
and boundary revisions are nonnegative safe integers; authority-bundle and
operator-config revisions are positive safe integers; all digests are
lowercase 64-hex SHA-256. No environment revision, invocation ID,
interruption ID, handle path, or new CAS alias is returned.

## 4. Validated snapshot and read barrier ownership

P5 supplies P10 only a fully validated immutable `SandboxAuthorityBundleV2`
snapshot from its accepted protected-source/high-water loader. The snapshot
must pass the V3 exact codec, source identity, full-bundle digest, child
revision/digest consistency, monotone high-water, and integrity checks. P5
does not derive candidate selection, apply Workspace rules, or own execution
dispatch.

P10 takes that one P5 snapshot and reads Workspace, ResourceBoundary,
Execution/Episode, sandbox-handle binding, current policy/decision revision,
authority/operator preconditions, and P4's explicit policy-required read fact
under one consistent canonical read transaction/barrier. The P10 response
uses the existing `WorkspaceDetail` freshness watermark/lag and typed barrier
behavior. The P5 snapshot is immutable and versioned; the response does not
pretend its bundle revision is a journal watermark or that P5 and the P10
database share a transaction.

The shared `authorityBundleRevision` / `authorityBundleDigest` are from the
full validated V2 bundle. Because the full-bundle digest covers issuer,
operator, and provider-registry subobjects, any accepted registry update
changes the common bundle binding. P1's existing `expectedAuthorityBundleRevision`
and `expectedAuthorityBundleDigest` then reject a command constructed from
the old candidate read for either variant. P1 also checks the OS-only
registry revision/digest when the selected variant is `OsEnforced`.

P5 only provides a validated snapshot. Execution dispatch remains blocked
under the existing P2/P4/P9 contracts until P1 has committed a valid policy
decision and the existing consumers have applied it. This proposal gives P5
no new dispatch or blocking responsibility.

## 5. Host tuple qualification and Workspace filtering

The V3 provider qualification is for an exact host tuple only:

```text
providerId, providerVersion, capabilityRevision, osFamily, osBuild,
profile, networkMode, networkPolicyCodecVersion, enforcementRuleSetDigest
```

P5's validated current-host snapshot yields only entries with status
`Supported` for the exact running host/provider capability/build. Provider
qualification does not assert that a tuple is appropriate for a particular
Workspace and does not produce a Workspace-specific candidate.

P10 owns the Workspace applicability filter. It uses the same snapshot as
`commonPreconditions`: exact active visible Execution/Episode, canonical
`episodeBinding`, current Workspace revision and ResourceBoundary revision,
and the existing `sandboxHandleBindingDigest`/P1 eligibility rules. It
intersects those applicable Workspace facts with P5's exact host `Supported`
tuple set. P10 must not relabel a provider tuple Supported/Unsupported or
repeat T3 qualification. No extra path, host details, display name, profile
ref/version, build identifier, qualification artifact ref, or raw provider
diagnostic is returned.

Within a successful read, each exact applicable Supported host tuple maps to
exactly one `OsEnforced` candidate. Duplicate identical entries collapse to
one candidate only when every V3 tuple and revision/digest field is identical;
conflicting duplicates or ambiguous tuple mappings fail the read as an
integrity error. P10 always adds exactly one `TrustedLocalUnconfinedV1`
candidate to a successful view.

## 6. Candidate order and `candidateId`

Order OS candidates by unsigned UTF-8 bytewise tuple
`(providerId, providerVersion, profile, networkMode,
providerRegistryRevision, providerRegistryDigest)`. Strings are compared as
their exact UTF-8 bytes with no Unicode normalization. Place the one trusted
candidate last. The tuple encoding is also the identity basis; source
iteration order has no effect.

Every candidate ID, including TrustedLocal, has exactly the form
`spc2_<64 lowercase hex characters>`. Hash bytes are:

```text
SHA-256(
  UTF8("arbor:sandbox-policy-candidate:v2\0")
  || variantByte
  || ordered length-prefixed UTF-8 fields
)
```

`variantByte` is `0x01` for `OsEnforced` and `0x02` for
`TrustedLocalUnconfinedV1`. Each string is `u32be(UTF8 byte length) || UTF8
bytes`; the OS registry revision is its canonical positive base-10 ASCII
string encoded by the same length-prefix rule. OS fields are encoded in this
order:

```text
providerId, providerVersion, profile, networkMode,
providerRegistryRevision, providerRegistryDigest
```

TrustedLocal has no fields after its variant byte. Golden vector:

```text
variant:       TrustedLocalUnconfinedV1
variant byte:  02
preimage hex:  6172626f723a73616e64626f782d706f6c6963792d63616e6469646174653a76320002
candidateId:   spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d
```

The preimage is the exact UTF-8 bytes of
`arbor:sandbox-policy-candidate:v2`, one NUL byte, then `0x02`. Candidate IDs
are presentation identities only; they neither carry authority nor replace
P1's exact variant, CAS, or provider checks.

## 7. Empty registry, load failure, stale, and refresh behavior

- **Validated bundle, exact tuple enumeration succeeds, current host has no
  `Supported` OS tuples:** return a successful read containing exactly the
  TrustedLocal candidate. This includes a valid empty provider registry and
  valid registries whose entries do not qualify the exact current host.
- **Authority bundle/high-water load, validation, integrity, or authority
  failure:** return the existing typed failure and no candidate read at all;
  do not fall back to TrustedLocal.
- **Host identity/capability/build tuple enumeration fails or its snapshot
  cannot be proved:** return a typed failure and no candidate read at all.
  Never translate tuple-enumeration failure to an empty supported set.
- **Any bundle change after a successful read, including provider-registry
  revision/digest change:** the full common authority-bundle precondition is
  stale for both variants. P1 rejects either old selection under its existing
  stale-input path. P13 rereads the view. The refreshed view may again contain
  TrustedLocal without registry fields; this is not an OS-provider dependency.
- **Workspace/common-precondition drift:** both variants require a fresh
  view. P1 rechecks the exact existing `expectedEpisodeRevision`,
  `expectedPolicyRevision`, `expectedWorkspaceRevision`,
  `expectedResourceBoundaryRevision`, `expectedSandboxHandleBindingDigest`,
  `expectedAuthorityBundleRevision`/digest, and
  `expectedOperatorConfigRevision`/digest; an OS choice additionally carries
  and checks its exact provider registry pair.
- **Initial decision:** return the view only when the same canonical snapshot
  has no current decision and the exact pending P4
  `SandboxPolicyRequiredInterruption` applies to the current active visible
  Execution/Episode.
- **Stale committed policy refresh:** return the same view with
  `reason: "RefreshStaleCommittedPolicy"` only when the existing V21
  `sandboxPolicy.status = NeedsDecision` / P1 stale predicate establishes that
  the committed decision is stale. Bind the common object to the exact
  `latestCommittedPolicyRevision`; do not infer policy staleness from a
  registry update in P10. A changed full bundle still makes that read stale
  and requires refetch before either variant.

Candidate display adds no Attention source, status, authorization, or
canonical mutation. Existing P4/P9 Attention and Workspace status remain the
source of truth. The view does not change P5 dispatch selection or Work
lifecycle.

## 8. Owners and implementation boundaries

| Owner | Responsibility |
|---|---|
| P4 `06` V21 | Supplies the exact policy-required interruption/read fact; its invocation and interruption identities remain internal eligibility inputs, not candidate fields or P1 CAS. |
| P5 `01` plus accepted V3 authority loader | Supplies one fully validated immutable full V2 bundle and exact current-host Supported tuple snapshot, or the existing typed load failure. No Workspace filtering or execution dispatch. |
| P10 `05` / existing status read port | Owns the additive candidate DTO, common field projection, canonical read barrier, Workspace applicability filtering, freshness and redaction. No P4 private-store access or decision writes. |
| Producer Mapping Closure V3 owner | Owns provider tuple qualification and exact registry mapping. No expansion or relabeling is authorized. |
| P13 `03`/`06` | Renders all choices for explicit human selection; maps the chosen view candidate to existing P1 preconditions/payload; never auto-selects, auto-submits, or treats load failure as consent. |
| P1 `01` V21 | Owns exact wire codec, final CAS, authority/operator/provider checks, decision commit and stale refresh. |
| P2/P4/P9 | Retain their existing execution-dispatch gate, sandbox application, recovery, and provider-failure responsibilities. |

No new route, command type, wire field, persistence field, table, event,
migration, authority source, provider tuple, or dispatcher is introduced.

## 9. TDD and acceptance evidence

After proposal acceptance and implementation authorization, focused failing
tests must establish:

1. Initial and stale-committed-policy views use the exact P10 V21 common field
   names and values; stale refresh binds `latestCommittedPolicyRevision` to
   the existing latest decision. P1 mapping uses only its existing
   `expected...` names. Invocation/interruption IDs never leave the internal
   read predicate.
2. Full V2 bundle revision/digest bind the provider registry. Changing any
   bundle child, including provider-registry revision/digest, invalidates the
   common precondition for both candidates; a refreshed view still offers
   TrustedLocal without a registry branch precondition.
3. Valid bundle + successful exact-host enumeration + zero Supported tuples
   yields TrustedLocal only. Invalid/incomplete bundle, high-water, host
   identity, capability/build, or tuple enumeration yields typed failure and
   no candidate. Failure is never represented as an empty supported set.
4. P5 produces only current-host exact Supported tuples. P10 applies the
   existing Workspace/episode/handle predicate, and every applicable tuple
   maps to exactly one candidate. Duplicate collapse, conflict rejection, and
   a one-to-one mapping assertion are tested.
5. DTO tuple fields exactly match V3/P1 (`providerId`, `providerVersion`,
   `profile`, `networkMode`); no display names, arbitrary profile refs,
   registry internals, paths, or diagnostics appear. OS registry revision is
   a positive safe integer and appears only on OS candidates.
6. All variants use `spc2_<hash>`; the trusted-local vector in §6 and OS
   vectors have golden tests for exact bytes and digest.
7. P1 checks unchanged and stale common preconditions for both variants, plus
   the OS-only expected provider registry pair. Registry drift therefore
   rejects a stale TrustedLocal read through the common bundle CAS; after
   refetch, TrustedLocal remains selectable without a registry precondition.
8. P13 has no auto-selection/submission; P2/P4/P9 continue to block dispatch
   until existing P1 decision/application semantics allow it. No route,
   command codec, schema, or migration is added.

Acceptance authorizes only the exact owning-contract landing package under
manual governance. It does not authorize implementation, release, or provider
qualification.

## 10. Acceptance

If this exact V3 proposal is accepted, record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V3
```

Record the accepted raw SHA-256, decision, owner revisions, and independent
post-landing consistency review before implementation begins.
