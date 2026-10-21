# P4 — 04 Sandbox / Execution Workspace Binding

**Authority:** DID v1.25 EWB-1…EWB-10; SD v1.3 §6.5.
**Status:** FROZEN.

## 1. Boundary

P4 owns the provider-neutral `SandboxPort`, logical mount namespace and target
confinement. P11 owns Git worktree lifecycle, environment snapshots and
advanced/hardened sandbox providers.

`ResourceAddress` and tool path are distinct:

```text
ResourceAddress -> environment/authority identity
mount ref       -> execution-local logical resource
relative path   -> target inside that mount
```

## 2. Binding and handle contracts

```ts
interface SandboxMountBinding {
  readonly ref: "workspace" | string
  readonly address: FileTree | GitWorktree
  readonly region: CanonicalResourceRegion
  readonly access: "ReadOnly" | "ReadWrite"
}

interface SandboxPortService {
  readonly open: (input: {
    readonly executionId: ExecutionId
    readonly workspaceId: WorkspaceId
    readonly mounts: ReadonlyArray<SandboxMountBinding>
  }) => Effect.Effect<SandboxHandle, SandboxError>
  readonly close: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>
}

interface SandboxOpenedMount {
  readonly ref: string
  readonly rootPath: string       // process-local, never model/wire-visible
  readonly region: CanonicalResourceRegion
  readonly access: "ReadOnly" | "ReadWrite"
}

interface SandboxHandle {
  readonly handleId: string
  readonly rootPath: string       // compatibility alias for primary workspace
  readonly mounts: ReadonlyArray<SandboxOpenedMount>
  readonly writableRegions: ReadonlyArray<CanonicalResourceRegion>
}
```

`open` rejects duplicate mount refs, a missing primary `workspace` mount, an
unsupported address family, or an address/region mapping that cannot be opened.
No adapter may silently substitute an empty directory for an admitted mount.

## 3. Relative target

```ts
interface SandboxTarget {
  readonly mount: string
  readonly path: string
}
```

`path` uses `/` separators. `.` denotes the mount root. Empty, absolute,
drive-qualified, UNC, backslash-containing, control-character, empty-segment
and `..` paths are invalid.

Target resolution requires:

1. exact mount-ref lookup;
2. lexical containment beneath that mount root;
3. for an existing target, realpath containment;
4. for a new target, realpath containment of the nearest existing ancestor;
5. `Write` access only on a `ReadWrite` mount.

The resolved host path is process-local data. It is not persisted and is never
returned to the model.

## 4. Guarantees

```text
- model-facing tools never receive or return host paths
- reads/writes resolve only through an opened mount
- writes require ResourceAdmission + writable canonical ownership upstream
- shell cwd is resolved through the same mount contract
- local trusted mode is explicitly not an OS security boundary
- hardened providers must confine process filesystem/network/environment access
- close releases only adapter-owned ephemeral resources; it never deletes a
  bound managed worktree
```

## 5. Failure contract

Invalid path, unmapped mount, missing/type-mismatched target, escape attempt or
ordinary filesystem access failure becomes a terminal `ExpectedFailure` tool
observation. A provider/executor defect is not swallowed here; it remains
visible to P9 recovery and side-effect reconciliation.

## 6. Must Not Decide

- No Worktree lifecycle mutation (P11).
- No authority/permission decision (precedes `open`).
- No provider-specific container/MicroVM mechanism.
- No host-path reconstruction in Model Context or prompts.

## Accepted Native OS Sandbox convergence contract

`SandboxPort` retains logical mount identity, target confinement, and
Execution-scoped `open`/`close`; closing a sandbox handle does not delete or
retire the P11 Worktree. The accepted parent adds a distinct
`SandboxProcessPort` for untrusted process execution. It consumes a bound
`SandboxHandle` and `SandboxProcessPolicy`, preserving exact admitted mount
access while enforcing OS-level process, filesystem, network, environment and
resource controls. A Git worktree is not an OS security boundary.

The profiles are `ReadOnly`, `WorkspaceWrite` and explicit `FullAccess`;
network modes are `Disabled`, `Restricted` and `Enabled`. Restricted/Enabled
require the exact durable human policy authority; ordinary approval does not
grant network. If any required control cannot be probed/enforced, the provider
is `Unavailable` and no process starts. Platform adapters report effective


## Accepted full-chain OS policy, network and provider contract (V21)

The process boundary consumes exactly one closed policy variant and the
canonical effective-policy summary from the committed decision. OsEnforced
permits only ReadOnly or WorkspaceWrite and binds provider/version/capability/
OS build/evidence, NetworkPolicyV1/digest/broker controls, mounts, sorted
environment allowlist names, bounded limits, audit refs and authority/
operator/registry revision+digest. TrustedLocalUnconfined is the sole
FullAccess choice: trustedRuntimeIdentity=TrustedLocal,
trustedRuntimeVersion=builtin-v1, profile=FullAccess,
networkBoundary=Unconfined, and no OS/provider/T3/networkMode/broker fields.
It is an explicit human choice, never fallback, and P13 labels it high risk.

Persisted network_policy_json is a closed v1 union with these exact forms:
{"kind":"OsEnforced","policy":{"version":1,"mode":"Disabled|Restricted|Enabled","destinations":[]}}
or {"kind":"TrustedLocalUnconfinedV1","version":1}; all discriminants
and nested keys use fixed closed-codec ordering and reject unknown fields.
The OsEnforced nested NetworkPolicyV1 has exactly version=1,
mode Disabled|Restricted|Enabled, and sorted unique destinations. Each
destination is a canonical HTTPS DNS origin with ASCII lowercase IDNA
A-label and implicit port 443; reject IP literals, wildcard, userinfo,
custom/explicit port, path/query/fragment, trailing dot, percent escapes and
noncanonical IDNA. Disabled and Enabled require empty destinations;
Restricted requires a nonempty exact allowlist. Union discriminant and exact
canonical bytes are included in the policy digest. The unpublished Wave-A
draft is superseded before first persistence.

All OsEnforced egress is broker-only: children receive no direct DNS/network,
loopback, raw socket/IP, UDP/QUIC, arbitrary ports, DoH or bypass. Disabled
denies DNS and all egress. Restricted permits exact listed HTTPS origins.
Enabled permits arbitrary public HTTPS only through the broker, never local
or private targets. Broker resolves A/AAAA, rejects the whole set if any
answer is denied, normalizes mapped IPv6 to IPv4 before classification, pins
one validated address per connection, and verifies certificate/SNI/Host for
the same origin. Every redirect is parsed, reauthorized, resolved, filtered
and pinned; allow at most five hops, reject downgrade, raw IP, denied/mixed
answer, unlisted Restricted origin and hop six. Use the fixed conservative
IANA 2025-10-09 special-purpose deny-set/hash and CIDRs owned in P12/13;
never weaken it from registry flags. DNS rebinding or broker/OS control
failure is Unavailable.

For Restricted/Enabled, perform fresh Pref64 discovery for every new DNS
resolution and connection using the qualified RFC7050/platform method; no
cross-connection cache or pooled route reuse. One immutable result may be
used within one handshake. Unknown/unverifiable discovery yields
sandbox/pref64-unknown. A newly discovered valid prefix is not itself an
error. Reject every AAAA falling within any freshly discovered Pref64; do not
decode it into an IPv4 target, synthesize an alternate address or route around
the deny set. A trusted empty-set result requires the qualified no-DNS64 proof.
Affected pools are closed/disabled. An existing pinned connection may only
finish normally and may not redirect, resolve, reconnect or re-enter a pool.
Disabled does no DNS or Pref64 discovery.

Provider capability is an exact operator-issued tuple: provider ID/version,
capability revision, exact OS family/build, profile×networkMode,
networkPolicyCodecVersion=1 and enforcementRuleSetDigest. Qualification
evidence is blob:sha256:<manifestDigest>; the canonical manifest lists
artifact hashes separately and never self-references. Supported requires
exact tuple, manifest/artifact hashes and all T3 PASS evidence. No inferred
Cartesian product or provider self-assertion is accepted.

Hard primitive sets are:
- Linux linux-bwrap: user/mount/PID/network namespaces; exact RO/RW binds;
  no direct network plus broker-only channel; cgroup v2 pids/memory/CPU;
  seccomp; process-tree kill.
- macOS macos-seatbelt: deny-default filesystem/network/process Seatbelt
  policy and exact loaded profile; broker-only channel; process-group/
  descendant kill; explicit rlimits and hard resource limits. If the OS/build
  cannot prove any required deny/limit, return Unavailable.
- Windows windows-mxc and windows-elevated-dedicated-user are separate
  probe-only Experimental IDs and can never be Supported. The only Supported
  candidate is windows-restricted-appcontainer-job: restricted low-integrity
  token; AppContainer ACL filesystem; no Internet capability/direct network;
  named-pipe broker only; Job Object kill-on-close and active process/memory/
  CPU limits; reparse-point/junction defense. Missing any control is
  Unavailable before spawn.
- Container and Remote remain contract-only until separately qualified.

SandboxProcessPort is the only process-spawn boundary. Before spawn it binds
the committed variant snapshot, exact resource/mount targets/access,
environment-name allowlist and limits; creates a process-local handle; and
reports typed capability evidence. Missing/stale/unprovable enforcement
produces provider-unavailable before effect admission, with no spawn. P4
never infers Supported from host defaults or reports a failed probe as
success.


## Closed effective policy snapshot/result variants

OsEnforcedPolicySnapshotV1 has exact canonical key order:
version,kind,projectId,workspaceId,executionId,episodeBinding,workspaceRevision,
resourceBoundaryRevision,resourceBoundaryDigest,sandboxEnvironmentBasisDigest,
policyRevision,expiresAt,profile,providerId,providerVersion,capabilityRevision,
osFamily,osBuild,qualificationEvidenceRef,networkPolicy,networkPolicyDigest,
networkBrokerControls,providerRegistryRevision,providerRegistryDigest,
sandboxHandleBindingDigest,mounts,environmentAllowlist,limits,auditRefs,
authorityBundleRevision,authorityBundleDigest,operatorConfigRevision,
operatorConfigDigest.
TrustedLocalUnconfinedPolicySnapshotV1 has exact canonical key order:
version,kind,projectId,workspaceId,executionId,episodeBinding,workspaceRevision,
resourceBoundaryRevision,resourceBoundaryDigest,sandboxEnvironmentBasisDigest,
policyRevision,expiresAt,trustedRuntimeIdentity,trustedRuntimeVersion,profile,
networkBoundary,sandboxHandleBindingDigest,mounts,environmentAllowlist,limits,
auditRefs,authorityBundleRevision,authorityBundleDigest,operatorConfigRevision,
operatorConfigDigest. It omits providerRegistry and all OS/T3/network-policy/
broker fields. No nullable superset is allowed.

Both variants use canonical ExecutionEpisodeBinding, sorted mounts with each
entry mountId,targetRef,targetIdentityDigest,access; sorted unique environment
names (never values); limits exactly wallTimeMs,stdoutBytes,stderrBytes,
processCount,memoryBytes,cpuTimeMs as positive finite safe integers exactly
equal to the selected profile tuple in the trusted operator config. For
OsEnforced, those exact six configured values must match the values bound by
the selected provider's T3 evidence; no unspecified operator/platform
maxima codec is inferred. TrustedLocal records the values for disclosure and
does not claim enforcement or T3 qualification. auditRefs are sorted unique
opaque IDs, at most 32 entries and at most 128 UTF-8 bytes per ID, internal
only.
The full snapshot digest is SHA-256 of its exact canonical UTF-8 bytes,
lowercase hex. P1 stores the bounded closed internal result in existing
commands.result_json with the snapshot and digest in the same transaction as
the decision, receipt and event; the decision row policy_digest and
 decision_command_id join must validate against it on recovery. No BlobStore,
prune or separate result table. Public DTO/receipt expose only the safe
variant projection and never refs, digests, paths, environment values or audit
refs. Result over 65,536 bytes is TerminalRejected(SandboxPolicySummaryTooLarge)
with receipt only, no decision/event and no truncation.

## Accepted V3 producer-to-policy mapping

The snapshot producer consumes the complete current ResourceBoundary and its
`basisResponsibilityRevision` from P11, not a caller/tool-target subset.
`resourceBoundaryDigest` is the V3 `ResourceBoundaryDigestV1`: lowercase
SHA-256 of canonical compact UTF-8 JSON with exact key order
`version,basisResponsibilityRevision,regions`; the revision is a
nonnegative safe integer, including zero; regions are the complete
`canonicalRegionString` set, existing filesystem aliases/exact duplicates
collapsed, then UTF-8-byte sorted and unique. P12/09's region encoding is not
changed. The accepted vectors and their exact hashes are in the V3 proposal
and P11/04.

Only FileTree/GitWorktree filesystem regions become logical process mounts.
The primary managed GitWorktree is `mountId="workspace"`; each additional
filesystem region is `mountId="resource-<regionIdentityDigest>"` using the
full lowercase 64-hex region digest. The primary is not duplicated. Mounts
sort by UTF-8 mountId; equal IDs for unequal target refs/source identities
fail closed. Every `targetRef` remains the V21 closed
`SandboxTargetRefV1` object `{version,kind:"RegionDigest",resourceSpace,
regionIdentityDigest}`; it is never replaced with a serialized hash string.
If an internal target-reference digest is needed, it is a separately named
derived value and does not change the snapshot's object-valued `targetRef`.
DatabaseNamespace and ExternalResource remain policy/admission metadata and
do not become process mounts. A shell invocation requiring either kind uses
the existing no-effect ResourceResolutionDenied path without invalidating
the rest of the policy.

Access is derived from exact current Workspace ownership, never from model
input: ReadOnly makes every logical mount ReadOnly; WorkspaceWrite makes a
mount ReadWrite only when its exact region is covered by an active current
Workspace ResourceOwnership claim, otherwise ReadOnly. TrustedLocal FullAccess
retains this logical mapping only for disclosure and invocation checks; it
does not claim host isolation. Each invocation independently checks its
pinned required access before effect admission.

The current trusted operator source is SandboxAuthorityBundleV2 from P5/01.
`operatorConfigRevision/Digest` in this snapshot must exactly equal the V2
bundle's adjacent revision and SHA-256 of its embedded
SandboxOperatorPolicyConfigV1 bytes. The TrustedLocal runtime identity is
strictly `trustedRuntimeIdentity="TrustedLocal"` and
`trustedRuntimeVersion="builtin-v1"`; no other V1 value is canonical. The
existing V21 snapshot and basis key sets/vectors are unchanged. Network
broker controls are the exact closed objects in P12/13; Restricted/Enabled
use `pref64="FreshPerResolutionAndConnection"`, Disabled has no Pref64
field, and no separate controls digest exists. Each new resolution,
connection and redirect performs fresh Pref64 discovery; one result is used
only within that connection's answer-validation/address-pin/connect/TLS
handshake and is never reused across a resolution, connection or redirect.

The exact derived controls are Disabled
`{"version":1,"mode":"Disabled","directNetwork":"Denied","broker":"Disabled"}`;
Restricted
`{"version":1,"mode":"Restricted","brokerProtocolVersion":1,"directNetwork":"Denied","dns":"BrokerOnly","pref64":"FreshPerResolutionAndConnection","ipPinning":"AllAnswersPublicPerConnection","redirectMaxHops":5,"tlsIdentity":"ExactSniHostCertificate","rawIp":"Denied","udp":"Denied","specialUse":"Denied"}`;
Enabled is the exact Restricted object with only `mode="Enabled"`. Runtime
reconstructs and byte-compares these canonical controls against
SandboxEnforcementRuleSetV1 and the exact qualification evidence. There is no
`networkBrokerControlsDigest` or caller/provider-selectable controls variant.

P4 builds `auditRefs` only from stable existing refs: the exact authority
audit-record ref if the current audit codec/store exposes one (otherwise
omit); the committed P1 CommandId/receipt ref; and for OsEnforced the exact
qualification manifest blob ref (omit for TrustedLocal). Then exact-dedup,
UTF-8 sort and enforce the existing V21 bounds. No ref is synthesized from
time, log offset, path, provider diagnostic, caller input, or arbitrary audit
content. All remain internal-only and are redacted by the public view.

## Accepted Option A provider-tuple input binding (2026-10-20)

Under `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`, fixed proposal
SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`,
an OsEnforced decision's `providerVersion` and `capabilityRevision` are
copied from the exact P5 Supported row selected by the P1 command's explicit
providerId/version/capabilityRevision selector and trusted current-host,
profile, network-mode, codec and ruleset match. P4 continues to materialize
and validate the existing `OsEnforcedPolicySnapshotV1`; that snapshot
already contains both values in its fixed key order. The snapshot codec,
runtime policy, provider capability and handle contracts do not change.

## Accepted Windows T3-D D2 operator trust V1

Manual governance accepted `T3D-DG-01` under
`ACCEPT_NATIVE_OS_SANDBOX_WINDOWS_OPERATOR_TRUST_V1`, proposal SHA-256
`EAA9430B87462658D7B475C3D469425C5DB2BE0069A4D51634FD9C7FC3BA2039`),
Windows `windows-restricted-appcontainer-job` capability may rely only on the
current P5-protected V3 operator trust set and its exact high-water, the
Ed25519-verified canonical manifest/sidecar, and the matching current
operator-issued registry row. The adapter cannot self-issue a key or evidence
ref, accept an injected test callback as production authority, use caller or
environment paths, or fall back to OS-wide certificate trust, digest-only
checks, TrustedLocal or a prior-green probe. The actual source/compiler/PE
and evidence artifacts, OS build, provider/version/capability revision,
profile×network tuple, rule-set digest and configured limits must match the
signed manifest and registry exactly. Key revocation, expiry, rotation drift
or missing V3 source/high-water makes affected rows Unavailable before spawn.

The adapter rechecks current trust and installed bytes at capability probe
and before effect admission. Signature verification proves provenance only;
all existing T3 AppContainer, Job, filesystem, Disabled-network, broker and
Stop controls remain independently required for Supported. No V2 deployment,
T2 Experimental probe, test harness or D2-only result advertises a Supported
tuple or starts a production helper.

### Accepted Windows D2 V3 process-policy and admission mapping

The exact accepted physical contract is
`ACCEPT_WINDOWS_T3D_D2_V3_PHYSICAL_CONTRACT_V1`, draft SHA-256
`2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`.
P5 supplies one immutable current `SandboxAuthorityBundleV2|V3` snapshot;
after a verified V3 cutover P1 Resolver/Gateway, P4 policy materializer and
ToolRuntime, and P10 candidate read project its unchanged issuer/operator/
registry children without synthesizing a V2 shadow. Existing
`authorityBundleRevision/Digest` preconditions bind the **whole current V3**
bytes. Committed V2 policy/candidate revisions become stale after the V3
cutover and remain historical audit evidence only. P4 retains the exact
registry→committed summary→internal OsEnforced policy→capability
`qualificationEvidenceRef` and full enforcement-rule-set digest comparison;
no new public DTO, P1 command field, P4 observation field or fallback is
introduced.

The Windows adapter constructs a production verifier only from the current
P5-protected V3 trust snapshot. The D1 arbitrary verifier injection remains
test-only. Probe and pre-effect admission re-read the current V3 trust-set
revision/digest, source/high-water pair, signer status and installed
source/compiler/PE/manifest/sidecar/test-control bytes. Any drift or missing
component is typed Unavailable before spawn, even if an earlier probe was
green. A V2 registry Windows Supported row cannot be byte-carried into V3;
an operator must advance the registry revision and remove its Supported
status before cutover, and D2 cannot create a new Supported row. The physical
signature/identity result alone leaves all Windows provider capabilities
Experimental with empty tuples and `SandboxProcessPort.run` Unavailable.
D4–D6 enforcement qualification remains necessary.

## Accepted pre-intent policy selection ordering (2026-10-21)

The pre-intent CandidateRead is a P4/06 read-only proof used by P10/P1; it is
not a ToolRuntime invocation or a new sandbox runtime policy. It does not
create a ToolInvocation/RecoveryBinding, consume approval, open a Sandbox,
call a provider/executor or admit an effect. The existing exact approval
gate remains before P4's first ToolInvocation intent and effect-admission
boundary: after P1 commits policy, the human resolves the exact pending
Executable approval, and P4's existing claim transaction atomically stores
the intent and consumes the Approved revision. P4 uses the committed current
decision only after that ordinary gate. Missing/stale policy still follows
the existing NotAdmitted SandboxPolicyRequiredInterruption; real provider
unavailability still follows the existing P9 terminal no-later-action path.
