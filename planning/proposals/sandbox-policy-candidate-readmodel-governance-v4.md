# Sandbox Policy Candidate Read Model — Fixed Proposal V4

**Status:** FIXED PROPOSAL — awaiting manual governance decision; planning-only
**Supersedes:** `sandbox-policy-candidate-readmodel-governance-v3.md` (V3)
**Decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V4`
**Scope:** Candidate read snapshot, committed TrustedLocal validity boundary,
and P4-derived policy-requirement read seam.

## 1. Decision

Add an optional P10 `WorkspaceDetail` candidate read for an initial sandbox
policy decision or refresh of a committed policy that existing V21 rules mark
stale. The read exposes the exact shared V21 common preconditions and the
closed applicable candidate set. Each `OsEnforced` candidate carries its
current V3 provider-registry pair; `TrustedLocalUnconfinedV1` carries no
provider-registry branch precondition.

Two different validity questions are intentionally kept distinct:

1. **Candidate read and command commit:** the common V21
   `authorityBundleRevision` and `authorityBundleDigest` bind the complete
   validated `SandboxAuthorityBundleV2`. Any full-bundle change, including a
   provider-registry-only update, makes the displayed read and a not-yet-
   committed P1 command stale for either branch. The user rereads and chooses
   from the refreshed list.
2. **Already committed effective policy:** V21's TrustedLocal basis remains
   TrustedLocal's exact effective-policy inputs. A provider-registry-only
   update does not invalidate a committed TrustedLocal policy, does not make
   it `NeedsDecision`, and is ignored by P4's ongoing validity check. This is
   not a TrustedLocal provider dependency. After a new read, the user may
   select TrustedLocal again without a provider-registry branch precondition.

P1 is the command-time CAS owner; P4 is the committed-policy validity owner;
P10 is the candidate read and `NeedsDecision` projection owner. No new wire or
persisted fields are added to distinguish these time scopes.

## 2. Exact existing preconditions and P1 mapping

The existing P10 `sandboxPolicyPreconditions` field is the closed V21
`SandboxPolicyPreconditionsV1` union. Its common fields and exact spellings
are:

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

The OS branch adds `kind: "OsEnforced"`,
`providerRegistryRevision`, and `providerRegistryDigest`. The trusted branch
uses `kind: "TrustedLocalUnconfinedV1"` and omits both registry fields.
Precondition key order, codecs, integer ranges, and digest validation remain
exactly as V21.

P1's existing `DecideSandboxPolicy` payload uses its existing distinct wire
spellings. P13 constructs that payload from the selected candidate and the
shared P10 common fields using this fixed mapping:

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
| OS-only `providerRegistryRevision` | OS-only `expectedProviderRegistryRevision` |
| OS-only `providerRegistryDigest` | OS-only `expectedProviderRegistryDigest` |

The remaining P1 fields keep their V21 contract: exact project/workspace/
execution identity, full canonical episode binding, profile, provider choice
where applicable, closed `networkPolicy`, expiry, and the selected variant.
An OS candidate's `networkMode` selects the supported tuple. The human still
supplies the existing P1 `networkPolicy` whose mode matches; the view does not
invent destinations or add payload fields.

## 3. Candidate DTO

The V21 P10 `sandboxPolicyPreconditions` field is variant-discriminated and
therefore cannot express several alternatives. When the following candidate
view is present, P10 omits that singular field so no candidate appears
preselected. `commonPreconditions` uses exactly the V21 common names from §2;
each candidate supplies only its variant-specific safe tuple:

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

P13 combines `commonPreconditions` with one candidate to construct the
existing P1 variant and payload. For OS it copies
`providerRegistryRevision`/`providerRegistryDigest` to the existing expected
registry fields. For TrustedLocal it uses the exact existing
`TrustedLocalUnconfinedV1` branch and omits registry fields. `candidateId` is
never sent as authority or proof. The read adds no command field or persisted
fact.

Revisions and digest formats retain V21 validation: episode, latest policy,
Workspace, and boundary revisions are nonnegative safe integers;
authority-bundle, operator-config, and OS registry revisions are positive
safe integers; digests are lowercase 64-hex SHA-256. The response contains no
invocation ID, interruption ID, RecoveryBinding JSON, host path, display name,
profile ref/version, qualification evidence ref, or raw provider diagnostic.

## 4. Candidate source and exact identity

P5 supplies only a fully validated immutable V3 `SandboxAuthorityBundleV2`
snapshot and its exact current-host Supported provider tuples. P5's provider
qualification is host-specific and binds the exact
`providerId,providerVersion,capabilityRevision,osFamily,osBuild,profile,
networkMode,networkPolicyCodecVersion,enforcementRuleSetDigest`. P5 does not
filter by Workspace and does not own execution dispatch.

P10 applies the existing Workspace and episode applicability conditions from
the same read snapshot: exact active visible Execution/Episode, canonical
`episodeBinding`, Workspace and ResourceBoundary revisions, and
`sandboxHandleBindingDigest`. It intersects those conditions with P5's exact
current-host Supported tuple set. P10 does not repeat provider qualification,
promote an unsupported tuple, or infer a Cartesian product. Each exact
applicable supported tuple maps to one OS candidate. Identical duplicates
collapse only when every V3 tuple and registry field is byte-identical;
ambiguous or conflicting mappings fail closed. P10 always includes exactly
one TrustedLocal candidate in a successful read.

OS candidate fields are exactly `providerId`, `providerVersion`, `profile`,
`networkMode`, `providerRegistryRevision`, and `providerRegistryDigest`,
plus `kind` and `candidateId`. They contain no host/build metadata, display
labels, profile refs, arbitrary registry fields, or evidence refs.

Order OS candidates by unsigned UTF-8 bytewise tuple
`(providerId,providerVersion,profile,networkMode,providerRegistryRevision,
providerRegistryDigest)` with no Unicode normalization, then place
TrustedLocal last. Source iteration order has no effect.

Every ID, including TrustedLocal, has the exact form `spc2_<64 lowercase
hex>`. Compute:

```text
spc2_ + lowercaseHex(SHA-256(
  UTF8("arbor:sandbox-policy-candidate:v2\0")
  || variantByte
  || lengthPrefixedTuple
))
```

`variantByte` is `0x01` for OsEnforced and `0x02` for
TrustedLocalUnconfinedV1. Each string field is encoded as
`u32be(UTF8 byte length) || UTF8 bytes`; the positive registry revision is
its canonical base-10 ASCII string encoded by the same rule. OS field order
is `providerId,providerVersion,profile,networkMode,
providerRegistryRevision,providerRegistryDigest`. TrustedLocal has no tuple
fields after its variant byte.

TrustedLocal golden vector:

```text
variant:       TrustedLocalUnconfinedV1
preimage hex:  6172626f723a73616e64626f782d706f6c6963792d63616e6469646174653a76320002
candidateId:   spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d
```

The preimage is the exact UTF-8 domain string, one NUL byte, then `0x02`.
Candidate identity is not authorization and does not replace P1 validation.

## 5. Command-time CAS versus committed-policy validity

### 5.1 P1 command-time CAS (both variants)

The shared P10 common preconditions contain the V3 full-bundle
`authorityBundleRevision` and `authorityBundleDigest`. The bundle digest
covers issuer, operator, and provider-registry subobjects. P1 compares the
expected full-bundle revision/digest with its current validated snapshot for
both variants. Any bundle drift after display rejects the outstanding
selection, even if the selected candidate is TrustedLocal. The rejection
uses the existing V21 `StaleSandboxPolicyInputs` contract and the P13 client
rereads; no stale old view is submitted as a fresh choice.

For an OsEnforced command, P1 additionally compares the candidate's exact
registry revision/digest and exact supported provider tuple under the
existing variant-specific command checks. TrustedLocal's payload contains no
registry branch precondition. The common full-bundle CAS still applies at
command time.

### 5.2 P4 ongoing validity of an already committed policy

P4 does not reinterpret the committed V21 result, change its digest, or
rewrite its effective-policy snapshot. The `authorityBundleRevision` and
`authorityBundleDigest` stored in that result remain immutable provenance of
the decision-time validated bundle and continue to be exposed as the V21
committed-decision basis fields.

For ongoing validity, P4 uses the V21 variant-specific effective-policy
dependencies. `TrustedLocalUnconfinedV1` depends on its committed trusted
runtime identity/version, `operatorConfigRevision`/`operatorConfigDigest`,
Workspace/ResourceBoundary/handle basis, exact Execution/Episode, expiry, and
other already-frozen TrustedLocal inputs. Its currentness predicate MUST NOT
compare current provider-registry revision/digest and MUST NOT turn a
provider-registry-only update into `NeedsDecision`. The full bundle pair is
used by P1 as a command-time CAS and retained in the committed result as
provenance; it is not an ongoing provider-independent TrustedLocal runtime
dependency.

The committed TrustedLocal result does not contain a prior provider-registry
subobject revision/digest from which P4 could distinguish the cause of a
changed full-bundle digest. With no new persisted field, this proposal fixes
the time-scoped rule explicitly: the full bundle pair is checked for every
pending P1 command, while an already committed TrustedLocal policy is checked
against its persisted runtime/operator/Workspace/Episode/handle dependencies.
Issuer allowlist and provider-registry changes alone do not alter that
committed runtime basis; an operator-config or other listed runtime-basis
change still does. This is why a read can become stale at command time while
the existing TrustedLocal execution remains valid.

`OsEnforced` retains its V21 provider-specific ongoing dependencies,
including the exact provider-registry revision/digest and qualification
tuple. Provider-registry drift may stale an OsEnforced policy under those
existing checks.

This command-time versus ongoing-policy-time split uses only existing V21
fields and immutable result data. It adds no persisted field and does not
weaken P1's full-bundle CAS. A new candidate read after registry drift carries
the new common full-bundle pair; its TrustedLocal candidate still has no
registry branch fields. If the user submits that refreshed choice, P1 checks
the refreshed full-bundle CAS and commits a new decision. Until then, the
already committed TrustedLocal policy remains valid under §5.2.

## 6. P4 derived requirement read port

P4 `06` owns a new read-only derived port, provisionally named
`SandboxPolicyRequirementReadPort`. It projects the existing exact policy
requirement from an active canonical Execution and a matching P3 Pending
Executable Action, verified against the immutable P4 `RecoveryBindingV1`.
It creates no event, marker, queue row, P1 decision, or other persisted fact.
P10 consumes this port; it never opens P4 private stores or reconstructs the
proof from raw tables.

Closed service/result shape:

```ts
interface SandboxPolicyRequirementReadPortService {
  readonly findPendingByExecution: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
  }) => Effect.Effect<
    Option.Option<SandboxPolicyRequirementV1>,
    SandboxPolicyRequirementReadError,
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

type SandboxPolicyRequirementReadError =
  ToolObservationEvidenceStoreError;
```

This result is an internal verified projection. P10 uses it only to bind the
candidate read to the same Workspace/Execution/Episode and to establish that
the exact pending action still requires a policy. `invocationId`, P3 action
identity fields, and `recoveryBindingDigest` do not appear in the candidate
DTO, P1 command, or public Attention row.

### 6.1 Required source validation

The P4 adapter performs the read under the caller's existing
`TransactionScope`; it does not open a separate transaction. A row is
returned only if all of these conditions hold in that one transaction:

1. The exact `projectId`, `workspaceId`, and `executionId` relation matches;
   canonical Execution is unsettled, not stop-requested, and has the exact
   current `ExecutionEpisodeBinding` and nonnegative safe
   `episode_revision`.
2. There is exactly one matching `tool_invocations` row for that execution;
   it is unsettled, `effect_admission_state = NotAdmitted`, and its workspace,
   tool identity/version, side-effect semantics, canonical argument bytes,
   and resource snapshot match the exact binding. The intent is policy-bearing
   under the frozen P4 predicate: it is `shell`, or has the exact bound
   sandbox profile in its effect attempt / RecoveryBinding. Non-policy-bearing
   tools do not produce a requirement.
3. The same invocation has one immutable `RecoveryBindingV1` with
   `recovery_binding_state = Bound`; P4's existing verifier validates version,
   canonical encoding, SHA-256, and exact invocation identity. The binding's
   `executionId`, `invocationId`, `toolName`, `toolVersion`,
   `sideEffectSemantics`, canonical argument digest, target-resource digest,
   and boundary revision match the current intent/source records. Where the
   attempt has profile fields, they are all-null or complete and match the
   RecoveryBinding's exact profile ID/version/hash/protocol/effect key.
4. The binding identifies exactly one P3 `agent_loop_step_actions` row by
   `executionId`, `logicalActionId`, `actionIndex`, and `callRef`; the action
   is `Pending`, route kind `Executable`, its kind and input hash match the
   P4 intent, and its exact `agent_loop_steps` row is `ActionsInProgress`
   with matching `providerTurnId`, `logicalStepNo`, `repairAttempt`, and
   `next_action_index = actionIndex`.
5. The verified P3 source tuple and active canonical Execution still match at
   the read barrier. No broad `Pending` action, stale episode, terminal or
   stopped execution, `MayHaveStarted` invocation, or unbound legacy row can
   establish this requirement.

The port returns `None` when source state is valid but no exact pending
requirement exists, including terminal/stopped execution, settled invocation,
non-Pending action, or no applicable policy-required action. A missing,
malformed, corrupt, mismatched, duplicate, or ambiguous RecoveryBinding/action
proof is a typed integrity/read failure, never `None`. P4 exposes no raw SQL,
canonical binding JSON, arguments, resolved regions, host paths, or provider
diagnostics.

P10 additionally joins the current P1 decision/result and its existing V21
stale predicate in the same read barrier. It emits `InitialDecision` only
when no current decision exists for this exact active episode. It emits
`RefreshStaleCommittedPolicy` only when the current P1 decision is committed
but existing V21 rules mark it stale. It never treats a P4 provider
unavailable result as a policy requirement, and never infers stale policy
from provider-registry drift for an already committed TrustedLocal policy.

## 7. P10 read barrier and ownership

P10 obtains one validated immutable P5 `SandboxAuthorityBundleV2` snapshot,
opens its existing consistent Workspace Detail read transaction, invokes
`SandboxPolicyRequirementReadPort` within that same `TransactionScope`, and
reads Workspace, ResourceBoundary, current decision/result, and existing
P10 freshness facts from that snapshot. The read is tagged with the current
P10 watermark/lag and honors its existing `FreshnessRequirement`. The P4 port
is a same-transaction proof read, not a second independently timed query.
P10 returns no partial candidate view if the P5 bundle/high-water/integrity
load, exact tuple snapshot, P4 port, or P10 canonical read fails.

Responsibilities are fixed:

| Owner | Responsibility |
|---|---|
| P1 `01` | P1 command-time full-bundle common CAS for both variants, OS-only registry CAS, authority/operator checks, durable decision and stale rejection. |
| P4 `06` | `SandboxPolicyRequirementReadPort` contract and P4 verification of exact P3 Pending Action + immutable RecoveryBinding + active Execution; P4 ongoing effective-policy validity by existing variant-specific basis. |
| P5 `01` and accepted V3 loader | Fully validates and supplies the immutable full `SandboxAuthorityBundleV2`; exact host capability/build tuple snapshot only. It does not dispatch or block work. |
| P10 `05` and current status read owner | Calls only the P4 read port for requirement evidence, joins the canonical read barrier, projects candidates and stale status, and exposes the safe DTO. It does not inspect P4 stores or write facts. |
| P13 `03`/`06` | Requires explicit selection and maps read fields to existing P1 wire fields. No auto-selection or submission. |
| P2/P4/P9 | Retain the existing dispatch, sandbox application, and recovery gates; they gate execution until canonical P1 decision/application permits it. |

No new route, command/wire field, table, migration, persisted policy fact,
Attention source, or dispatch state is added.

## 8. Empty, failure, stale, and terminal behavior

- A fully validated bundle and successful exact current-host tuple lookup with
  zero applicable `Supported` OS tuples returns TrustedLocal only.
- P5 authority bundle/high-water load, codec, digest, child consistency,
  source identity, or authority failure is a typed failure with no candidate.
- Failure to prove the host/capability/build tuple snapshot is a typed failure
  with no candidate; it is not represented as an empty Supported set.
- Invalid or ambiguous P4 Pending Action/RecoveryBinding proof is a typed
  failure with no candidate. Valid terminal, stopped, settled, or non-pending
  source state returns no requirement and therefore no candidate view.
- Any full bundle change after read stales the read and pending P1 command CAS
  for both variants. Refresh is required. This does not by itself stale an
  already committed TrustedLocal effective policy under §5.2.
- Workspace, boundary, episode, handle, operator, or policy revision drift
  invalidates both candidate branches through the existing common preconditions.
- Provider-registry drift invalidates the full candidate read/P1 command CAS;
  it independently invalidates an already committed OsEnforced policy under
  its existing branch basis. It does not invalidate an already committed
  TrustedLocal policy.
- Existing P4/P9 Attention and Workspace status remain authoritative. The
  derived P4 requirement read creates no new Attention fact. The exact P4
  interruption remains internal to eligibility; no ID is added to P1.

## 9. TDD and acceptance evidence

After acceptance and implementation authorization, add failing tests first
and prove:

1. Command-time full-bundle CAS rejects a stale P1 submission for both
   variants after provider-registry-only drift; refreshed TrustedLocal is
   selectable with no provider-registry branch field.
2. A committed TrustedLocal policy remains valid and does not become
   `NeedsDecision` after registry-only drift; P4 uses the existing trusted
   runtime/operator/workspace/episode/handle basis and ignores registry-only
   changes. A committed OsEnforced policy retains its exact provider-registry
   currentness check. The committed V21 effective-policy snapshot bytes and
   digest do not change.
3. Authority-bundle revision/digest and child subobject changes are tested at
   the separate command-time and ongoing-policy-time boundaries: issuer or
   registry changes invalidate a pending command CAS but do not stale an
   already committed TrustedLocal runtime basis; operator-config drift does.
   No new persisted or wire fields are added.
4. P4 port returns a requirement only for one exact active Execution,
   NotAdmitted invocation, verified immutable RecoveryBindingV1, and matching
   P3 Pending Executable Action/ActionsInProgress cursor. Every relation,
   digest, identity, status, cursor, duplicate, corruption, and terminal case
   has a positive/negative fixture.
5. P4 port executes within the existing P10 `TransactionScope`; concurrent
   action/episode changes cannot produce a mixed read. It returns `None` only
   for valid absent/closed/terminal states and typed errors for invalid proof.
6. P10 candidate read uses only this port for requirement evidence, has no
   direct P4-store dependency, includes no invocation/interruption/binding
   identifiers, and returns no candidate on typed dependency/barrier failure.
7. Valid authority with zero Supported host tuples returns TrustedLocal;
   authority/high-water failure or tuple-snapshot failure returns typed error
   and no candidate.
8. TrustedLocal `spc2_` golden vector and OS candidate ID vectors verify exact
   byte encoding; unique mapping tests prove one candidate per exact
   applicable Supported host tuple.
9. P5 supplies a validated snapshot only; P2/P4/P9 retain dispatch and
   recovery gates. No route, command codec, schema, migration, or persisted
   fact is added.

Acceptance authorizes only the exact owner-contract landing package under
manual governance. It does not authorize implementation, release, or provider
qualification.

## 10. Acceptance

If this exact V4 proposal is accepted, record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V4
```

Record the accepted raw SHA-256, decision, owner revisions, and independent
post-landing consistency review before implementation starts.
