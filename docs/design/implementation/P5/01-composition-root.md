# P5 — 01 Composition Root

**Authority:** DID v1.9 §10.1/§10.4.1, §11 P5, G1/G6.
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox addendum accepted under `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1`.

## 1. Deliverable (G1)

```text
apps/single-workspace/        # minimal runnable composition root
  src/main.ts                 # process entry: build layers, run one workspace loop
  src/composition.ts          # the Layer graph wiring P1–P4
```

- It is a **runnable** composition root (not test-harness-only) but **not** a
  production daemon/CLI (DID v1.9 G1): no auth/UI/ops surface.
- `apps/*` is the Composition Root permitted by DID §10.4.1; it may depend on any
  package/adapter, and production packages never depend on it.

## Accepted Native OS Sandbox composition amendment

P5 composition injects an Execution-scoped policy-bound `SandboxProcessPort`
and the selected provider alongside the existing `SandboxPort`; executors do
not construct providers or choose a weaker fallback. Startup probes required
provider capabilities before an executable spawn. Production defaults to
`WorkspaceWrite` OS enforcement. `TrustedLocal` remains an explicit test/dev
or human-selected compatibility mode and is never chosen after provider
failure.

P5 loads `SandboxPolicyGrantIssuerConfigV1` only from the OS-protected trusted
host/organization deployment source, not Workspace/model input or inherited
process environment. Validate the exact schema and canonical digest at
startup; retain one immutable snapshot per daemon. The source enforces a
durable monotone revision/high-water mark with no rollback/reuse. Missing,
invalid or empty operator configuration disables the policy-authority path.
Configuration change requires a quiesced daemon and restart; P5 records
sanitized source/revision/digest/load audit without secrets. This accepted
addendum is limited to the accepted sandbox/provider and issuer configuration.

## 2. Layer graph

```text
SqliteClient (durable file DB) + ClockLive + IdGeneratorLive
├── TransactionPortLive
├── repositories (Project/Workspace/Work/Session/Execution)
├── CommandStore / DomainEventJournal
├── LeaseService / WorkWaitStore / SchedulerTimerStore / AgentExecutionStateStore
├── ProviderTurnStore / ToolInvocationStore / ArtifactMetadataRepository
├── ProjectEnvironmentPort (environment-local)
├── ProviderPort (provider-fake) + ProviderRuntime
├── ModelContext + ToolDefinitionStore + ToolCatalogPort
├── SandboxPort (sandbox-local) + BlobStorePort (blob-local) + ArtifactService
├── ResourceAdmission + ResourceOwnershipRepository
├── FenceStopCheck + RuntimeSafetyGate + ExecutionScheduler + RunnableWorkSource (02)
├── P2/P3 command handler registry + CommandGateway
└── ExecutionDriverPort (AgentLoopDriverLive) + runExecution orchestration
```

- The durable DB is a **file** path (not `:memory:`) so restart continuity can be
  proven (G5).
- Layers are built once per runtime instance; the same composition function is
  used to reconstruct the runtime on restart.

## 3. Runtime lifecycle

```ts
interface SliceRuntime {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;   // dispose layers / close DB
}
```

- `start` runs migrations, then the single-workspace loop.
- `stop` disposes the layer graph and closes the DB; the durable state remains.
- Restart = `stop` + construct a new `SliceRuntime` against the same DB file
  (P2 owns the recovery mechanism; P5 proves continuity — G5).

### 3.1 Scheduler decision handling (P5-DG-01 resolution)

The slice loop consumes the frozen `ExecutionScheduler` decision table
(DID §8.18A) and never re-decides it. Ownership is split:

- **Selection decision** — which Work should become current / be admitted — is
  owned by the scheduler evaluator (P2; later P7 runnability). The slice only
  reads the returned `SchedulerDecision`.
- **Canonical mutation execution** — applying `SelectCurrentWork` /
  `AdmitExecution` — is owned by the Application command handlers and is
  performed **only** through `CommandGateway`.

```text
decision = scheduler.reevaluate(workspaceId, wakeReason)
if decision is SelectCurrentWork(workId):        # exact evaluator output
    gateway.execute(SelectCurrentWork { workspaceId, workId, expectedRevision })
    decision = scheduler.reevaluate(workspaceId, wakeReason)
if decision is Admit(focus):
    gateway.execute(AdmitExecution { executionId (caller-preallocated), focus })
```

- P5 never chooses the Work itself and never mutates a repository directly.
- `SelectCurrentWork`'s canonical mutation is an **Application** command handler
  (same shape as the P1 commands); P5 provides its first implementation and
  integration. No `setCurrentWorkId` command is introduced. The accepted
  Native OS Sandbox amendment separately adds only `DecideSandboxPolicy` and
  does not alter SelectCurrentWork semantics.
- The mutation runs only after the evaluator returns an exact
  `SelectCurrentWork(workId)`; the loop forwards that `workId` verbatim.
- P6/P7 own the broader governance around current-Work selection and reuse the
  same Application handler.

FT-DG-03 input validation reference: `SelectCurrentWork` retains the exact
payload shape shown at the Application call above. Its composed handler gets
the registered P1 semantic validator for typed internal submissions; it is
not made externally actionable by codec registration and remains System /
scheduler-origin under P13 `02`.

## 4. Provider (G6)

- The composition root wires the deterministic `provider-fake`; CI and P5
  completion must not depend on a live provider.
- A real provider adapter may be selected for optional dogfooding but must not
  gate CI/P5.

## 5. Must Not Decide

- No new subsystem semantics (P5 is integration only).
- No verification/acceptance/CompleteWork wiring (P8).
- No dependency coordination (P7).
- No multi-workspace formation (P6).


## Accepted full-chain Native Sandbox authority/configuration source (V21)

The following V21 SandboxAuthorityBundleV1 codec is retained as immutable
historical input and can be read only by its exact forensic decoder; it no
longer authorizes new sandbox policy decisions after the accepted V3 producer
closure. New decisions use SandboxAuthorityBundleV2 below. P5 still owns the
startup-loaded authority source and immutable snapshots injected into P1/P4.
Bundle JSON is compact canonical UTF-8 (no BOM,
whitespace, trailing newline, unknown/missing/duplicate fields, alternate
encoding, noncanonical strings or integer notation; canonical JCS string/
number rules with the exact schema key order below):

{"version":1,"sourceIdentity":"<canonical opaque ID>","bundleRevision":1,"issuerConfigRevision":1,"issuerConfigDigest":"<64 lowerhex>","issuerConfig":{"version":1,"revision":1,"issuers":["<canonical HumanPrincipal>"]},"providerRegistryRevision":1,"providerRegistryDigest":"<64 lowerhex>","providerRegistry":{"version":1,"revision":1,"entries":[]}}.

bundleDigest is SHA-256 lowerhex of full canonical bundle bytes, not an
in-band self-reference. bundleRevision, issuerConfigRevision and
providerRegistryRevision are positive canonical safe integers and exactly
equal their nested object revisions. Subdigests are SHA-256 of exact canonical embedded
issuer/provider objects; nested revisions equal adjacent bundle revision
fields. The issuer ADT is
SandboxPolicyGrantIssuerConfigV1 has exactly
{"version":1,"revision":1,"issuers":["<canonical HumanPrincipal>"]}; revision is a
positive safe integer; issuers are nonempty, sorted by unsigned UTF-8 bytes,
unique canonical HumanPrincipal IDs. Reject wildcard, empty, non-human,
noncanonical, duplicate, unknown or malformed IDs and any decode/re-encode
mismatch. Config comes only from a stable OS-protected deployment source;
reject writable/untrusted parents, symlink/reparse redirection, source
identity changes, truncation and insecure ACLs before parsing. Workspace,
model, command, inherited environment and provider output are never sources.
No cryptographic signature field or signature-validation step exists in this
contract; trust comes only from protected source identity/OS ACL/reparse
checks and the separate monotone high-water.

SandboxProviderQualificationRegistryV1 is exactly
{"version":1,"revision":1,"entries":[]} (key order version,revision,entries),
with closed entry fields/order
providerId,providerVersion,capabilityRevision,osFamily,osBuild,tuple,status,qualificationEvidenceRef.
The tuple is exactly {"profile":"ReadOnly|WorkspaceWrite","networkMode":"Disabled|Restricted|Enabled","networkPolicyCodecVersion":1,"enforcementRuleSetDigest":"<64 lowercase hex>"}
in that key order; status is Experimental|Unavailable|Supported.
The evidence ref is null only for non-Supported entries; Supported requires
blob:sha256:<64-lowercase-hex> for an operator-issued manifest. Entries sort
strictly/uniquely by canonical UTF-8 tuple
providerId,providerVersion,capabilityRevision,osFamily,osBuild,profile,networkMode,networkPolicyCodecVersion,enforcementRuleSetDigest.
Runtime performs exact lookup only: no independent profile/mode arrays or
implied Cartesian product, wildcard, nearest-version, family-only fallback,
or provider self-assertion. The registry/evidence binds exact OS build,
provider/version/capability revision, profile×networkMode tuple, T3 matrix,
artifact digests, networkPolicyCodecVersion=1 and enforcementRuleSetDigest;
it does not bind decision-specific destinations.


The provider-entry canonical JSON shape is exactly
{"providerId":"<canonical>","providerVersion":"<canonical>","capabilityRevision":1,"osFamily":"Linux|macOS|Windows","osBuild":"<exact build>","tuple":{"profile":"ReadOnly|WorkspaceWrite","networkMode":"Disabled|Restricted|Enabled","networkPolicyCodecVersion":1,"enforcementRuleSetDigest":"<64 lowerhex>"},"status":"Experimental|Unavailable|Supported","qualificationEvidenceRef":null}.
Evidence ref is exactly null or blob:sha256:<64 lowercase hex> and MUST be
non-null for Supported. The provider registry sort key is the exact
length-prefixed UTF-8 tuple stated above; duplicate or unsorted entries
invalidate the whole snapshot.

SandboxAuthorityHighWaterV1 exact canonical JSON key order and shape is
{"version":1,"sourceIdentity":"<opaque ID>","bundleRevision":1,"bundleDigest":"<64 lowerhex>","issuerConfigRevision":1,"issuerConfigDigest":"<64 lowerhex>","providerRegistryRevision":1,"providerRegistryDigest":"<64 lowerhex>"}.
It is a separate OS-protected
monotone object outside replaceable source config and application SQLite.
Initial provisioning and source re-enrollment are operator operations, never
daemon mutation; every source/digest change advances its relevant revision and
preserves previous high-water. Forward revision jumps are allowed only when
the new tuple commits durably. Rollback, same-revision digest reuse/change,
unapproved source replacement or failed write disables policy authority and
Supported providers. Source replacement requires quiesced operator
re-enrollment carrying old high-water forward. No hot reload crosses Resolver/
Gateway; config changes require quiesced restart and one snapshot for both
checks.

The closed load status is Available(validated immutable snapshot) or
Unavailable(SandboxAuthorityLoadErrorV1). Bundle failure disables decisions
and automatic spawn; there is no default issuer or allow-all fallback.

The audit record's occurredAt is required and comes from the same injected
P1 GatewayNow Port; nullable source/revision/digest members are null only
before those values are safely established. No system/provider/caller time is
accepted. SandboxAuthorityLoadErrorV1 is not command or provider failure.
DecideSandboxPolicyCommandRejectionV1 is the separate closed set
MalformedRequest, UnauthorizedActor, GrantMissing, GrantRevoked, GrantExpired,
GrantScopeMismatch, AuthorityUnavailable, SandboxAuthorityUnavailable,
StaleSandboxPolicyInputs, SandboxPolicySummaryTooLarge, ExecutionTerminal,
DecisionExpiryInvalid and ReceiptReplayMismatch. Staleness is only a durable
HTTP 200 TerminalRejected receipt; no 409/Problem. SandboxProviderUnavailable
codes are a third separate P4/P9 algebra and are never used for authority or
command rejections.


Exact closed error/audit ADTs:
SandboxAuthorityLoadErrorV1 is exactly SourceMissing, SourceUnreadable,
SourceAclInvalid, SourceIdentityInvalid, SourceReparseDetected, BundleMalformed,
IssuerConfigMalformed, ProviderRegistryMalformed, CanonicalEncodingInvalid,
DigestMismatch, HighWaterMissing, HighWaterUnreadable, HighWaterCorrupt,
RevisionRollback, RevisionReuseMismatch, SourceReenrollmentRequired and
HighWaterCommitFailed. This ADT contains only source/config/high-water/registry
canonical-load errors, not provider runtime failures. SandboxAuthorityAuditOutcomeV1
is exactly Loaded, Rejected, HighWaterAdvanced, ReenrollmentRequired,
QualificationAccepted or QualificationRejected; detail is exactly
SandboxAuthorityLoadErrorV1|None. The sanitized canonical audit object has
fixed keys version,outcome,detail,sourceIdentity,bundleRevision,bundleDigest,
issuerConfigRevision,issuerConfigDigest,providerRegistryRevision,
providerRegistryDigest,occurredAt; unknown details/raw OS errors never persist.

The separate closed SandboxProviderUnavailableCodeV1 contains exactly
sandbox/probe-interrupted, sandbox/no-exact-supported-tuple,
sandbox/provider-identity-mismatch, sandbox/provider-version-mismatch,
sandbox/capability-revision-mismatch, sandbox/os-build-mismatch,
sandbox/qualification-evidence-mismatch, sandbox/pref64-unknown,
sandbox/broker-control-unavailable, sandbox/os-control-unavailable,
sandbox/resource-limit-unavailable and
sandbox/network-policy-enforcement-unavailable. It excludes pref64-changed,
policy-basis-stale, and all P11 environment/resource basis-changed codes.
These are P4 no-effect outcomes materialized by existing P9 only after actual
provider failure; authority-load and human-command rejections never enter this
fact channel.

## Accepted V3 versioned producer configuration and high-water

P5's current decision-authorizing source is the closed
`SandboxAuthorityBundleV2`. V1 remains byte-for-byte immutable and forensic;
there is no implicit default operator config or V1-to-V2 reinterpretation.
The exact V2 top-level key order is
`version,sourceIdentity,bundleRevision,issuerConfigRevision,
issuerConfigDigest,issuerConfig,operatorConfigRevision,operatorConfigDigest,
operatorConfig,providerRegistryRevision,providerRegistryDigest,
providerRegistry`. Its canonical compact UTF-8 preimage shape is:

```json
{"version":2,"sourceIdentity":"<canonical opaque ID>","bundleRevision":2,"issuerConfigRevision":1,"issuerConfigDigest":"<64 lowerhex>","issuerConfig":{"version":1,"revision":1,"issuers":["<canonical HumanPrincipal>"]},"operatorConfigRevision":1,"operatorConfigDigest":"<64 lowerhex>","operatorConfig":{"version":1,"revision":1,"environmentAllowlist":[],"limitsByProfile":[{"profile":"ReadOnly","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}},{"profile":"WorkspaceWrite","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}},{"profile":"FullAccess","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}}],"trustedLocalRuntimeVersion":"builtin-v1"},"providerRegistryRevision":1,"providerRegistryDigest":"<64 lowerhex>","providerRegistry":{"version":1,"revision":1,"entries":[]}}
```

The placeholders above are documentation notation, not valid source values.
All codecs are closed; UTF-8, no BOM/whitespace/trailing newline, exact key
order, canonical JSON strings and safe integer spelling are required.
Unknown/missing/duplicate fields fail closed. `bundleDigest` is SHA-256 of
the complete exact V2 bundle bytes and is not an in-band member. Issuer,
operator, and provider subdigests are SHA-256 of their exact embedded
canonical subobject bytes. Each adjacent `*Revision` equals that subobject's
revision. Changing any child config requires its own revision and a strictly
increasing `bundleRevision`. If an issuer or provider-registry subobject is
carried forward byte-for-byte unchanged from V1, its V1 child revision/digest
may be retained in the V2 source and matching active V2 high-water. A changed
child must use a strictly increasing child revision and advance the enclosing
bundle revision. The new operator config always has its own explicit positive
revision/digest.

`SandboxOperatorPolicyConfigV1` has exact keys/order
`version,revision,environmentAllowlist,limitsByProfile,
trustedLocalRuntimeVersion`. Its revision is a positive safe integer.
`environmentAllowlist` is a UTF-8-byte-sorted unique subset of names in the
existing frozen `SANDBOX_ENV_ALLOWLIST`, with no values. `limitsByProfile`
contains exactly one entry each, sorted `ReadOnly,WorkspaceWrite,FullAccess`;
each entry is exactly `{profile,limits}` and `limits` has exactly ordered
positive safe integer fields `wallTimeMs,stdoutBytes,stderrBytes,
processCount,memoryBytes,cpuTimeMs`. No unknown profile, limit, duplicate,
zero, overflow, or unbounded value is accepted. In V1 this config's
`trustedLocalRuntimeVersion` MUST equal the exact literal `builtin-v1`; any
future value requires a new accepted governance proposal and codec version.
No caller, provider, workspace, or inherited environment supplies these
fields.

`SandboxAuthorityHighWaterV2` is the closed canonical JSON object with exact
key order and preimage shape:

```json
{"version":2,"sourceIdentity":"<canonical-source-id>","bundleRevision":2,"bundleDigest":"<64-lowerhex>","issuerConfigRevision":1,"issuerConfigDigest":"<64-lowerhex>","operatorConfigRevision":1,"operatorConfigDigest":"<64-lowerhex>","providerRegistryRevision":1,"providerRegistryDigest":"<64-lowerhex>"}
```

The exact key order is
`version,sourceIdentity,bundleRevision,bundleDigest,issuerConfigRevision,
issuerConfigDigest,operatorConfigRevision,operatorConfigDigest,
providerRegistryRevision,providerRegistryDigest`. Placeholders are notation,
not valid values. Bytes are compact canonical UTF-8 with no BOM, whitespace,
trailing newline, unknown/missing/duplicate fields, or alternate integer/
string encodings. All revisions are positive safe integers and all digests
lowercase SHA-256. It remains a protected monotone object outside replaceable
source config and application SQLite.
Forward skips are allowed; rollback and same-revision digest change/reuse
are not. Any changed child digest advances that child's revision and
`bundleRevision`. Current source and protected high-water must exactly agree
for P5 to publish Available.

V1-to-V2 provisioning is an explicit offline operator operation. Preserve
the same V1 source identity unless the existing re-enrollment procedure
explicitly changes it; carry all previously accepted issuer and
provider-registry contents forward without widening them; add an explicit
operator config; and assign `bundleRevision` strictly greater than the old
V1 high-water's bundle revision. The old V1 source bytes remain immutable
historical evidence and are not rewritten in place.

Before replacing the active high-water representation, preserve the exact
old V1 high-water bytes as immutable forensic evidence, separate from the
active high-water input and outside the application database. The V1 bytes
are never copied into the V2 active `bundleRevision` or `bundleDigest` fields
and never authorize a decision after V2 adoption. `SandboxAuthorityHighWaterV2`
is the sole active high-water after adoption, and its `sourceIdentity`,
`bundleRevision`, and `bundleDigest` exactly match the complete V2 source. Its
issuer, operator, and provider-registry revision/digest pairs each exactly
match their embedded V2 subobjects. For issuer or provider-registry contents
carried forward byte-for-byte unchanged, the V2 source and active V2
high-water may retain the corresponding V1 child revision and digest. A
changed child subobject requires its own strictly increasing child revision
and the enclosing V2 `bundleRevision` to advance. The new operator config
has its own explicit positive revision and exact digest. If preservation or
exact source/high-water matching cannot be proven, authority remains
unavailable; do not initialize fresh state or lower/reuse a revision to
recover service.

The V1-to-V2 source/high-water transition is atomic and fail-closed. First
write and durably verify the complete V2 source, including its canonical
bytes and child digests, at a `bundleRevision` strictly greater than the old
V1 high-water value. Until the active V2 high-water is atomically committed,
the old V1 high-water remains intact and the source-ahead or
version-mismatched state disables decisions. Startup MUST NOT authorize from
a V2 source without its exact matching active V2 high-water, or fall back to
the V1 source. Then atomically replace the active high-water with the
complete `SandboxAuthorityHighWaterV2` record, using the exact codec and key
order above and values that exactly match that verified V2 source. Preserve
the old V1 raw high-water bytes separately as immutable forensic evidence;
after this commit, they are forensic-only. A crash before commit leaves the
V1 high-water unchanged, the V2 source ahead, and authority unavailable. A
crash after durable atomic commit leaves the exact verified V2
source/high-water pair active and V1 evidence forensic-only. No V1 bundle,
V1 bundle fields copied into a V2 active record, or defaulted config can
authorize a decision. Rollback to V1 after V2 adoption is forbidden. If
preservation, atomic replacement, durable verification, or exact
source/high-water matching cannot be proven, authority remains unavailable;
the operator MUST NOT initialize fresh state or lower/reuse a revision to
recover service.

V1 authority audit records remain immutable and use the exact V1 decoder.
New authority audit rows use closed `SandboxAuthorityAuditRecordV2` with
exact ordered keys
`version,outcome,detail,sourceIdentity,bundleRevision,bundleDigest,
issuerConfigRevision,issuerConfigDigest,operatorConfigRevision,
operatorConfigDigest,providerRegistryRevision,providerRegistryDigest,
occurredAt`. `version=2`; existing closed outcome/detail enums remain; refs
and revisions are null only when not safely known. Canonical bytes are
compact UTF-8 under the V2 key order; an optional external record digest is
SHA-256 of those exact bytes and is never in-band. The same injected P1
`GatewayNow` supplies `occurredAt`. No raw path, OS exception, provider
diagnostic, user secret, network content, or environment value is audited.

P1/P4 snapshot `authorityBundleRevision/Digest` exactly match the verified V2
bundle; `operatorConfigRevision/Digest` exactly match its adjacent V2 fields
and embedded operator subobject digest; OsEnforced provider-registry fields
match that same V2 registry subobject. TrustedLocal continues to omit
provider-registry and all OS/T3 fields. The V21 P4 snapshot/basis codecs and
vectors are unchanged.

## Accepted Sandbox Policy Candidate Read Model V5 source boundary

P5 exposes to the read-only candidate preparation one fully validated
immutable `SandboxAuthorityBundleV2` snapshot and the exact current-host
Supported tuple set derived from its operator-issued registry/evidence. P5
does not filter Workspace applicability, construct or order candidate DTOs,
select a profile/network policy, read P3/P4 invocation state, or gate
dispatch. P10 performs Workspace/Episode applicability and candidate
projection; P4/06 supplies the proof-bearing pending-requirement read; P1
remains the only human decision command boundary. Provider registry changes
advance the full V2 bundle pair and therefore stale TrustedLocal under the
accepted all-variant currentness rule, even though TrustedLocal has no
provider-registry branch fields.
