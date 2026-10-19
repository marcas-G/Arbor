# P11 — 04 Real Environment Resolver (GQ2/GQ3')

**Authority:** GQ2/GQ3' 裁决; DID §1.5 (C8: alias/overlap), P1 `02` (ProjectEnvironmentPort), §12.9.
**Status:** DRAFT.

## 1. Port semantics (observation-only)

`ProjectEnvironmentPort.resolve(addresses)` returns:

```ts
{ regions: CanonicalResourceRegion[], observedRevision: EnvironmentRevision,
  currentFingerprint: EnvironmentFingerprint }
```

- FileTree → stat probe (existence/mtime); GitWorktree → worktree metadata (existence/HEAD/dirty). Aliases normalize per C8 (worktree→filesystem subtree under the same backing space). Overlap algebra unchanged (P0 domain functions).
- **Observation-only**: reads the anchor counter; never advances it (CI-1). The returned fingerprint is derived from the *probe of the requested addresses*; the project-global fingerprint (for drift) comes from a full-region capture (`02` snapshot), not from a caller-subset.

## 2. ResourceResolutionStale (real, finally)

With real probing the ownership CAS sequence can genuinely observe counter movement mid-write → `ResourceResolutionStale` → bounded re-resolve (`10` wiring). Retryable operational error, per P1.

## 3. Must Not Decide

- No caller-subset fingerprint as project fingerprint (multi-workspace interleaving hazard); no cache (fresh probe each resolve; caching empirical later); no network resources in v1 (ExternalResource resolves to itself).


## Accepted V21 Native Sandbox region digest producer

The trusted P11/04 real resolver remains the source of admitted
CanonicalResourceRegion values and logical access. For Native Sandbox it
additionally produces the separate SandboxTargetRefV1 mapping used by P4:
resourceSpaceId must be exactly filesystem, database or external; FileTree/
GitWorktree map to filesystem, DatabaseNamespace to database and
ExternalResource to external. Compute regionIdentityDigest from SHA-256 of the
exact existing canonicalRegionString UTF-8 bytes while still inside the trusted
boundary. The persisted policy ref is {version:1,kind:RegionDigest,
resourceSpace,regionIdentityDigest}; it contains no host path. It is a stable
internal binding only, not a confidentiality control. This producer does not
modify canonical region representation, authorization, overlap or resolver
semantics. Resolver/source changes feed resourceBoundaryRevision/CAS; they do
not use P11 EnvironmentRevision, file dirtiness or mtimes to stale policy.

## Accepted V3 full ResourceBoundary digest producer

For DecideSandboxPolicy preparation, the trusted P11 producer resolves the
complete current ResourceBoundary for the exact Workspace and its
`basisResponsibilityRevision`; it must not call the generic requested-address
path with only the caller's tool target and treat that subset as the policy
boundary. This sandbox-specific full-boundary read uses existing boundary
ownership/revision sources and adds no command, persisted row, revision
algebra, or change to `ProjectEnvironmentPort.resolve(addresses)` semantics.

`ResourceBoundaryDigestV1` preimage is canonical compact UTF-8 JSON, no BOM,
whitespace, or trailing newline, with exact key order
`version,basisResponsibilityRevision,regions`:

```json
{"version":1,"basisResponsibilityRevision":0,"regions":["<canonicalRegionString>"]}
```

`basisResponsibilityRevision` is a nonnegative safe integer (zero is valid).
`regions` is the complete boundary encoded using the existing
`canonicalRegionString`; filesystem FileTree/GitWorktree aliases and exact
duplicate strings collapse under the existing canonicalizer, then the full
array is sorted by unsigned UTF-8 bytes and unique. Malformed/noncanonical
producer output, an identity collision, or conflicting metadata for one
canonical region fails closed; never select by resolver iteration order.
`resourceBoundaryDigest` is lowercase SHA-256 of the exact preimage bytes.
Required revision-0 vector for the single FileTree region `/fixture/a` is
`{"version":1,"basisResponsibilityRevision":0,"regions":["{\"resourceSpaceId\":\"filesystem\",\"kind\":\"FileTree\",\"path\":\"/fixture/a\"}"]}` →
`429afbb35ca0bd989c5d0bfeebd60887c240f9ddeb1acdf29ab52f5564e10f6c`.
The revision-7 two-region vector and target-reference vectors are the exact
known-answer values in the accepted V3 proposal and P4/04/P4/05. Existing
P11 EnvironmentRevision, dirty state, mtime, file content, and requested
address fingerprints do not enter this digest.

For each canonical region P11 emits the existing object-valued
SandboxTargetRefV1 `{version:1,kind:"RegionDigest",resourceSpace,
regionIdentityDigest}`; resourceSpace is filesystem/database/external and
regionIdentityDigest is SHA-256 of the exact canonicalRegionString bytes.
No path is persisted in this reference. P11 does not replace or alter the
canonical region codec; P12/09 remains its owner.

The existing P11 closure invariants CI-1 and CI-2 remain controlling; this
accepted sandbox-specific producer does not create another revision path or
caller-passed ControlBasis.
