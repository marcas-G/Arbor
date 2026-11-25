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
network modes are `Disabled`, `Restricted` and `Enabled`. For an initialized
Linux single-user Workspace, the exact qualified `WorkspaceWrite × Enabled`
baseline is established by Workspace admission and is not a repeated per-Work
human policy choice. Explicit human authority remains required for capability
or boundary expansion, weaker isolation, and sensitive external side effects;
ordinary action approval does not widen the baseline or its network boundary.
If any required control cannot be probed/enforced, the provider is
`Unavailable` and no process starts. Platform adapters report effective


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

## Linux workspace networking V2 governance supplement

Accepted under `ACCEPT_LINUX_WORKSPACE_NETWORK_V2`; proposal SHA-256 `9801a907a540a7ea2ec5a68e2ac197105c4bf5a1b00191c3801e888dded59111`.

This supplement owns only the Linux V2 changes assigned to this document. For V2 it supersedes the conflicting first-release Windows-only, blanket loopback-denial, V1 broker and discovery clauses; V1/Windows/historical evidence retain their original meaning. It creates no Supported result, migration execution, preserved-database upgrade or release claim. Service registration, cross-command service reuse and preview still require their separate exact contract and acceptance; the full product goal is not reduced. DID 1.66 owns the closed technical definitions.

#### 3. 执行和通信边界

- 复用 bubblewrap 的 user/mount/PID/IPC/UTS/network namespaces，以及 systemd
  用户 cgroup 的进程树、内存、CPU、进程数、超时和停止管理。工具链只读；项目
  资源继续来自现有精确 admission/ownership。所有工具使用一致的工作区资源边界。
- 不把整个 HOME、Arbor 数据、主机网络、任意宿主 Unix socket 或模型密钥挂入工作区。
  主机工具环境只按既有名称 allowlist 投影。专用代理通过显式私有 IPC 接入；
  helper 及其固定启动配置属于受信产物，项目不能替换它们。
- 隔离必须覆盖共享挂载中的 pathname socket 及 namespace/进程逃逸路径；不能只
  测 abstract socket 或把只读挂载等同于禁止 socket 连接。可复用成熟 seccomp
  组件限制未授权 socket/namespace 操作；是否采用其他等效控制由工程和证据决定。
  缺少有效控制时不得签发 Supported。
- 工作区运行载体是工程对象，不新增 Agent 或组织实体，不代替 Work/Session。
  载体必须精确绑定 Workspace 和当前资源/策略身份；权限缩窄或停止时按既有
  quiescence 结束失效进程，不能让旧环境继续访问过期挂载。
- 同一工作区的后续命令与服务复用、预览入口是独立必验项。浏览器预览只映射明确
  登记的工作区服务，不透传 Arbor 控制凭据；HTTP 和 WebSocket 指向相同工作区。
  本包不凭网络通道新增永久端口或隐式服务。服务登记/预览的独立合同尚未闭合，
  必须另行闭合后实现；这不阻止本包精确限定的联网命令实现，也不减少总交付目标。

#### 4. 公网通道的精确语义

通道只接受规范 `CONNECT <lowercase-IDNA-DNS-name>:443`，拒绝 IP literal、
userinfo、非规范域名及其他端口。Restricted 检查现有精确 HTTPS origin 清单；
Enabled 允许公共目标；Disabled 不启动外部通道，但同工作区内部 TCP 不因此失效。
Restricted 限制的是代理请求的 CONNECT 目标；不检查加密 TLS 内部的 SNI/Host，
不承诺阻止公共服务器的域名前置或应用层转发。这是相较旧严格域名合同的明确取舍。

受信侧每条连接重新查询全部 A/AAAA；任一答案命中既有冻结特殊地址 deny-set 时
整体拒绝，IPv4-mapped IPv6 先归一化。只选择已验证的 A 记录，以数值 IPv4 拨号，
不让系统重新解析目标，不连接 AAAA、不复用旧已解析路线。没有可用 A、DNS 错误、
地址被拒绝或通道失效均产生可读失败。

HTTP CONNECT 由标准 Node HTTP/net/stream 实现；TLS 字节原样转发，客户端使用
自己的普通受信根验证目标。Arbor 不生成 CA、不关闭证书验证、不声称检查了加密
HTTP 的 Host/方法/正文。HTTPS 跳转由客户端处理，每条新 CONNECT 重新授权；
它不是 broker 内的五跳下载器，也不声明限制了所有客户端的重定向总次数。
未来内置 fetch 的逐跳、大小、来源与取消由其独立工具合同负责。

保留有限建连期限、空闲期限、取消、背压和有界资源使用；停止等待通道及进程树
清理确认。网络可达不等于发布/部署获准，执行审批不自动扩大后续工具能力。

##### 8.2 Command、snapshot、receipt 与内部 process policy

- 新 `OsEnforcedPolicySummaryV2` 等于当前 `OsEnforcedPolicySummaryV1` 的**全部现有
  字段、类型和键序**，仅 version 改为 2，networkBrokerControls 改为上述 V2；kind
  仍为 `OsEnforced`。必须绑定 Linux、linux-bwrap 和精确 V2 registry rule digest。
  旧 `TrustedLocalUnconfinedV1` 不变，不获得 version 2。
- 新 `SandboxPolicyDecisionCommittedInternalV2` 等于 V1 的完整字段和键序，仅
  version=2、effectivePolicySnapshot=上述 V2。原 receipt 的命令身份、指纹、
  时间和单次消费不变；旧命令重放只返回它原来的 V1 结果，不能被重新物化成 V2。
- `DecideSandboxPolicy` schema 2 复用 schema 1 的全部输入字段、精确 authority/
  revision/CAS/选择合同，只允许上述 V2 Linux OsEnforced 分支。schema 1 只能物化
  原 V1；schema 2 不能生成 TrustedLocal。模型不能提交受信规则、控制或资格结果。
  新候选使用显式 policySchemaVersion=2，UI 转发该版本；缺失/未知版本拒绝，
  不从字符串 providerId 猜测版本。
- `SandboxEnvironmentBasisV1` 及其字节保持不变：相同 mounts/authority/registry
  输入仍得到原摘要。完整 effective-policy 摘要含 version 和 V2 controls，结合
  registry 内 V2 rules digest 绑定不同语义；不得用旧 policyDigest 验收新策略。
- 新内部 `OsEnforcedSandboxProcessPolicyV2` 与现有 process policy 具有相同现有
  字段和约束，kind 为 `OsEnforcedProcessPolicyV2`，另含唯一新增字段
  `networkBrokerControls: SandboxNetworkBrokerControlsV2`。它是进程内类型，不是
  新 wire 协议或 durable record。现有 SandboxProcessPort.run 的 request.policy
  扩展为 V1/V2 closed union；V2 adapter 不接受 V1 假冒 V2，反向亦然。
- V2 broker binding 不含 certificatePath，不产生 CA 文件；提供私有 socket、
  固定 relay artifact、端口及 close 生命周期。绑定只在精确隔离执行中使用，
  不从模型输入解析主机路径。旧 V1 binding 与执行分支保持原义。

## 2026-11-16 独立验证命令环境补充

治理修订：`IVE-P4-20261116.1`。负责人已明确接受固定临时副本方案；接受编号
`ACCEPT_INDEPENDENT_VERIFICATION_COMMAND_ENVIRONMENT`。固定提案
`docs/proposals/2026-11-16-independent-verification-command-environment.md`，
SHA-256 `a6e85e9e15301cbc377f3468d5bfca706cf3019e42bc28fe712a1947a0d6108d`。
以下为该提案分配给本文的完整条款；接受与设计落地不等于实现或发行资格。

1. 为上述环境引入明确版本化的独立验证策略/绑定变体，字段绑定精确 Verification、
   execution、目标 Work 修订、owner Workspace、只读取材范围、副本身份/输入摘要、
   当前工作区授权来源、provider 资格、挂载/资源限制、网络策略、有效期和策略修订。
   复用现有主机材料、摘要与精确快照校验；不能让旧 Workspace codec 接受新字面量。
2. source 和临时可写环境分别校验，不把 WorkspaceWrite 对原项目的授权直接赋给
   验证器。受信运行时创建的验证环境仅用于执行 P8 mission；临时写入不形成对原
   资源的新授权，不增加 fs:write/shell:exec/网络能力的上限。
3. provider/实际挂载组合必须经过真实资格检查。现有 WorkspaceWrite × Enabled
   Supported tuple 不能被推导成任意只读/overlay/临时副本组合均已 Supported。
4. P4 保持 intent、真实 InvocationAuthority、effect admission、审批、lease fencing、
   观察、持久输出、停止/恢复。不能绕开 P4 直接 spawn 验证进程，不能把缺失策略
   表达为不存在的 pending request。无法执行必须给出真实未执行结果/可恢复阻断。
5. 历史 Workspace 策略、receipt 和事件字节保持原编解码。新持久表示用独立版本、
   类型约束和可验证来源；迁移如有需要必须同步 upgrader/manifest/维护终态，仍不
   承诺升级保留用户数据库。新变体不得放宽旧版本字段检查。

## 2026-11-20 Workspace default execution capability supplement

Accepted under `ACCEPT_WORKSPACE_DEFAULT_EXECUTION_CAPABILITY`; fixed proposal
`docs/proposals/2026-11-20-workspace-default-execution-capability.md`, SHA-256
`8503d5c2663d3098171c57646b78a8408d5f1a28dc7f3cf3a37f2181fddaed66`.

After qualified Linux environment installation, ordinary Workspace admission
may use the system-created baseline `WorkspaceWrite × Enabled` capability for
the current Workspace boundary. This baseline is not a per-Work human policy
selection and never widens the logical mounts or ownership produced by P4
resource admission. P4 must still materialize the exact current mounts,
provider-qualified process policy and network controls for each Execution.

If the baseline head is absent, revoked, stale or the exact tuple is not
qualified, P4 must not spawn a host process or silently select TrustedLocal or
fake execution. Initialization exposes the repair state before new executable
Work admission; a Work blocked solely for this reason is resumed only through
the explicit same-Work retry contract. Sensitive action approval remains a
separate gate and cannot be supplied by the baseline capability.
