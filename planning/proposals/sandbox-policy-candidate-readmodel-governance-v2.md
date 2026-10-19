# Sandbox Policy Candidate Read Model — V2 (Superseded)

**Status:** SUPERSEDED — historical fixed draft; do not accept or implement
**Replaced by:** `sandbox-policy-candidate-readmodel-governance-v3.md`
**Former decision token:** `ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V2` — invalid
for current governance
**Scope:** Close the first-choice and stale-policy refresh presentation gap
under the already accepted Native Sandbox V21 and Producer Mapping Closure V3.

> V2 failed independent review (B1=2, B2=3). Its registry-drift behavior,
> field inventory, and P5 dispatch ownership are superseded by V3. Retained as
> audit history only; do not use its DTO or token.

## 1. Decision requested

Extend the existing P10 `WorkspaceDetail` response with a human-readable,
closed candidate list for the existing P1 sandbox-policy decision. Return the
existing V21 `sandboxPolicyPreconditions` object once as the shared common
precondition for every candidate. Each `OsEnforced` candidate additionally
carries the exact V21 registry precondition for its supported tuple;
`TrustedLocalUnconfined` carries no registry precondition.

This view is available for an initial decision required by the exact P4 V21
`SandboxPolicyRequiredInterruption`, and for a committed policy that existing
V21 semantics mark stale and require a human to refresh. P1 remains the only
decision writer and performs its existing final CAS, authority/operator, and
provider checks. P13 requires an explicit human choice. The read model never
chooses, grants, commits, or resumes a policy.

## 2. Frozen inputs and explicit bounds

- P4 `06` V21 owns `SandboxPolicyRequiredInterruption` and exact pending
  invocation recovery. P10 may use those facts internally to decide whether
  this conditional view applies; invocation and interruption identities are
  not returned as CAS fields and are never added to the P1 command.
- P10 `05` V21 owns `WorkspaceDetailReq = { workspaceId }`, its existing
  freshness/barrier result, and the existing `sandboxPolicyPreconditions`
  projection.
- P1 `01` V21 owns the existing two wire variants and the complete common
  `sandboxPolicyPreconditions`. `OsEnforced` adds its registry precondition;
  `TrustedLocalUnconfined` has none.
- Producer Mapping Closure V3 is the only source of Supported provider,
  sandbox-profile, and network-mode tuples.
- P13 `03`/`06` may render the existing choice, but must never auto-select,
  auto-submit, or reinterpret failure as consent.

No new route, command or wire field, persistence field, event, table, or
migration is introduced. No accepted V21/V3 semantics are changed.

## 3. DTO and relationship to the existing P1 wire

The response adds one optional view field. The embedded common preconditions
are the exact existing P1 V21 object, with no parallel `cas` object:

```ts
type SandboxPolicyPreconditions = {
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkspaceRevision: Revision;
  readonly expectedResourceBoundaryRevision: Revision;
  readonly expectedEpisodeRevision: Revision;
  readonly expectedPolicyRevision: Revision;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly sandboxHandleDigest: Sha256;
  readonly expectedAuthorityRevision: Revision;
  readonly authorityDigest: Sha256;
  readonly expectedOperatorRevision: Revision;
  readonly operatorDigest: Sha256;
};

type SandboxPolicyCandidateRead = {
  readonly reason: "InitialDecision" | "RefreshStaleCommittedPolicy";
  readonly osCandidatesState: "Current" | "Unavailable";
  readonly candidates: ReadonlyArray<SandboxPolicyCandidate>;
};

type SandboxPolicyCandidate =
  | {
      readonly _tag: "OsEnforced";
      readonly candidateId: string;
      readonly providerId: string;
      readonly providerVersion: string;
      readonly sandboxProfile: "ReadOnly" | "WorkspaceWrite";
      readonly networkMode: SandboxNetworkMode;
      readonly registryPrecondition: {
        readonly expectedRegistryRevision: number; // positive safe integer
        readonly registryDigest: Sha256;
      };
    }
  | {
      readonly _tag: "TrustedLocalUnconfined";
      readonly candidateId: "TrustedLocalUnconfined";
    };

type WorkspaceDetailRes = ExistingWorkspaceDetailRes & {
  readonly sandboxPolicyCandidateRead?: SandboxPolicyCandidateRead;
};
```

`SandboxPolicyPreconditions` above is a field inventory, not a replacement
definition. The landing MUST copy the V21/P1 type and field names byte-for-byte
from the accepted owning contract. If the accepted V21 spelling differs from
the illustrative inventory above, the accepted spelling wins and this proposal
does not authorize a rename or new field. The mandatory set is: expected
episode and policy revisions; exact episode binding; sandbox handle digest;
authority and operator revisions/digests; Workspace identity/revision; and
resource-boundary revision.

The existing top-level P10 `sandboxPolicyPreconditions` projection is retained
as the one common precondition object and is populated from the full accepted
V21/P1 field set for this candidate read. The new `sandboxPolicyCandidateRead`
contains no duplicate precondition object and no parallel `cas`. P13 combines
the existing common object unchanged with the selected existing P1 wire
variant. The selected OS tuple adds only its branch-specific
`registryPrecondition`; the trusted-local variant adds no registry revision or
digest. `candidateId` is never sent as P1 authority or proof.

## 4. Candidate set, identity, and sorting

1. The P5-to-P10 seam supplies a pinned registry/capability snapshot. Include
   only tuples that the current host's exact provider capability and build mark
   `Supported` for this Workspace, episode binding, and sandbox handle. Do not
   project merely compatible provider families, aliases, defaults, or tuples
   supported by another host/build.
2. Each `OsEnforced` candidate contains exactly `providerId`,
   `providerVersion`, the V3 sandbox-profile enum (`ReadOnly` or
   `WorkspaceWrite`), the V3 `networkMode`, and the existing registry revision
   and digest precondition. It contains no display name, profile ref/version,
   host path, build metadata, free-form registry fields, or provider diagnostic.
3. `expectedRegistryRevision` is a positive safe integer and appears only
   inside the `OsEnforced` branch's `registryPrecondition`. `registryDigest`
   also appears only in that branch. The shared V21 common preconditions do
   not gain registry fields.
4. Include exactly one `TrustedLocalUnconfined` candidate in every successful
   candidate read. It has no registry fields. It remains available when the
   registry is empty, unavailable, or has drifted, provided the shared V21
   common preconditions still match. This existing explicit human choice is
   never a default or automatic fallback.
5. Sort OS candidates by the bytewise UTF-8 tuple
   `(providerId, providerVersion, sandboxProfile, networkMode,
   expectedRegistryRevision, registryDigest)` and place
   `TrustedLocalUnconfined` last. Strings are compared as their exact UTF-8
   bytes without Unicode normalization; the profile/network enums use their
   literal UTF-8 values. Deduplicate only exact equality of the full canonical
   tuple. If an identical tuple has conflicting metadata, fail the OS
   enumeration closed and retain the trusted-local candidate.
6. Define `candidateId` with this exact encoding:
   `spc2_` + lowercase hex of
   `SHA-256(UTF8("arbor:sandbox-policy-candidate:v2\0") || tupleBytes)`.
   `tupleBytes` begins with one variant byte (`0x01` for `OsEnforced`, `0x02`
   for `TrustedLocalUnconfined`). Each string field is encoded as
   `u32be(byteLength) || UTF8(field)` in the fixed order below. The OS variant
   then encodes `expectedRegistryRevision` as its canonical base-10 ASCII
   representation, itself length-prefixed by `u32be`; the trusted variant has
   no further fields.

   ```text
   OsEnforced: providerId, providerVersion, sandboxProfile, networkMode,
               expectedRegistryRevision, registryDigest
   TrustedLocalUnconfined: (no fields)
   ```

   Length is the number of UTF-8 bytes; integer lengths use unsigned 32-bit
   big-endian encoding. This ID identifies a displayed candidate only; P1
   recomputes eligibility from the actual wire variant and current state.

## 5. P5 registry to P10 read barrier

P5 owns the read-only seam from the current host's exact capability/build
registry to P10. The seam returns one immutable snapshot containing the
registry revision, digest, and exact Supported tuples applicable to the
queried Workspace/episode/handle. P10 reads that snapshot once, then derives
the canonical Workspace, boundary, episode, handle, authority/operator,
decision, and P4 interruption facts in one consistent database read snapshot.
The response is tagged with the existing outer P10 query watermark/lag and
freshness-barrier result. It must not claim that the registry revision is a
journal watermark or that the two storage sources share a transaction.

Every returned candidate is therefore bound to one pinned P5 registry
snapshot and one coherent P10 canonical snapshot. P1 rechecks the existing
common V21 preconditions and the selected provider's registry precondition at
write time. The exact invocation/interruption is used only by P10's internal
eligibility predicate; P1's existing CAS and decision semantics remain the
final gate.

## 6. Initial decision, refresh, drift, stale, and error behavior

- For an initial choice, include the view only when P10's same canonical
  snapshot shows no committed SandboxPolicyDecision and the exact pending P4
  invocation is blocked by the matching V21 interruption.
- For refresh, include the same view when the same canonical snapshot shows a
  committed SandboxPolicyDecision that existing V21 rules mark stale and
  require a human to replace. Set `reason: "RefreshStaleCommittedPolicy"`
  and bind `expectedPolicyRevision` to that committed revision. Do not infer
  staleness from registry drift in the query layer; use the existing V21 stale
  predicate and P5/P1 source of truth.
- If a provider registry changes after the read, only `OsEnforced` candidates
  bound to the prior registry revision/digest become stale. P1 rejects that OS
  selection under its existing registry-precondition failure. The UI rereads
  and replaces the OS candidates. The `TrustedLocalUnconfined` candidate
  remains usable if all common V21 preconditions still match; registry drift
  does not invalidate or add a registry requirement to that variant.
- If P5 cannot supply a valid current registry snapshot, return
  `osCandidatesState: "Unavailable"`, no OS candidates, and the single
  TrustedLocal candidate. Do not describe this as an empty supported set. The
  trusted-local choice remains subject to P1's common CAS/authority checks.
- A P10 freshness miss or inconsistent canonical Workspace/episode/handle/
  authority/operator snapshot follows the existing typed stale/error contract
  and returns no partial view. A changed common precondition invalidates both
  variants; the client must reread before either can be submitted.
- Candidate reading adds no Attention source, severity, status, or governance
  mutation. The existing P4 interruption/attention remains in force for the
  initial case. A stale committed policy retains its existing stale/attention
  status. Neither view changes Workspace lifecycle or P5 current-work
  selection.

On every successful candidate read, the existing trusted-local variant is
present. Registry enumeration errors are represented only by
`osCandidatesState`, which does not disable that variant.

## 7. Ownership

| Owner | Contract responsibility |
|---|---|
| P4 `06` V21 | Owns interruption and exact pending invocation; those identities remain internal to read eligibility and do not become command CAS fields. |
| P5 | Owns exact host capability/build registry snapshot and its read-only seam to P10; keeps execution dispatch blocked until canonical P1 decision is valid. |
| P10 `05` and `03` | Owns the additive `WorkspaceDetail` field, reuse of exact common preconditions, coherent canonical read snapshot, freshness behavior, and redacted candidate projection. |
| Producer Mapping Closure V3 owner | Owns the existing Supported tuple mapping and enum meanings; no tuple expansion or display metadata is authorized. |
| P13 `03`/`06` | Owns explicit rendering and human selection; no auto-selection, submission, timeout consent, or registry-error fallback. |
| P1 `01` V21 | Owns existing wire variants, common preconditions, final CAS/authority/operator/provider checks, and durable commit, including stale-policy refresh. |

No ownership moves between phases. P10 cannot authorize execution or write a
decision. P13 uses the existing route and command. P5 does not choose a policy.

## 8. TDD and acceptance evidence required after acceptance

The authorized implementation plan must start with failing tests and prove:

1. Initial decision view requires the exact internal P4 interruption/pending
   invocation and no committed decision; its external DTO contains none of
   their IDs. A stale committed decision yields the same view with the refresh
   reason and its exact `expectedPolicyRevision`.
2. Every candidate read returns the exact accepted V21 common
   `sandboxPolicyPreconditions` field set and values from one canonical
   snapshot; both wire variants reuse it unchanged. No second CAS object,
   invocation ID, interruption ID, or new P1 field is emitted.
3. P5 current-host exact capability/build filtering excludes unsupported or
   other-host tuples; projected OS fields exactly match V3/P1 enums and safe
   fields. Ordering, exact deduplication, and the v2 candidateId byte encoding
   have golden tests.
4. OS registry revision is a positive safe integer and revision/digest occur
   only on OS candidates. TrustedLocal has no registry fields.
5. Empty, unavailable, and drifted registries preserve the TrustedLocal
   candidate. Drift makes only old OS candidates fail P1's existing registry
   CAS; common-precondition drift invalidates both variants.
6. P1 accepts an unchanged exact OS or trusted-local selection only after
   rechecking the existing common preconditions, authority/operator, and (for
   OS only) exact current provider tuple and registry revision/digest. A stale
   committed-policy refresh follows the same final gate and cannot overwrite a
   newer policy revision.
7. P13 requires deliberate selection and has no auto-submit/fallback. P5 does
   not dispatch until P1's canonical decision is valid.
8. Redaction, P10 barrier failures, Attention/status stability, and no-route /
   no-schema-migration constraints are covered by focused contract tests.

Acceptance of this proposal authorizes only landing the accepted owning
contract package under the manual governance process. It does not authorize
runtime implementation; that still requires the explicit applicable phase
authorization.

## 9. Acceptance

If this exact fixed proposal is accepted, record:

```text
ACCEPT_SANDBOX_POLICY_CANDIDATE_READMODEL_V2
```

Record the accepted raw SHA-256, decision, owning-document revisions, and
post-landing consistency review before implementation starts.
