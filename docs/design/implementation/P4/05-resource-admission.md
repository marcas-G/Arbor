# P4 — 05 Resource Admission

**Authority:** DID v1.8 §1.5, G4; SD v1.3 §4.4/§6.5; P1/P2 resource contracts.
**Status:** DRAFT (first draft for contract review).

## 1. Boundary (G4)

Tool **Resource Admission is validate-only**: it checks
`ResourceOwnership ⊆ ResourceBoundary` for the resolved regions. It **never**
acquires or releases ownership claims. Ownership changes remain governance
Commands (application-owned `UpdateResourceBoundary`).

## 2. Canonical resource resolution

```text
ToolIntent resource arguments (ResourceAddress[])
        ↓ ProjectEnvironmentPort.resolve
CanonicalResourceRegion[]
```

- Uses the P1/P2 `ProjectEnvironmentPort` resolver; alias resolution happens
  there (DID §1.5).
- Resolution happens **before** admission and outside the execution sandbox.

## 3. Admission check

```ts
interface ResourceAdmissionService {
  readonly admit: (input: {
    readonly workspaceId: WorkspaceId;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<AdmissionResult, ResourceAdmissionError, TransactionScope>;
}

type AdmissionResult =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "Denied"; readonly reason: string };
```

Rule:

```text
for each region:
  region ⊆ ResourceBoundary(workspace, current responsibility revision)
  AND region ⊆ active ResourceOwnershipClaim regions of the workspace
else -> Denied
```

- Uses the frozen `contains/overlaps` algebra (`domain/resources.ts`).
- Read-only tools still require the region to be inside the boundary; write
  tools additionally require an active ownership claim.
- No SQL string-prefix overlap approximation (P1 rule).

## 4. Transaction participation

- The admission read runs in a short `TransactionScope`; it does not open its
  own connection.
- Admission never mutates `resource_ownership`.

## 5. Must Not Decide

- No ownership claim/release (governance Command).
- No ResourceBoundary mutation.


## Accepted V21 path-free sandbox target and policy basis

P11/04 resolves the existing CanonicalResourceRegion; P4 uses the separate
closed SandboxTargetRefV1 exact shape and key order:
{version:1,kind:"RegionDigest",resourceSpace,regionIdentityDigest}. The value
resourceSpace is exactly the existing closed resourceSpaceId enum
filesystem|database|external; map FileTree/GitWorktree→filesystem,
DatabaseNamespace→database, ExternalResource→external. Reject all other
mappings. regionIdentityDigest is lowercase SHA-256 of exact existing
canonicalRegionString UTF-8 bytes computed in trusted P11. It is a path-free
binding, not a secret; refs/digests remain internal and are redacted publicly.
P12/09 is cross-reference only and does not change canonical region meaning.

TargetIdentityDigestV1 hashes canonical keys
version,workspaceId,mountId,targetRef,resourceBoundaryRevision,access.
SandboxHandleBindingDigestV1 hashes keys version,workspaceId,mounts,
resourceBoundaryRevision; mount rows are sorted by mountId and contain exactly
mountId,targetRef,targetIdentityDigest,access. Neither contains process-local
handle ID, host path, env value, workspace content, dirtiness, mtime or output.

SandboxEnvironmentBasisDigestV1 is a closed variant union with separate
codecs. OsEnforced basis binds workspace/resourceBoundary revision, sorted
mounts, sorted unique allowlist names, limits, authorityBundle revision/digest,
providerRegistry revision/digest and qualificationEvidenceRef. TrustedLocal
basis binds workspace/resourceBoundary revision, mounts, allowlist, limits,
authorityBundle revision/digest, operatorConfig revision/digest and
trustedRuntimeVersion=builtin-v1; it omits provider registry and all OS/T3
fields. Its basis digest remains variant-specific, but currentness separately
compares the full `authorityBundleRevision/Digest` for both variants. Any
bundle change, including a provider-registry-only change, stales TrustedLocal
even though its basis omits provider-registry fields and it has no registry
branch precondition. Policy/toolchain/limit/allowlist changes must advance
their bound trusted config or registry digest. P11 EnvironmentRevision,
content, dirty state, mtime, outputs and expectedEnvironmentRevision do not
participate.

Exact closed key orders: OsEnforcedSandboxEnvironmentBasisV1 is
version,kind,workspaceId,resourceBoundaryRevision,mounts,environmentAllowlist,
limits,authorityBundleRevision,authorityBundleDigest,providerRegistryRevision,
providerRegistryDigest,qualificationEvidenceRef. TrustedLocalUnconfinedSandboxEnvironmentBasisV1 is
version,kind,workspaceId,resourceBoundaryRevision,mounts,environmentAllowlist,
limits,authorityBundleRevision,authorityBundleDigest,operatorConfigRevision,
operatorConfigDigest,trustedRuntimeVersion. Both hash exact canonical UTF-8
bytes. The former includes registry/evidence; the latter omits registry and
all OS/T3 fields, binds operatorConfig and trustedRuntimeVersion=builtin-v1,
and cannot be made stale by registry changes.

V21 known-answer region vectors use exact existing canonicalRegionString
bytes (synthetic paths are test-only and never persisted): FileTree
{"resourceSpaceId":"filesystem","kind":"FileTree","path":"C:\\v17-fixture\\workspace"} → region
3156810bbb81123146cfaa091838168edefd1e7ffe1306e2e414368d4afa86db and
TargetRef a5e1c895446495056e9bca489b14b3b0f3553bb8c851628e39b66d0aa8b1156e;
the distinct V16 FileTree fixture
{"resourceSpaceId":"filesystem","kind":"FileTree","path":"C:\\v16-fixture\\workspace"} → region
b6c3bd6c85f42d9b42be8675ac3c3e84c2473e2cc398f52e38092974c0c32e30 and
TargetRef 8ac2fbd36799dc5455fc3d372d9c1dc4b937d244ae908474dc6d245f861d2c43;
GitWorktree {"resourceSpaceId":"filesystem","kind":"FileTree","path":"C:\\v16-fixture\\repo"}
region 72a472a83d2f6e85f0df3b6346f9ad29b9805b44f9539b0bb31d6d39fd2f2ea4 /
ref 0bab60ec1d16231ab76ded4072143b27a9f49bd53cb58d228a72c12f06dc8664;
DatabaseNamespace {"resourceSpaceId":"database","kind":"DatabaseNamespace","namespace":"tenant:v16-fixture"}
region 785d93598a072488bd9e2bb612763cfd35acb66ed8b09ab2b7b7bdf766a65016 /
ref c2892be979a3a39b3c48e15aba3c18f0f75df52951b3b44f594ec2ff157dc738;
ExternalResource {"resourceSpaceId":"external","kind":"ExternalResource","address":"urn:arbor:fixture:workspace-root"}
region 586909cec538ffc2e8af7688054dd3bbe83504be8548ffe8b86ffa013423c454 /
ref a9c09be94081452e7dd424d3581768d9433b19e83e86b04cf16259a4fb19a706.
The ExternalResource admitted region and mount use one byte-identical fixture.
Original envelope checksum e70a293c4d04f94457e41bd1875ed241ea7e5cd2d6c674e4eb3369f68d30236d
remains audit-only; derived refs are not added to it.

For workspace ws_v16_fixture, mount workspace, boundary revision 2 and
ReadWrite, targetIdentityDigest / outer SandboxHandleBindingDigestV1 vectors
are: FileTree b1f987adee09fae893025ff923edf8d8c5831feb23b6020c6667892de2be0ecc /
7245d9c71712791e04c2f9eb701c9ec40771626bb73b06b3d0a0185619fb736a;
GitWorktree f2129225c30db6a6893cd1d90b08a382396467bd114c7c6d17ebcb401706f007 /
7404c00c285a791ddfd2da93ad1ae162d7c955cc69f0be21317de9b0c4fae488;
DatabaseNamespace 71cc823b94b90ff7961bfc5b8af756440f4f09f53a3a24c43cc5bdc85603e628 /
c3ca7abc2bb8281d9c3284dfb78d4222e56b131b2f122d313361c6ae41f27b68;
ExternalResource aae62aaa118a51f54a13a8cef65967991eaf33c132c83279005c47aaff0d1932 /
74577cccff312c15e111756bcc94fdd0a5176db4e7f2039e9caf9919b2f02ce4. Basis
vectors use the corresponding single mount, allowlist HOME/PATH, limits
wallTimeMs=60000, stdoutBytes=8192, stderrBytes=8192, processCount=16,
memoryBytes=268435456, cpuTimeMs=30000, and authority bundle revision
1/digest 4444444444444444444444444444444444444444444444444444444444444444.
OS variant also binds registry revision 1/digest
6666666666666666666666666666666666666666666666666666666666666666 and
evidence ref
blob:sha256:7777777777777777777777777777777777777777777777777777777777777777;
TrustedLocal instead binds operator revision 1/digest
5555555555555555555555555555555555555555555555555555555555555555 and
runtime builtin-v1, with no registry fields.

OS basis hashes by region kind FileTree/GitWorktree/DatabaseNamespace/
ExternalResource are 7e6fa29652657f818493803262cefcb4baef63c7a1e6d7636f93f54851e17b7b,
3ba6efaa93b07594e76e1b344a5b017b26c44a76a0b99406fa32792082982f24,
88b595d6146918b28aebc332bd1c816fdf148e5d8749210b0adba77829a6b44d,
f69bc22a63221a2ae47c9d515b306c57c198c86e4fc130eb5b569ad99b1e026b.
TrustedLocal basis hashes are 2858a860a0b2a32e2b23966d5dcafd0bc8b5034796e8abf648c849310c0e6184,
426be1fd9c1cf700b28213aeaadbdc76685d6542e791449c23dd83a6b127378d,
91e9c977df95fb17761b06bfef7a91529baa13d05621a1003fdd2b3e0330bd9d,
3da8b50c78724c629333a5c44c6df0bc0496ad4d486ecd666c9db1d333afa380.

## Accepted V3 full-boundary producer and process-mount admission

For sandbox policy preparation, P4 consumes P11's complete current
ResourceBoundary and `ResourceBoundaryDigestV1`, not only the region named
by the pending command or executable invocation. The digest key order is
`version,basisResponsibilityRevision,regions`; the basis revision is a
nonnegative safe integer, including zero; regions are the full
canonicalRegionString set after existing FileTree/GitWorktree alias and exact
duplicate collapse, UTF-8-byte sorted and unique. This does not alter
CanonicalResourceRegion or the existing P12/09 stringifier.

The existing closed `SandboxTargetRefV1` is object-valued with exact order
`version,kind,resourceSpace,regionIdentityDigest`. The resourceSpace enum is
exactly filesystem/database/external. Preserve this object as the mount's
`targetRef`; any additional hash of these bytes has a distinct
`targetRefDigestV1` name and is not substituted into the targetRef field.

Only filesystem FileTree/GitWorktree regions are process mounts. The primary
managed GitWorktree uses mountId `workspace`; each additional filesystem
region uses `resource-<full-lowercase-regionIdentityDigest>`, with exact
UTF-8 mountId order and fail-closed collision handling. DatabaseNamespace and
ExternalResource remain admitted policy-target metadata, not mounts; a shell
request requiring either uses ResourceResolutionDenied before effect and
does not invalidate unrelated filesystem mounts. Exact active current
Workspace ResourceOwnership determines WorkspaceWrite access per region;
ReadOnly remains all-RO, and FullAccess logical permissions make no OS
isolation claim. The tool's pinned required access is checked again on each
invocation; policy mounting is not an authorization grant.

`operatorConfigRevision/Digest` bound by the effective policy exactly matches
P5's SandboxAuthorityBundleV2 operator member and its canonical subobject
digest. Profile limits are the exact configured six-value tuple; OsEnforced
qualification binds those configured values in its existing T3 evidence
artifact, while TrustedLocal only discloses them. No separate maxima codec or
new resource revision is introduced.

## Accepted candidate-read-model V5 policy currentness

For every committed policy variant, compare both the existing
`SandboxEnvironmentBasisDigestV1` and the complete current P5 V2
`authorityBundleRevision/Digest` to the values bound by the immutable policy
decision. This full-bundle check applies to OsEnforced and
TrustedLocalUnconfinedV1. A change to any V2 child, including issuer,
operator, or provider registry, stales both variants. In particular, this
supersedes the earlier V21 sentence that provider-registry drift cannot stale
TrustedLocal. The TrustedLocal basis remains its existing closed variant and
does not gain provider-registry fields; the shared full-bundle fields already
stored in its snapshot are the currentness source.

When this exact policy is required by an active Execution and the full bundle
pair or existing policy basis is stale, preserve the existing P4
`SandboxPolicyRequiredInterruption` path before effect admission. Do not
create a provider-unavailable fact, change profile authority, or auto-select
a replacement. A later human decision uses the existing common V21 bundle
preconditions; OsEnforced alone retains the provider-registry branch
precondition.

## Accepted candidate profile binding digest V6

At both initial and refreshed P10 candidate reads, project P11's complete
current ResourceBoundary and exact active Workspace ResourceOwnership through
the existing profile-specific full-boundary producer for each offered profile.
Compute that candidate's `SandboxHandleBindingDigestV1` from its exact derived
mounts and access: ReadOnly is all ReadOnly, WorkspaceWrite is ReadWrite only
for exact active owned regions, and FullAccess has logical ReadWrite mounts
without an OS isolation claim. The existing `TargetIdentityDigestV1` and
`SandboxHandleBindingDigestV1` codecs and access mapping above are unchanged.
The initial read does not require a committed policy snapshot; a refreshed
read never borrows the stale policy's handle digest. P10 uses one coherent P11
boundary/ownership read barrier and a typed all-or-nothing failure when that
full projection cannot be proved. P1's existing submitted-profile CAS still
recomputes the same current full-boundary/ownership projection.
