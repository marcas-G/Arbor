# Sandbox Policy Candidate Read Model — Fixed Proposal V5

**Status:** FIXED PROPOSAL — awaiting manual governance decision; planning-only
**Supersedes:** `sandbox-policy-candidate-readmodel-governance-v4.md` (V4)
**Decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V5`
**Scope:** Candidate read closure and explicit full-authority-bundle
currentness for all committed sandbox-policy variants.

## 1. Explicit semantic revision

For every new P1 sandbox-policy command and every already committed policy,
the V3 full `SandboxAuthorityBundleV2` `authorityBundleRevision` and
`authorityBundleDigest` are currentness basis, including for
`TrustedLocalUnconfinedV1`. Any V2 bundle child change advances the bundle
revision/digest under the accepted V3 rules. It makes an outstanding candidate
read and P1 command CAS stale; it also makes an already committed TrustedLocal
policy stale. When the exact active Execution next requires the policy, P4
blocks the pending P3 action using the existing
`SandboxPolicyRequiredInterruption`; P10 reports `NeedsDecision`, and a human
must make a fresh explicit choice.

This explicitly supersedes the accepted V21 statement in P4 `05` that
provider-registry changes cannot stale TrustedLocal. The replacement is
deliberately conservative: the existing full-bundle fields already occur in
both committed policy snapshots and the common P1 preconditions, so no new
digest, precondition, persisted field, or migration is needed to distinguish
the bundle version. A registry-only change still stales the full bundle basis
for TrustedLocal, even though TrustedLocal has no OS provider tuple and no
provider-registry branch precondition.

The availability cost is explicit: an operator update to any bundle child,
including a provider registry entry irrelevant to TrustedLocal, can pause
active sandboxed Work until a human reapproves its current policy. This
invalidation does not widen authority, ResourceBoundary, tool capability, or
provider support. TrustedLocal retains its existing unconfined semantics and
does not gain an OS-provider dependency.

## 2. Ownership and accepted-contract replacement

Acceptance of this exact proposal authorizes the following owner landing; it
does not itself modify frozen design files:

| Owner | V5 responsibility |
|---|---|
| P4 `05` | Owns the effective-policy currentness rule. Recompute/compare the existing V21 `SandboxEnvironmentBasisDigestV1` and full `authorityBundleRevision`/`authorityBundleDigest` for both variants. This owner replaces the V21 registry-drift exclusion for TrustedLocal. |
| P4 `06` | Owns the read-only `SandboxPolicyRequirementReadPort` contract and exact P4 validation of RecoveryBinding evidence. It consumes P3-owned pending-action state and writes no requirement/attention state. |
| P10 `03` | Owns freshness/currentness projection: a full-bundle mismatch is stale for both variants; `NeedsDecision` remains derived from the exact active episode and policy-required action. |
| P10 `05` | Owns the additive Workspace Detail candidate DTO and read barrier. It reads requirement evidence only through the P4 port. |
| P1 `01` | Owns the existing `DecideSandboxPolicy` command and command-time CAS against the full bundle for both variants; OsEnforced also checks its existing registry branch precondition. |
| P5 `01` / accepted V3 loader | Supplies one fully validated immutable `SandboxAuthorityBundleV2` snapshot. It does not choose policy or gate execution. |
| P13 `03`/`06` | Requires a deliberate human selection after every stale result. It maps the selected existing variant and common preconditions to the current P1 payload. |
| P2/P4/P9 | Keep their existing dispatch, sandbox application, and recovery gates. They do not infer or choose a replacement policy. |

The landing package must explicitly replace the P4 `05` V21 sentence that
provider-registry changes cannot stale TrustedLocal, and align P10 `03`/`05`
and P1 `01` with the rules below. Preserve all other V21/V3 clauses. No new
route, command type, wire field, table, migration, or durable fact is
authorized.

## 3. Exact preconditions and P1 wire mapping

The existing P10 `sandboxPolicyPreconditions` is the closed V21
`SandboxPolicyPreconditionsV1` union. The exact common fields are:

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

The `OsEnforced` branch additionally contains `kind: "OsEnforced"`,
`providerRegistryRevision`, and `providerRegistryDigest`. The
`TrustedLocalUnconfinedV1` branch has its exact kind and no registry fields.
The full bundle CAS is common to both branches through
`authorityBundleRevision`/`authorityBundleDigest`; it does not add those
provider-registry fields to TrustedLocal.

P13 maps the exact P10 fields to existing P1 payload fields as follows:

| P10 read field | Existing P1 payload field |
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
| OsEnforced-only `providerRegistryRevision` | OsEnforced-only `expectedProviderRegistryRevision` |
| OsEnforced-only `providerRegistryDigest` | OsEnforced-only `expectedProviderRegistryDigest` |

These are existing V21 fields, not aliases or additions. All exact V21 codecs,
key ordering, integer bounds, and digest formats remain in force. P1 rejects
stale candidate submissions through its existing `StaleSandboxPolicyInputs`
contract. P1 never accepts a `candidateId` as a CAS value or authority.

## 4. Candidate read DTO

The single V21 `sandboxPolicyPreconditions` union cannot express multiple
choices without selecting a branch. When a candidate read is present, P10
omits that singular field and returns its exact shared common fields once,
beside a closed candidate list:

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
      readonly candidateId: string; // spc2_<64 lowercase SHA-256 hex>
      readonly providerId: string;
      readonly providerVersion: string;
      readonly profile: "ReadOnly" | "WorkspaceWrite";
      readonly networkMode: "Disabled" | "Restricted" | "Enabled";
      readonly providerRegistryRevision: number; // positive safe integer
      readonly providerRegistryDigest: Sha256;
    }
  | {
      readonly kind: "TrustedLocalUnconfinedV1";
      readonly candidateId: string; // same spc2_<64 lowercase SHA-256 hex>
    };

type WorkspaceDetailRes = Omit<
  ExistingWorkspaceDetailRes,
  "sandboxPolicyPreconditions"
> & {
  readonly sandboxPolicyPreconditions?: SandboxPolicyPreconditionsV1; // absent iff candidate read is present
  readonly sandboxPolicyCandidateRead?: SandboxPolicyCandidateReadV1;
};
```

P13 combines the common fields with one candidate and maps it to the existing
P1 command. Only `OsEnforced` carries the P1 expected registry pair.
TrustedLocal carries the current full-bundle common CAS, but no provider
registry branch precondition. Its currentness still changes when that common
bundle pair changes.

The common revisions retain V21 ranges: episode, policy, Workspace and
boundary are nonnegative safe integers; authority-bundle, operator-config,
and OsEnforced registry revisions are positive safe integers. Digests are
lowercase 64-hex SHA-256. The public candidate DTO contains no invocation or
interruption ID, RecoveryBinding JSON, host path, display name, profile
reference/version, qualification evidence ref, or provider diagnostic.

## 5. Candidate set and deterministic identity

P5 supplies only a fully validated immutable V3
`SandboxAuthorityBundleV2` snapshot and the exact current-host Supported
tuples. Provider qualification is limited to the exact V3 host tuple:

```text
providerId, providerVersion, capabilityRevision, osFamily, osBuild,
profile, networkMode, networkPolicyCodecVersion, enforcementRuleSetDigest
```

P10 owns Workspace applicability filtering using the same candidate read
snapshot: exact visible active Execution/Episode, canonical `episodeBinding`,
Workspace and ResourceBoundary revisions, and
`sandboxHandleBindingDigest`. It intersects those existing Workspace facts
with P5's host-qualified tuple set; it does not repeat qualification or infer
a Cartesian product. Each exact applicable Supported host tuple maps to one
OS candidate. Exact duplicates collapse only when every tuple and registry
field is identical; ambiguous/conflicting mappings fail closed. Every
successful read also includes exactly one TrustedLocal candidate.

OS candidates contain only `providerId`, `providerVersion`, `profile`,
`networkMode`, `providerRegistryRevision`, `providerRegistryDigest`, `kind`,
and `candidateId`. The human continues to supply the existing P1
`networkPolicy` with a mode matching the selected tuple; the candidate read
does not invent destinations. TrustedLocal has no provider tuple, registry
field, or provider branch precondition.

Sort OS candidates by unsigned UTF-8 bytewise tuple
`(providerId,providerVersion,profile,networkMode,providerRegistryRevision,
providerRegistryDigest)` with no Unicode normalization; place TrustedLocal
last. IDs use the exact `spc2_` form for every variant:

```text
spc2_ + lowercaseHex(SHA-256(
  UTF8("arbor:sandbox-policy-candidate:v2\0")
  || variantByte
  || ordered length-prefixed tuple
))
```

`variantByte` is `0x01` for `OsEnforced` and `0x02` for
`TrustedLocalUnconfinedV1`. Each string field is
`u32be(UTF8 byte length) || UTF8 bytes`; the positive registry revision is
its canonical base-10 ASCII string under the same length-prefix rule. OS
fields are encoded as
`providerId,providerVersion,profile,networkMode,providerRegistryRevision,
providerRegistryDigest`. TrustedLocal has no tuple fields after its variant
byte. Golden vector:

```text
variant:       TrustedLocalUnconfinedV1
preimage hex:  6172626f723a73616e64626f782d706f6c6963792d63616e6469646174653a76320002
candidateId:   spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d
```

The candidate ID is presentation identity only; P1 validates the existing
wire variant and current facts.

## 6. Currentness and refresh rules

1. **Candidate read and P1 command:** both variants bind the full current V2
   bundle through the existing common `authorityBundleRevision` and
   `authorityBundleDigest`. Any bundle change after read, including registry,
   issuer, or operator subobject change, makes the read and outstanding P1
   command stale. P1 rejects; P13 rereads and requires a new explicit choice.
2. **Committed policy currentness:** every committed policy variant,
   including TrustedLocal, compares the existing committed full-bundle
   revision/digest and `SandboxEnvironmentBasisDigestV1` against the current
   validated V2 bundle under P4 `05`. Any V2 subobject change makes that
   committed policy stale. For TrustedLocal, its existing stored common
   authority-bundle fields cause this invalidation; no provider registry
   fields are added to that variant.
3. **Reapproval:** when P4 detects stale currentness for the exact active
   Execution/Episode, it uses the existing P4
   `SandboxPolicyRequiredInterruption` path and leaves the P3 action pending.
   P10 returns `NeedsDecision` and a refreshed candidate view. A human chooses
   again under the new common bundle pair. P1 commits using the current
   existing command and CAS. The old decision remains immutable history.
4. **Provider branch:** TrustedLocal never requires a provider tuple or the
   OS-only provider-registry precondition at command time. The common full
   bundle CAS is still required. OsEnforced additionally carries and checks
   the exact registry pair and host tuple.
5. **Dispatch:** until the new P1 decision is committed and existing
   application/recovery processing makes it current, existing P2/P4/P9 gates
   keep tool effect admission blocked. P5 supplies the validated snapshot but
   owns no dispatch/block state.

This is a conservative global invalidation rule. It may pause TrustedLocal
Work after an unrelated registry-only update and require human
reconfirmation. It does not increase permissions, broaden a ResourceBoundary,
add an OS capability, or make TrustedLocal confined.

## 7. P4 read-only requirement port

P4 `06` defines a read-only
`SandboxPolicyRequirementReadPort`. It consumes the existing P3-owned
`agent_loop_step_actions` / `agent_loop_steps` pending-action state and
validates the associated P4 invocation and immutable `RecoveryBindingV1`.
P4 does not own P3 action status, create a requirement state, write a marker,
attention fact, event, queue item, or policy decision, or mutate/reconcile the
P3 rows. It provides a proof-bearing read result only. P10 never reads the P3
or P4 private stores directly.

```ts
interface SandboxPolicyRequirementReadPortService {
  readonly findPendingByExecution: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
  }) => Effect.Effect<
    Option.Option<SandboxPolicyRequirementV1>,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

interface SandboxPolicyRequirementV1 {
  readonly _tag: "SandboxPolicyRequirementV1";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly invocationId: ToolInvocationId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: CallRef;
  readonly recoveryBindingDigest: Sha256;
}
```

The result is internal and contains no raw binding JSON, arguments, regions,
host path, or provider diagnostics. P10 uses it only for same-episode
candidate eligibility. Invocation/action/binding identities never enter the
candidate DTO, P1 wire payload, or public Attention row.

The P4 adapter reads within the caller's existing `TransactionScope`; it
opens no independent transaction. Return a value only when the canonical
Execution is exact, active, unsettled and not stop-requested; the exact
invocation is unsettled `NotAdmitted`; the immutable RecoveryBinding verifies
its canonical bytes, SHA-256 and exact intent/resource identity; and exactly
one P3 Action is `Pending`, route `Executable`, with exact action identity,
matching P3 input hash, matching `ActionsInProgress` Step and current action
cursor. The invocation must be policy-bearing under the existing P4 rule
(`shell` or exact sandbox-profile binding). Where an effect attempt has
profile fields, they are all-null or complete and exactly match the binding.

Valid absence, settled/terminal/stopped Execution, settled or
`MayHaveStarted` invocation, non-Pending action, or non-policy-bearing tool
returns `None`. Missing, malformed, mismatched, duplicate, or ambiguous
RecoveryBinding/action evidence is a typed existing P4 read/corruption error,
never `None`. P10 calls this port in the same Workspace Detail read
transaction and freshness barrier. It combines the verified requirement with
the current P1 decision/result and full-bundle currentness; no partial
candidate view is returned on a typed port, authority, tuple, or barrier
failure.

## 8. Owners and landing scope

| Owner | Responsibility |
|---|---|
| P4 `05` | Replace the V21 TrustedLocal registry-drift exclusion with the all-variant full-bundle effective-policy currentness rule and existing basis-digest comparison. |
| P4 `06` | Define the read-only requirement port, exact RecoveryBinding/action validation, and typed read failure; no state writes or P3 state ownership. |
| P10 `03` | Apply full-bundle stale/currentness consistently to both variants and retain existing freshness semantics. |
| P10 `05` | Expose the candidate read, combine the common preconditions with exact choices, and call only the P4 port for requirement evidence. |
| P1 `01` | Keep full-bundle CAS on both existing wire variants, preserve OS-only registry precondition, and reject stale submission under existing typed contract. |
| P5 `01` / accepted V3 loader | Supply the fully validated immutable V2 bundle and current-host tuple snapshot only. |
| P13 `03`/`06` | Require deliberate choice after every stale result; no default, auto-submit, or fallback. |
| P2/P4/P9 | Keep existing execution admission, interruption, application, and recovery gates. |

The accepted owner landing must explicitly record that it supersedes the
P4 `05` V21 clause “Provider registry changes cannot stale TrustedLocal” and
updates dependent P10/P1 wording. No DID-wide vocabulary, new endpoint,
command, schema, migration, or persisted state is part of this proposal.

## 9. Failure, empty tuple, and availability behavior

- A fully validated current V2 bundle with successful exact-host tuple lookup
  and zero applicable Supported OS tuples returns TrustedLocal only.
- P5 authority/high-water/codec/digest/source/child-integrity failure returns
  the existing typed failure and no candidates.
- Failure to establish the exact current-host tuple snapshot returns a typed
  failure and no candidates; it is not an empty supported set.
- P4 requirement proof failure returns a typed failure and no candidates;
  valid closed/terminal/absent source state returns no requirement.
- Full bundle drift stales both candidate variants and every already
  committed policy, including TrustedLocal. A refreshed candidate list still
  offers TrustedLocal without provider registry branch fields.
- Existing P4/P9 Attention and Workspace status remain authoritative. The
  port creates no new Attention source or durable marker.

## 10. TDD and acceptance evidence

After acceptance and implementation authorization, add failing tests first
and prove:

1. Initial no-decision and exact pending P4/P3 requirement yields one coherent
   candidate read with exact V21 common fields; no invocation/interruption
   identifiers are exposed.
2. A committed TrustedLocal decision followed by provider-registry-only full
   V2 bundle drift becomes stale/`NeedsDecision` under the existing full
   authority-bundle basis, just like OsEnforced. No new digest, persisted
   field, or registry branch field is added to TrustedLocal.
3. The stale candidate read exposes the new common bundle revision/digest.
   P1 rejects a submission from the old read; after explicit human
   reapproval, the existing TrustedLocal branch commits with no registry
   precondition.
4. Restart between drift detection and reapproval preserves the stale
   decision, pending action/RecoveryBinding, and `NeedsDecision`; restart
   after reapproval reconstructs the one new current decision without
   duplicate command/event/decision writes or automatic provider execution.
5. Bundle changes to issuer, operator, and provider-registry subobjects each
   advance full revision/digest and stale both committed variants; operator
   config changes still use existing operator currentness validation.
6. P4 port returns only from exact active Execution + NotAdmitted invocation +
   verified immutable RecoveryBinding + matching P3 Pending Executable Action
   and current Step cursor. Missing/corrupt/duplicate/mismatched proof is a
   typed error; valid terminal/stopped/settled/non-pending state is `None`.
7. P4 port is read-only, consumes P3-owned rows, uses the same P10
   `TransactionScope`, and creates no persisted requirement or Attention
   state. P10 reads no P3/P4 private store directly.
8. Empty valid exact-host Supported tuple set returns TrustedLocal; invalid
   bundle or unprovable tuple snapshot returns typed failure and no candidate.
9. Common fields, OS-only registry fields, TrustedLocal `spc2_` golden
   vector, OS candidate tuple ordering/unique mapping, and no display/path/
   diagnostic leakage are covered.
10. P5 only supplies the validated snapshot; P2/P4/P9 keep dispatch blocked
    until existing P1 decision/application semantics allow it. No route,
    command codec, schema, migration, or persisted fact is added.

Acceptance authorizes only the exact owner-contract landing package under
manual governance. It does not authorize implementation, release, or provider
qualification.

## 11. Acceptance

If this exact V5 proposal is accepted, record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V5
```

Record the accepted raw SHA-256, decision, owner revisions, and independent
post-landing consistency review before implementation starts.
