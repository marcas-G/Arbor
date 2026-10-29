# P12 — 13 Security Hardening / Performance (DID §11 P12)

**Authority:** DID v1.14 §11 P12, §8.4A (Information Trust Metadata), §8.16A (D5/D6), §9.1, §13 (empirical); SD v1.3 §8A (Information Trust Plane), §7.7 (resource control/usage), §10.7 (durability envelope), §14 No.45/No.54; P3 `02` §10, P3 `05` §4; P4 `04`; P11 `12`; P12 `02` (authority), `03` (secrets), `05` (storage assessment), `06` (worker identity), `08` (safety envelope).
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox security/performance addendum accepted under `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1`.

## 1. Boundary (frozen)

```text
P12 enforces already-frozen invariants; the accepted Native OS Sandbox
addendum is the sole new sandbox-security semantics in this document.
Security hardening = Information Trust Plane at the context boundary + sandbox trajectory.
Performance       = declared operating envelope + measurement method + ceilings.
Mechanism is contract; numeric values are empirical (DID §13).
```

## 2. Information Trust Plane enforcement at the context boundary

`ContextFragment` currently carries no provenance; P12 makes trust explicit and enforced:

```ts
interface ContextFragment {              // BREAKING: required field added (NOT additive)
  readonly ref: string;
  readonly layer: ContextLayer;
  readonly retention: RetentionClass;
  readonly cacheClass: CacheClass;
  readonly tokens: number;
  readonly provenance: InformationTrustMetadata;   // P3 `02` §10 / DID §8.4A (NEW, required)
}
```

Constructor / SPI impact (R-15):

```text
Adding a REQUIRED `provenance` field is NOT additive:
  every existing ContextFragment constructor stops type-checking (source-breaking);
  any consumer/plugin that constructs a fragment is affected.
Classification: source-breaking (MAJOR) change to the model-context boundary contract.
  ContextFragment is not currently in the frozen plugin SPI surface (`01` §3), so this
  implies no PluginSdkApiVersion bump for internal construction; if fragments ever cross
  the plugin SPI as inputs, the required field is a MAJOR SPI change (bump
  PluginSdkApiVersion MAJOR, `01` §4).
Resolution: ContextFragment construction is centralized at exactly ONE context-boundary
  construction site — the model-context boundary fragment factory in
  `packages/model-context` — which is the sole place that assigns `provenance`.
  All other code receives already-tagged fragments (e.g. PrepareTurnInput.contextFragments)
  and never constructs them.
Assertion: no other construction path omits `provenance`. The required field makes
  omission a compile error, and a test/architecture check asserts ContextFragment object
  literals exist only at the single context-boundary factory (test fixtures construct
  through that factory or supply `provenance` explicitly).
```

- At the context boundary, `ToolObservation` / `ExternalRetrieved` / `Message`
  (AuthenticatedAgent / human input as data) / `ModelDerived` fragments are tagged
  `DataOnly`; only Runtime-compiled canonical governance/control may be
  `CanonicalInstruction` (DID §8.4A).
- `canRaiseAuthority(trust)` is **enforced** on the admission/planning path: a `DataOnly`
  fragment can never be promoted to `CanonicalInstruction` and never enters the `A0`–`A3`
  control plane.
- Enforcement is **code** at the context boundary (hard engineering rule 4), not prompt text;
  eviction/budget logic (`planContext`) must not drop or reorder trust metadata.
- Cross-references:
  - `02` — the Authority Resolver produces facts; trust metadata never raises authority.
  - `03` — `SecretMaterial` must not appear in any fragment (no-leak invariant, CI-2).
  - `06` — worker-originated observations remain `DataOnly`; worker identity never confers
    instruction authority.

## 3. Sandbox trajectory (P4 → P11 → P12; accepted Native OS Sandbox amendment)

```text
P4  `04` : SandboxPort mount lifecycle + SandboxProcessPort OS execution policy
P11 `12` : worktree-backed resource adapter; Worktree is not process isolation
P12      : production composition wires a probed provider and durable policy
```

- `SandboxPort` / `SandboxHandle` retain mount identity and lifecycle; the new
  `SandboxProcessPort` adds the provider-enforced process boundary.
- P12 wires provider selection, capability probe and policy; an unsupported
  required capability fails closed rather than selecting a local executor.
- The sandbox is not an authority substitute: authorization/resource admission precede it.
- **Secret-unreachability via env allow-list (NEW-14).** `secret-env` is the default secret
  adapter (`03` §3): it resolves credentials from the process environment. Every sandbox
  adapter MUST therefore project an explicit **env allow-list** onto any spawned process, so
  ambient secrets — including `secret-env` values — are unreachable from sandboxed commands.
  This is the mechanism already implemented by `adapters/sandbox-local`
  (`SANDBOX_ENV_ALLOWLIST` + `sandboxEnvironment`, `adapters/sandbox-local/src/index.ts`);
  every sandbox adapter (e.g. `sandbox-worktree`) inherits the same projection requirement.
  Cross-reference: `03` §4 no-leak invariant / CI-2.
- Assertion: the spawned process environment contains only allow-listed keys; a sentinel
  secret present in the ambient environment is absent from the spawned process env.

## 4. Performance: declared operating envelope + measurement

```text
declared operating envelope : maxConcurrentRuntimes / maxWriteThroughput / maxDbSize /
                              availabilityTarget (P12 `05` §2 StorageScaleAssessment)
measurement method          : stated metric + method + workload per measurement
                              (no unmeasured verdict; DID §13 EMPIRICAL)
```

- The envelope + measurements + `verdict` are owned by `05`; `13` states the operating
  envelope is a **contract declaration** and the numbers are **empirical**.
- **Concurrency ceilings** (D5, DID §8.16A) and **rate / runaway protection** (D6) are
  enforced by the P2-owned Runtime Safety gate and completed per `08`; P12 wires ceilings
  into the provider/tool runtime composition without changing gating ownership.
- Usage/cost stays derived and non-authoritative (`04` §3); unknown cost remains
  `Unknown`/`None`, never `0`.

## 5. Which numbers are empirical (DID §13)

```text
EMPIRICAL (no contract change):
  SQLite performance ceiling                 -> StorageScaleAssessment (`05`)
  context/compaction numeric defaults        -> tune by eval (P3)
  retry counts / backoff                     -> P3 `06` §3, P12 `08` D1
  concurrency ceilings                       -> P12 `08` D5
  rate limits                                -> P12 `08` D6
  lease TTL / sweep intervals / poll batches -> P2/P9 config
  shell allow/deny lists and limits          -> P4 `08` §4
  model prices / price-sheet values          -> P12 `04` §3
CONTRACT (mechanism): the envelope declaration, the measurement method, the
  gating mechanism, the trust metadata, and the sandbox guarantees.
```

## 6. Invariants

```text
DataOnly fragments never raise authority (canRaiseAuthority enforced in code)
every ContextFragment carries provenance; trust metadata survives planning/eviction
ContextFragment construction centralized at the single context-boundary factory; no path omits provenance
SecretMaterial never appears in any fragment / durable / observable surface (CI-2)
sandbox guarantees include accepted OS-enforced process isolation; Worktree remains a resource boundary
every sandbox adapter projects an env allow-list; ambient secrets (incl. secret-env) unreachable
operating envelope declared + measured with a stated method; verdict justified
safety counters never auto-Cancel Work (CI-4, P12 `08` §4)
```

## 7. Must Not Decide

- No new trust model beyond DID §8.4A / SD §8A; no authority ladder change.
- No isolation semantics beyond the accepted Native OS Sandbox amendment; no
  change to `SandboxPort` mount identity/open/close lifecycle.
- No concrete performance/rate/concurrency numbers as contract (empirical, DID §13).
- No usage-based automatic mutation; no safety-envelope auto-Cancel.
- No telemetry value treated as authoritative (`04`).

## 8. Verification

```text
ToolObservation / ExternalRetrieved / Message / ModelDerived fragment → DataOnly;
  canRaiseAuthority(fragment.provenance) === false
only Runtime-compiled canonical fragment may be CanonicalInstruction
ContextFragment provenance survives planContext selection/eviction (not stripped)
ContextFragment literals exist only at the single context-boundary factory; provenance set there
grep/CI: no SecretMaterial in fragment / session / event / log / artifact serialization
sandbox confinement + control-DB/secret unreachability tests (inherited P4 guarantees)
sandbox env projection: spawned process env ⊆ SANDBOX_ENV_ALLOWLIST; sentinel secret absent
StorageScaleAssessment carries envelope + method + verdict; numbers documented empirical
rate/runaway (D6) and concurrency ceilings (D5) drive Interrupted(RuntimeSafetyStop), Work Open
```

## Accepted Native OS Sandbox security/performance addendum

This accepted contract supersedes only P12's sandbox-specific deferral and
SandboxPort-unchanged assumptions. It does not reopen the Information Trust
Plane, secret ownership, worker identity, usage or unrelated D5/D6 duties.

Providers must prove the requested effective policy: macOS Seatbelt;
Linux/WSL bubblewrap with user/mount/PID/network namespaces and optional
seccomp/cgroup hardening; Windows MXC is Experimental pending exact OS/SDK
prerequisites, with separate elevated and explicitly weaker unelevated
providers; container/remote providers enforce the same contract. MicroVM is
not required for v1. The provider reports capability evidence; OS name or
successful process start alone is not proof.

Capability probing is fail-closed. All required filesystem roots, network
authority and anti-bypass, DNS/IP pinning, redirect checks, environment,
process-tree cleanup, walltime/output/process/memory/CPU limits must be
enforced and tested. Restricted/Enabled require exact human authority and
provider enforcement of their destination rules. An unsupported control makes
that profile/provider unavailable. No automatic TrustedLocal fallback.

T0 contract landing/review → T1 TrustedLocal rename, environment projection,
child-tree cleanup and durable policy command → T2 per-platform provider
bring-up (Experimental only) → T3 full network/resource conformance → T4
release matrix. Only after T3 may an individual provider be called Supported.
Numeric budgets and OS versions remain empirical P12 measurements and are not
invented by this addendum. This design landing does not authorize runtime
implementation or release.


## Accepted full-chain T2/T3 authority and network enforcement (V21)

NetworkPolicyV1 canonical policy is the closed OsEnforced union with
version 1, mode Disabled|Restricted|Enabled and sorted unique canonical HTTPS
DNS-origin destinations. Origin requires lowercase ASCII IDNA A-label and
implicit port 443; reject IP literals, wildcard, custom/explicit port,
userinfo, path/query/fragment, trailing dot, percent escapes and noncanonical
IDNA. Disabled and Enabled require empty destinations; Restricted requires a
nonempty exact allowlist. FullAccess is only explicit TrustedLocal+FullAccess,
Unconfined and excluded from every OsEnforced Supported tuple/T3 claim.

SandboxEnforcementRuleSetV1 exact canonical key order is version,
networkPolicyCodecVersion,filesystemRuleVersion,environmentRuleVersion,
processTreeRuleVersion,resourceLimitRuleVersion,brokerProtocolVersion,
addressClassificationSnapshotId,pref64PolicyVersion,redirectPolicyVersion,
platformPrimitiveSetId; every version is 1. It is UTF-8 JSON without BOM,
whitespace or final newline, canonical strings/positive integer notation and
closed fields. enforcementRuleSetDigest is SHA-256 lowerhex over exact bytes,
not embedded. The address-classification snapshot is IANA special-purpose
registries 2025-10-09 with exact canonical snapshot hash
86583d4bbc916863208c3fbb5a75ee3e6500dd12aa4f9bd3a72caaacb4a3da6a.
The exact object template (using the provider-specific primitive ID) is
{"version":1,"networkPolicyCodecVersion":1,"filesystemRuleVersion":1,"environmentRuleVersion":1,"processTreeRuleVersion":1,"resourceLimitRuleVersion":1,"brokerProtocolVersion":1,"addressClassificationSnapshotId":"iana-special-purpose-2025-10-09+sha256:86583d4bbc916863208c3fbb5a75ee3e6500dd12aa4f9bd3a72caaacb4a3da6a","pref64PolicyVersion":1,"redirectPolicyVersion":1,"platformPrimitiveSetId":"<exact closed provider primitive ID>"}.

The fixed conservative denied CIDRs are IPv4: 0.0.0.0/8, 10.0.0.0/8,
100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
192.0.0.0/24, 192.0.2.0/24, 192.31.196.0/24, 192.52.193.0/24,
192.88.99.0/24, 192.168.0.0/16, 192.175.48.0/24, 198.18.0.0/15,
198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4,
255.255.255.255/32; IPv6: ::/128, ::1/128, 64:ff9b::/96,
64:ff9b:1::/48, 100::/64, 100:0:0:1::/64, 2001::/23, 2001:db8::/32,
2002::/16, 2620:4f:8000::/48, 3fff::/20, 5f00::/16, fc00::/7,
fe80::/10, ff00::/8. Normalize IPv4-mapped IPv6 into IPv4 before checking;
never preserve mapped representation. Reject any DNS answer set with one
non-public address. The table is frozen even if IANA labels a special-purpose
exception globally reachable.

All egress is broker-only. Disabled has no DNS/egress/loopback. Restricted
allows exact listed HTTPS origins only. Enabled allows arbitrary public HTTPS
through the broker, no local/private/reserved targets. No child direct DNS,
loopback, raw IP, UDP/QUIC, arbitrary ports, DoH or bypass. Broker resolves,
filters and pins each connection address; certificate, SNI and Host must match
origin. Each redirect hop is independently parsed/authorized/resolved/pinned;
maximum five redirects, sixth/downgrade/unlisted restricted/raw IP/mixed or
blocked DNS answer fails closed.

Every new DNS resolution/connection obtains fresh Pref64 discovery using its
operator-qualified RFC7050/platform method; no cross-connection cache. One
snapshot may be reused only within that handshake. Unknown/unverifiable is
sandbox/pref64-unknown and typed unavailable; a valid newly discovered set is
not a change error. T3 evidence binds method/version and adversarial/known-
answer vectors, not a specific network prefix. Existing pinned connections
only close normally; no redirect/reconnect/pool reuse without fresh checks.

Only exact operator-issued registry entry and evidence manifest permit
Supported. Entry tuple binds provider ID/version, capability revision, exact
OS family/build, profile×networkMode, codec version and enforcementRuleSetDigest;
manifest binds all T3 matrix cases and separate artifact hashes, never
self-references, and does not bind decision destinations. T2 probes run in
isolated qualification harnesses only; Experimental does not spawn production.
No host is declared Supported absent exact operator-issued T3 evidence.


### Exact platform primitive identity and T3 evidence

platformPrimitiveSetId is closed and provider-specific:
linux-bwrap-user-mount-pid-netns-cgroupv2-seccomp-v1,
macos-seatbelt-denydefault-processgroup-rlimits-v1,
windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1,
windows-mxc-probe-only-v1,
windows-elevated-dedicated-user-probe-only-v1. IDs cannot alias or transfer
evidence.

- Linux linux-bwrap: user/mount/PID/network namespaces; exact RO/RW binds;
  no direct network plus broker-only channel; cgroup v2 pids/memory/CPU;
  seccomp; process-tree kill.
- macOS macos-seatbelt: deny-default filesystem/network/process Seatbelt and
  exact loaded profile; broker-only channel; process-group/descendant kill;
  explicit rlimits/hard limits. If a build cannot prove any control, it is
  Unavailable.
- Windows MXC and elevated-dedicated-user are distinct probe-only Experimental
  identities and never Supported. Only windows-restricted-appcontainer-job can
  qualify: restricted low-integrity token, AppContainer ACL filesystem, no
  Internet capability/direct network, named-pipe broker only, Job Object
  kill-on-close and active process/memory/CPU limits, reparse/junction defense.
- Container/Remote remain contract-only without separate qualification.

T3 evidence binds exact provider/build/tuple/rule-set digest, discovery
method/version, matrix/test IDs/results and artifact hashes. Manifest digest is
SHA-256 of canonical manifest bytes, artifacts are listed separately, and the
manifest never self-references. Require every control and adversarial/negative
case PASS before Supported. Pref64 tests cover RFC7050 positive vectors for
RFC6052 lengths /32,/40,/48,/56,/64,/96 embedding 192.0.0.170 and .171 plus
malformed, missing, duplicate, multiple-prefix and adversarial synthesis.
Empty prefix set is allowed only with trusted NoDns64Pref64 plus negative
probes proving no synthesis; timeout/silence/unknown is sandbox/pref64-unknown.
There is no pref64-changed error; fresh network prefixes are not compared to
past hosts. Every resolved AAAA contained by any currently discovered Pref64
is rejected outright; do not decode/synthesize the embedded IPv4 target.


### T2/T3 exact provider qualification matrix

Registry rows are individual profile×networkMode tuples; a row never implies
other combinations. Candidate exact identities and eligible tuple coverage:

| providerId | platform identity | eligible profile×networkMode rows | status rule |
|---|---|---|---|
| linux-bwrap | Linux exact OS build; bwrap/user+mount+pid+netns/cgroupv2/seccomp primitive set | ReadOnly or WorkspaceWrite × Disabled, Restricted, Enabled, each separate row | Experimental during T2; Supported only with exact per-row operator T3 evidence |
| macos-seatbelt | macOS exact OS build; deny-default Seatbelt/processgroup/rlimits primitive set | ReadOnly or WorkspaceWrite × Disabled, Restricted, Enabled, each separate row | Experimental during T2; Supported only with exact per-row operator T3 evidence |
| windows-restricted-appcontainer-job | Windows exact OS build; restricted token/AppContainer/Job/namedpipe primitive set | ReadOnly or WorkspaceWrite × Disabled, Restricted, Enabled, each separate row | sole Windows Supported candidate; still Experimental/Unavailable until each exact row passes T3 |
| windows-mxc | Windows MXC identity | probe-only, no eligible Supported row | Experimental forever in V1; never spawn authority |
| windows-elevated-dedicated-user | Windows elevated dedicated-user identity | probe-only, no eligible Supported row | Experimental forever in V1; never spawn authority |
| container / remote | contract-only, no fixed primitive set | none | no Supported registry entry |

Every row additionally binds providerVersion, capabilityRevision, exact OS
family/build, networkPolicyCodecVersion=1 and enforcementRuleSetDigest plus
operator evidence manifest. Missing controls or evidence set Unavailable; T2
success alone does not set Supported. No host is declared Supported by this
document.

## Accepted V3 producer mapping qualification

`SandboxAuthorityBundleV2` from P5/01 is the current decision-authorizing
authority source. Its embedded `SandboxOperatorPolicyConfigV1` supplies the
exact allowlist/limit values; effective-policy
`operatorConfigRevision/Digest` must equal the exact V2 adjacent fields and
canonical subobject digest. V1 source/high-water/audit bytes remain immutable
historical records under their V1 decoders and cannot authorize new decisions
after V2 activation.

`NetworkBrokerControlsV1` is a closed derived value, not an operator/provider
choice and not a new digest. Disabled is exactly
`{"version":1,"mode":"Disabled","directNetwork":"Denied","broker":"Disabled"}`.
Restricted and Enabled use the exact same ordered fields, with only `mode`
different:
`{"version":1,"mode":"Restricted","brokerProtocolVersion":1,"directNetwork":"Denied","dns":"BrokerOnly","pref64":"FreshPerResolutionAndConnection","ipPinning":"AllAnswersPublicPerConnection","redirectMaxHops":5,"tlsIdentity":"ExactSniHostCertificate","rawIp":"Denied","udp":"Denied","specialUse":"Denied"}`.
Runtime reconstructs canonical controls and compares bytes against the
versioned SandboxEnforcementRuleSetV1 and exact provider qualification
evidence. `enforcementRuleSetDigest` plus the existing qualification-manifest
digest are the only evidence bindings; there is no
`networkBrokerControlsDigest`.

`FreshPerResolutionAndConnection` means fresh qualified Pref64 discovery
before every new DNS resolution and every new connection attempt. A redirect
hop always performs new origin authorization, DNS resolution, discovery,
address filtering/pinning, and connection; no previous hop/pool result is
reused. A discovered set is usable only inside that single connection's
DNS-answer → address-check → connect → TLS handshake. No cross-resolution,
cross-connection, pool, or later handshake reuse is permitted. Unknown or
unverifiable discovery is the existing `sandbox/pref64-unknown`; a valid
freshly discovered different prefix is not itself a failure.

The canonical Restricted policy digest vector is exact bytes
`{"version":1,"mode":"Restricted","destinations":["https://example.com"]}`
→ lowercase SHA-256
`4fb2fbc43163b7085c7c2036ea962587d2be99ffc101f919cda542fef826cffc`.
The origin has implicit port 443; an explicit `:443` is not canonical.

For each Supported OsEnforced tuple, the existing T3 qualification matrix
and its already hashed `artifactDigests` must include a structured
qualification artifact containing the exact configured six-value profile
limit tuple (`wallTimeMs,stdoutBytes,stderrBytes,processCount,memoryBytes,
cpuTimeMs`), exact operatorConfig revision/digest, and exact provider/version/
capability/OS/profile×network tuple. T3 is valid only if those values exactly
match current operator config and the control evidence proves those exact
limits. The existing manifest digest binds its artifact hash. Any config
limit change requires requalification and a newly operator-issued registry
entry/evidence; do not assume a manifest maxima field, invent an implicit
platform maximum, or add a separate maxima codec. TrustedLocal records limits
for transparency only and has no Supported/T3 status.


Exact deny set pinned by addressClassificationSnapshotId
iana-special-purpose-2025-10-09+sha256:86583d4bbc916863208c3fbb5a75ee3e6500dd12aa4f9bd3a72caaacb4a3da6a:
IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
192.31.196.0/24, 192.52.193.0/24, 192.88.99.0/24, 192.168.0.0/16,
192.175.48.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32.
IPv6: ::/128, ::1/128, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64,
100:0:0:1::/64, 2001::/23, 2001:db8::/32, 2002::/16,
2620:4f:8000::/48, 3fff::/20, 5f00::/16, fc00::/7, fe80::/10,
ff00::/8. IPv4-mapped IPv6 is excluded from the IPv6 list; normalize it to
IPv4 before the IPv4 checks. Preserve this deny set even if IANA marks an
individual special-purpose range globally reachable.

### Accepted Windows T3-D D2 manifest signature and currentness

Manual governance accepted `T3D-DG-01` under
`ACCEPT_NATIVE_OS_SANDBOX_WINDOWS_OPERATOR_TRUST_V1`, proposal SHA-256
`EAA9430B87462658D7B475C3D469425C5DB2BE0069A4D51634FD9C7FC3BA2039`.
The Windows production-helper manifest remains an artifact under the existing
operator-issued T3 evidence, not a second provider registry. It contains no
self digest, signer key, signature or `qualificationEvidenceRef`.
`qualification-manifest-v1.sig` is a closed canonical UTF-8 detached sidecar
with `version=1`, `keyId` and one canonical base64 Ed25519 signature. The
signed message is the exact ASCII bytes
`Arbor.WindowsNativeQualificationManifestV1\0` followed by the canonical
manifest UTF-8 bytes. The key is selected only from the current P5-protected
`WindowsNativeOperatorTrustSetV1`, never from the manifest or sidecar.

Verification checks canonical sidecar bytes, the selected DER SPKI SHA-256,
key status and UTC validity, the 64-byte signature and Ed25519 result. It
then checks the manifest SHA-256 against the exact current registry
`qualificationEvidenceRef=blob:sha256:<manifestDigest>`, actual source,
compiler, shipped PE and test/control artifact hashes, exact provider/version/
capability/OS build/profile×network tuple/rule set/configured limits, and the
complete accepted T3 matrix. A valid signature is necessary but does not
alone make a provider Supported. The trust-set revision and current installed
artifact bytes are reloaded/revalidated at capability probe and before effect
admission. Missing, unreadable, ambiguous, expired or revoked keys; signature
or source/high-water drift; wrong OS/build; and key reuse return typed
Unavailable without raw key, path or exception. There is no fallback to an
OS-wide CA store, unsigned hash match or a previous successful probe.

The D1 injected verifier remains a qualification-test seam only. Production
obtains a verifier solely from the current protected V3 trusted source. V2
deployments have no accepted Windows trust anchor and cannot be retroactively
promoted from unsigned evidence. D4 helper execution, D5 filesystem/network/
Stop and D6 independent full T3 review remain separate gates.

### Accepted Windows D2 V3 detached-signature physical codec

Under `ACCEPT_WINDOWS_T3D_D2_V3_PHYSICAL_CONTRACT_V1` (fixed draft SHA-256
`2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`),
the sidecar has exact canonical UTF-8 JSON key order
`version,keyId,signatureBase64`. `version=1`; `keyId` matches the P5 trust-set
grammar; `signatureBase64` is strict padded RFC 4648 base64 that decodes and
re-encodes identically to exactly 64 signature bytes. The signed message is
the exact ASCII domain separator
`Arbor.WindowsNativeQualificationManifestV1\0` followed by the D1 canonical
manifest UTF-8 bytes. The verifier selects only the current P5 V3-protected
Ed25519 DER SPKI key and checks its SHA-256 before verifying. It obtains
current UTC validity from the trusted host clock; missing or invalid current
time is typed `TrustCurrentnessMismatch`. Provider/caller time, unsigned
`signedAt` and file mtime are never signing-time authority.

The D2 V1 physical contract conservatively rejects **every** signature under
a Retiring key, even one that may predate rotation: the accepted sidecar has
no protected signing-time or prior-evidence proof. This explicitly narrows
the earlier permitted Retiring path; a future historical-verification path
requires a separately accepted protected proof. Revoked, expired, future,
unknown and duplicate-key/SPKI cases also fail closed. Key rotation and
revocation advance the protected trust set, V3 bundle/high-water and exact
provider registry/capability revisions after review. Old policy revisions,
sidecars or cached-green capability results cannot inherit a new signature;
current source, signer status and installed artifact bytes are rechecked at
both capability probe and P4 effect admission. No signature check alone
creates Supported or starts the production helper.

The cryptographic primitive KAT uses RFC 8032 test key 1 only in tests. Its
canonical Ed25519 DER SPKI hex is
`302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`
and SPKI SHA-256 is
`06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9`.
For the domain separator followed by UTF-8 `{}` (a crypto-only fixture,
**not** a valid T3 manifest), signature base64 is
`hTMSP5sS7dGBuJiY/okX6bv5JiEURnebjrIiBX6snDnc55i85SZWuWCMnMdYM8f2PsWf3Vlefmy9GfzrDUiKBg==`.
The exact canonical sidecar preimage is
`{"version":1,"keyId":"operator-2026-a","signatureBase64":"hTMSP5sS7dGBuJiY/okX6bv5JiEURnebjrIiBX6snDnc55i85SZWuWCMnMdYM8f2PsWf3Vlefmy9GfzrDUiKBg=="}`
with SHA-256
`b705caabef17937aa3606ea4fbaa14be3e8670bb3c9955337e57cd6817fe6977`.
 The test private seed is never a production anchor. The existing D1
canonical manifest KAT SHA-256
`e502199edae3e7b74c9fe6bd9681d727f537585b99d1b5983bbf9b013b4af234`
remains separate and requires a non-test operator key in an actual T3 run.
