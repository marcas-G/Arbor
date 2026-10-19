# P10 — 05 Query Surface, User Actions, Transport Boundary (GQ4/GQ6)

**Authority:** DID v1.13 G4/G6, v1.39 EA-DG-01, §7.2 (ProjectionQueryPort), §10.4.1 (projection-runtime deps domain+ports; api-contracts deps domain), §10.5 (Problem DTO); SD v1.14 §12.5, §13.10; P8 `05` (P14 consume-only); P6 `04` (Steer), P2 `01` (Stop).
**Status:** FROZEN — DID v1.17 D-1 additive read-model successor (TR-WPU-B/C/D).

**FT-DG-02 additive contract amendment (2026-10-08):** `work-detail` is added
as a read-only view. It does not reopen P10 or alter P12 transport ownership.
Audit references: accepted proposal SHA-256
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`; landing
package SHA-256
`266884FC5B8858CA631DC87EFA1EA29B6BFD7265FB93C324F0A5F65FF8C68433`.

## 1. ProjectionQueryPort (signature freeze)

```ts
interface ProjectionQueryPort {
  readonly query: <Req, Res>(view: ViewId, request: Req,
      barrier?: FreshnessRequirement) => Effect<QueryResult<Res>, ProjectionQueryError>;
}
// QueryResult carries { value, watermark, lag } (GQ5); errors use the frozen
// Problem DTO vocabulary (DID §10.5) — stable codes, no message parsing.
```

- DTOs live in `api-contracts` (deps: domain only). ViewId enumeration = `01` §1 must-list.

### Minimal per-view shapes (BLK-3 fix — frozen request/response cores; field-level rendering details are implementation)

```ts
TreeViewReq        = { projectId, depth? }                     → nodes[{workspaceId, parentWorkspaceId|null, name, status, currentWork?, subtreeAttention{attention, actionRequired}, usageSummary? }]
AttentionReq       = { projectId }                             → rows[{source, severity, targetWorkspaceId, dedupKey, summaryRef, occurredAt }]
WorkspaceDetailReq = { workspaceId }                           → { responsibility, boundary, currentWork?, pendingWorks[], executionSummary?, dependencies[], inboxUnconsumed[], verification?, auditTimeline[] }
CurrentWorkReq     = { workspaceId }                           → { workId?, objective, status, revision, activeExecution? } | null
VerificationReq    = { workId }                                → { verificationId?, targetWorkRevision?, verdict?, criteriaResults[], evidenceRefs[], acceptance? }
DependencyReq      = { projectId | workspaceId }               → rows[{dependencyId, consumerWorkId, binding, state, satisfiedBy?}]
TranscriptReq      = { workspaceId, sessionId?, cursor?, limit } → { entries[{kind, summaryRef, at}], nextCursor? }   // first production read path over session_entries
UsageReq           = { projectId, groupBy: "workspace"|"subtree"|"project" } → rows[{workspaceId, tokens, cost, turns }]
InboxViewReq       = { workspaceId }                           → { unconsumed[InboxEntryView] }
WorkDetailReq      = { projectId, workspaceId, workId }        → { workId, projectId, workspaceId, objective, why, completionExpectation, lifecycle, revision, acceptedResult?, blockedEpisode? }
```

`blockedEpisode` is an optional read-only current Work-revision summary with
the source Episode ID and one item per current blocker: blockerId, disposition,
denied action kind/status, typed safe denial category, latest bounded request,
inspectable bounded observation refs and recovery guidance. It is derived
from the canonical WorkBlocker ledger and exact settlement evidence; it never
reconstructs from Plan, Session prose, an old Manual wait or a bare receipt.

For an Executable approval entry, `InboxEntryView` includes a typed
`ExecutableApprovalInboxTarget` projection:

```ts
type InboxEntryView = {
  readonly entryKey: string;
  readonly kind: string;
  readonly summary: string;
  readonly watermark: number;
  readonly target?: ExecutableApprovalInboxTarget;
};

type ExecutableApprovalInboxTarget = {
  readonly kind: "ExecutableApproval";
  readonly approvalId: string;
  readonly revision: number;
  readonly executionId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly validatedArgumentsPreview: string; // bounded, schema-redacted
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly sideEffectSemantics: "ReadOnly" | "Idempotent" | "Reconcilable" | "NonIdempotent";
  readonly expiresAt: string;
  readonly actionDigest: string;
};
```

P10 reads the exact `eap:<approvalId>:<revision>` Inbox key and its proven
`route_kind='Executable'` ActionApproval binding from read-only ports. It
returns no approval target for `cap:` Control entries. `validatedArgumentsPreview`
is derived from validated stored arguments and the versioned tool schema; it
is bounded and redacts schema-designated secrets. The projection must show
enough validated action/target detail to support a human decision; if exact
review cannot be produced, it fails closed and does not present Approve.
This DTO is display data only: it is not authority and cannot be posted back
as an approval binding. P10 writes nothing and does not decide or consume the
Inbox entry.

The additive `AttentionSource` literal `WorkspaceResourceActivationPending`
is owned by P10 `02` and is the only new wire-vocabulary member in this
landing. It adds no request/response fields, ViewId, or transport endpoint.
Its row is `ActionRequired`, targets the root Workspace, and uses the
deterministic key
`resource-activation:${projectId}:${workspaceId}:${resourceBoundaryRevision}`.
`summaryRef` is the fixed path-free text “Project resource activation is
pending; file actions are unavailable.” `occurredAt` is the source intent's
`createdAt`, stable across event redelivery and rebuild.

The accepted AH7-DG-02 contract also surfaces the existing
`ReconciliationEscalated` Attention source through this same `rows[{source,
severity,targetWorkspaceId,dedupKey,summaryRef,occurredAt}]` DTO; it adds no
request/response field, ViewId or endpoint. Its exact mapping is owned by
`02`: `ActionRequired`, `executions.workspace_id`, dedup key
`reconciliation-escalated:<executionId>:<invocationRefsFingerprint>`, and the
fixed path-free summary “An external tool effect could not be verified;
recovery is paused.” Its source remains P9's existing event, not a P10-owned
reconciliation fact.

Accepted AH7-DG-01/P39-P40 compatibility adds exactly one member to the
transport-neutral closed `AttentionSource` union and `ATTENTION_SOURCES`:
`ToolObservationReplayEvidenceFailure`. `AttentionReq`/`rows` gains no field,
ViewId, endpoint or action. Its `summaryRef` is the fixed P10 `02` safe summary;
the P9 `failureCode` remains internal projection detail and is not returned in
the public API/read-model enum or DTO. P10/P12 continue to use the same frozen
transport boundary.

Accepted P41 adds exactly one literal,
`SubmittedDecisionBindingFailure`, to the same closed `AttentionSource` union
and `ATTENTION_SOURCES`. It adds no Attention request/response field, endpoint,
ViewId or action. The source maps to the safe fixed summary in `02`; the P9
failure code and DecisionEpisode/provider binding identifiers remain internal.
The exact accepted proposal SHA-256 is
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`.

P10's source-specific activation Attention projection store atomically
reconciles this key set from the current P1 intent table, lists/replaces the
project's Pending rows during rebuild, and resets this source for the project.
P1 status events are wakeups only; the handler uses current table state rather
than event payload status. Reconciliation writes share one P1
`TransactionScope` with the intent snapshot and P10 source rows; the P12
maintenance call does not read, reset, or advance the shared P1 event-consumer
offset. P12 post-commit and startup hooks call this same source-specific
reconciler, which remains usable when the generic P1 rebuild reports
`ConsumerRebuildRefused`. P10 reads only P1 intent identity/status/timestamps,
never boundary addresses, Profile ref/version, or activation failure details.

`acceptedResult` is exactly `{ acceptanceId, verificationId, targetWorkRevision,
verdict: Pass, actor, acceptedAt }`. It is present only when a canonical
Acceptance is bound to that Work revision and its exact concluded PASS
Verification. For `Completed`, absent or inconsistent binding is a typed
projection-integrity failure. `Open` with a bound accepted result remains
Open; `Cancelled` remains canonical Cancelled and preserves Acceptance only as
history. The Work Detail view does not change `current-work` or
`workspace-detail.pendingWorks`.

For `VerificationReq`, when an Acceptance exists for the current Work revision,
select only its bound Verification; otherwise retain the existing selection
rule. `WorkDetailReq` for an absent Work or a Work outside the requested
project/workspace returns a `ProjectionQueryError` branch with code
`projection/work-not-found`, category `not-found`, and non-retryable
disposition. Both cases use identical safe details, containing no target
identity or existence signal; the public response is HTTP 404 for either case.
Malformed request shapes remain `projection/invalid-request`. These are
read-model semantics under P10; P12 continues to own and forward the transport.

Every response carries `{ watermark, lag }` (§1 signature). Shapes are the contract; row limits/cursors beyond Transcript's are transport concerns (P12).

> **DID v1.17 D-1 (TR-WPU-B/C/D).** `parentWorkspaceId` is the direct server-projected
> canonical edge: exactly one returned Tree node has `null`; every non-null parent exists in the
> response; parent pointers are acyclic; row order remains root-first deterministic preorder.
> Invalid hierarchy input is a typed projection failure, never browser repair. A present
> `currentWork` has canonical `status` and `revision`; absent Tree work omits `currentWork`.
> `CurrentWorkSummary.revision` is exactly canonical `Work.revision`. A selected Verification
> emits `verificationId` and `targetWorkRevision` as an inseparable frozen identity pair; an
> empty view omits both. Existing ordered/list clients may ignore these additive members.

> **P12 TR-5 propagation (P12 `04` §3.2/§5; DID v1.14 G4).** The `UsageReq`
> row `cost` field is the P12 `UsageCost` ADT (`Known` | `Unknown`), not a
> hardcoded `0`; **unknown cost stays `Unknown`, never `0`**. P10 renders the
> field (observe-only, invariant 45); cost derivation and versioned pricing are
> P12-owned and do not change P10 view semantics.
- projection-runtime package deps stay `domain, ports` (DID §10.4.1); it never participates in authority (§10.4 hard rule).

## 2. User-action surfaces (SD §12.5 four verbs; UI only issues Commands)

For the derived `VerifierOrphan` Attention, P8 `RetryVerification` is the only
new action. The UI exposes it only after exact authenticated-human authority
resolution for Root-local human governance or the Work's direct Parent
Workspace human. It submits the exact Work, Verification and expected Work
revision through the existing `/commands` envelope; it never posts a
client-authored authority or BlobRef. The action is not a projection write or
Attention dismissal. The UI reports the old row cleared only after the
existing freshness barrier confirms catch-up; the `Unknown(Orphaned)` verdict
remains visible.

| Verb | Surface | Backing command (existing, unchanged) |
|---|---|---|
| Query | **message-mediated** (BLK-2 fix): the surface submits a Query **Message** to the target workspace (P6 channel); the workspace's cognition side spawns the P14 Execution-bound query execution (P8 `05` read-only program; result = Message/Inbox back-flow). Direct external AdmitExecution stays resolver-gated exactly like Stop (GQ4 scope: external AdmitExecution/Stop both await the P12 resolver — P2 `01` §2 wording; P10 never calls it directly) | SendMessage (query request) → workspace-side AdmitExecution(ExecutionBound) + SendMessage (result) |
| Steer | steer request surface | SteerWork (P6 `04`; severity Normal/Critical; human principal) |
| Stop | stop request/control surface | StopExecution (P2) — **P10 exposes the request only; trusted-authority resolution is P12 (GQ4 inherited clarification)** |
| Governance Change | entry presentation over existing governance commands | formation approval, accept outcome, withdraw/mark-unfulfillable, etc. |

- All surfaces submit via `CommandGateway`; none write storage directly (SD §13.10).
- Stop requests from the P10 surface carry a human principal identifier and are submitted exactly like any external command — P2 validates trusted Stop authority as frozen; no resolver is implemented here.

## 3. P10/P12 transport boundary (GQ6)

```text
P10 owns : programmatic projection/query + UI-facing view semantics
           (this contract set; acceptance is test-driven)
P12 owns : HTTP/WebSocket/CLI/web shell/auth/deployment transports —
           they RENDER the api-contracts DTOs and FORWARD commands;
           they must not reinterpret view semantics
```

- apps/web (DID §10.1) remains unbuilt in P10; P10 delivers the `api-contracts` package as the transport-neutral contract surface P12 binds to.

## Accepted Native OS Sandbox public projection

The earlier V5 single-shape example is superseded by the final V1–V21 closed
OsEnforced/TrustedLocalUnconfined union in the V21 section below. Retain the
existing POST Workspace Detail route/request, no new ViewId/Problem category,
and P12-only transport boundary. The final status set is Committed,
Unavailable and NeedsDecision; it never infers defaults and never exposes
mount/target refs, digests, paths, environment values, provider diagnostics or
configuration secrets. Actual provider failure after P4 outcome but before
P9 fact commit uses the exact safe V21 transient 503; after P9 commit the view
is HTTP 200 with Unavailable/Attention. Ordinary projection lag is not this
provider-specific 503.

## 4. Must Not Decide

- No transport protocol/auth choices; no P2 runtime-semantics change; no resolver implementation; no P14 program redefinition (P8 owns; consume only — v1.11 G6).

## Accepted V21 AttentionSource API literal

The transport-neutral closed `AttentionSource` union includes the
non-persisted literal `SandboxRecoveryBindingFailure`. It is a pure P10 query
projection from existing P4 invocation/binding rows; it adds no endpoint,
request field, Problem category, persisted enum, event, marker, or migration.
The public row uses the exact V21 fixed safe summary, canonical Execution
Workspace target, `attentionFactId` dedup, and `occurredAt=intent_at`. Corrupt
hash-format or timestamp values fail closed through the existing corruption
Problem path without a derived row. P12 only transports the existing DTO.


## Accepted full-chain SandboxPolicy DTO/freshness/read-barrier contract (V21)

Keep the existing POST /views/workspace-detail and WorkspaceDetailReq={workspaceId};
no GET route, endpoint, ViewId or Problem category is added. Only an authorized
human with an exact visible active Execution/Episode receives the optional
sandboxPolicyPreconditions. It is one coherent P10 read-barrier snapshot and
contains exactly expectedEpisodeRevision (nonnegative integer sourced from
executions.episode_revision), latestCommittedPolicyRevision (0 only if never
committed; expired/superseded latest still returned), full canonical
episodeBinding, workspaceRevision/resourceBoundaryRevision (nonnegative
integers), sandboxHandleBindingDigest (lowercase 64-hex),
authorityBundleRevision/digest and operatorConfigRevision/digest (positive
revisions, lowercase 64-hex digests). Its OsEnforced variant adds
providerRegistryRevision and providerRegistryDigest; TrustedLocal omits both.
No environment revision/fingerprint or raw evidence ref is included. The
object is only returned to an authorized human with exact active visible
Execution/Episode; otherwise it is omitted or existing query fails closed.

sandboxPolicy is a closed union with status Committed, Unavailable or
NeedsDecision. The public OsEnforced summary fields, in exact order, are kind,
profile ReadOnly|WorkspaceWrite, providerId, providerVersion, networkMode,
policyRevision, expiresAt, status. The public TrustedLocalUnconfined summary
fields, in exact order, are kind, profile=FullAccess, networkBoundary=Unconfined,
policyRevision, expiresAt, status; it has no providerId/version, OS, T3 or
networkMode fields and makes no isolation claim. The public committed receipt
view uses the same two safe variant projections. Neither view contains mounts,
target refs, digests, audit refs, paths, env values or policy destinations.
NeedsDecision is only for a policy-required pending invocation whose exact
current decision/basis is absent or stale;
Unavailable is only for a matching current provider-unavailable P9 fact or
its exact transient P4 terminal outcome. Policy stale is not a provider fact.

P10's SandboxPolicyStatusViewPort reads current P1 decision/command result,
P9 fact/queue and, only for the short pre-materialization window, P4's explicit
read-only P4SandboxOutcomeReadPort in one read transaction/effective-facts
barrier. P10 never opens P4 private stores. Exact current terminal provider
unavailable outcome + matching current decision/active Execution + no
committed P9 fact/queue yet yields HTTP 503 on that existing POST, with the
full Problem DTO fields correlationId (request/transport correlation or null),
code sandbox/provider-unavailable, category unavailable, fixed safe message,
retryDisposition retryable, and safeDetails exactly executionId,workspaceId,
policyRevision. Full Problem member order is correlationId,code,category,
message,retryDisposition,safeDetails; safeDetails order is executionId,
workspaceId,policyRevision. Correlation is the request/transport value or
null. Canonical response fields and exact safe message are:
{"correlationId":null,"code":"sandbox/provider-unavailable","category":"unavailable","message":"required sandbox capability was unavailable or could not be verified; execution did not start","retryDisposition":"retryable","safeDetails":{"executionId":"<ExecutionId>","workspaceId":"<WorkspaceId>","policyRevision":1}}.
No provider/path/env/target diagnostics are allowed. This 503
applies to every exact current terminal SandboxProviderUnavailable outcome
before matching P9 fact/queue commit, not only probe-interrupted. After P9
fact/queue commit the same endpoint returns HTTP 200, Unavailable and the
existing ActionRequired Attention. Ordinary projection lag, missing decision,
authority/config rejection, stale policy and NeedsDecision are never this 503;
ordinary lag uses the existing generic lag behavior. Web waits for existing
WebSocket invalidation or explicit manual refetch and performs no timer,
polling or automatic retry.

## Accepted candidate-read-model V5 Workspace Detail contract (V6 digest correction)

Keep the existing POST `/views/workspace-detail` and request body
`WorkspaceDetailReq={workspaceId}`. V5 adds no route, ViewId, command, wire
precondition, event, table, or migration. The existing closed
`sandboxPolicyPreconditions` V21 union remains unchanged and is present only
when no candidate read is present.

When an authorized human reads an exact visible active Execution/Episode
whose P4-proven pending policy requirement needs an initial or refreshed
choice, return `sandboxPolicyCandidateRead` and omit the singular
`sandboxPolicyPreconditions`. Both are optional on the existing response;
candidate and precondition fields are not returned without view authority.
Candidate reads are read-only and ephemeral. Use this exact closed DTO:

```ts
type SandboxPolicyCandidateReadV1 = {
  readonly reason: "InitialDecision" | "RefreshStaleCommittedPolicy";
  readonly commonPreconditions: {
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly episodeBinding: ExecutionEpisodeBinding;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
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
      readonly sandboxHandleBindingDigest: Sha256;
      readonly providerId: string;
      readonly providerVersion: string;
      readonly profile: "ReadOnly" | "WorkspaceWrite";
      readonly networkMode: "Disabled" | "Restricted" | "Enabled";
      readonly providerRegistryRevision: number;
      readonly providerRegistryDigest: Sha256;
    }
  | {
      readonly kind: "TrustedLocalUnconfinedV1";
      readonly candidateId: string;
      readonly sandboxHandleBindingDigest: Sha256; // FullAccess projection
    };

type WorkspaceDetailRes = Omit<
  ExistingWorkspaceDetailRes,
  "sandboxPolicyPreconditions"
> & {
  readonly sandboxPolicyPreconditions?: SandboxPolicyPreconditionsV1;
  readonly sandboxPolicyCandidateRead?: SandboxPolicyCandidateReadV1;
};
```

The common revisions use existing V21 ranges: episode, latest committed
policy, Workspace and ResourceBoundary revisions are nonnegative safe
integers (latest policy is zero only when no decision exists); authority-bundle
and operator-config revisions are positive safe integers; all digests are
lowercase 64-hex SHA-256. Each candidate carries its own profile-specific
`sandboxHandleBindingDigest` immediately after `candidateId` in serialized
key order. An OsEnforced candidate has the exact positive
registry revision/digest pair; TrustedLocal has no registry branch fields.
The full authority-bundle pair is common and current for both variants.

P5 supplies one verified immutable SandboxAuthorityBundleV2 and the exact
current-host Supported tuple set. P10 filters those tuples for the exact
current Workspace/Episode/boundary basis; it does not requalify a
provider or infer a Cartesian product. Each exact applicable tuple yields one
OsEnforced candidate and the list contains exactly one TrustedLocal
candidate. Sort OsEnforced candidates by unsigned UTF-8 bytewise tuple
`providerId,providerVersion,profile,networkMode,providerRegistryRevision,
providerRegistryDigest` with no Unicode normalization, then place TrustedLocal
last. Exact duplicates collapse only when every tuple and registry field is
identical; conflicting mappings fail closed. The OS candidate carries no
destinations or qualification evidence ref; the human still supplies the
existing NetworkPolicyV1 in the P1 command. Candidate identity is presentation
only and is not a P1 CAS value or authority. The candidate digest is an opaque
CAS value in this human-only view; it discloses no mounts, target refs, paths,
claims, or ownership regions. Existing summary, receipt and Attention
redaction is unchanged.

P10 obtains a same-transaction proof result from P4's read-only
`SandboxPolicyRequirementReadPort` in P4/06. The port validates the exact
pending P3 action, active Execution, NotAdmitted invocation and immutable
RecoveryBinding; P10 MUST NOT read P3/P4 private stores directly. P10 combines
that result with the exact current P1 decision/result, P5 full bundle,
Workspace/boundary refs and existing freshness barrier. Under that same P10
read transaction, the P11 read seam supplies the complete current
ResourceBoundary and exact active Workspace ResourceOwnership facts. For every
offered candidate P10 projects those same facts with its profile through the
existing P4 `05` canonical full-boundary producer and computes the exact
`SandboxHandleBindingDigestV1` of the derived mounts and access. ReadOnly is
all ReadOnly; WorkspaceWrite grants ReadWrite only on exact active owned
regions; TrustedLocal FullAccess has logical ReadWrite mounts without an OS
isolation claim. P10 never uses the pending tool target, caller subset, stale
committed policy, or synthetic neutral handle as the digest source, and never
opens P11/P4 private stores or a second inconsistent snapshot. Candidate
digests may coincide when the derived mounts and access coincide. If the P4
port, authority source, exact-host tuple snapshot, barrier, or full-boundary/
ownership projection is missing, corrupt, ambiguous or unprovable, return the
typed error/lag outcome and no partial candidate list. The P4 read-only
requirement proof and P5 authority/host tuple proof remain separate checks in
this same coherent response.

Candidate IDs are generated exactly as fixed by the accepted V5 proposal:
`spc2_` plus lowercase SHA-256 of
`UTF8("arbor:sandbox-policy-candidate:v2\0") || variantByte || ordered
length-prefixed tuple`. `variantByte` is `0x01` for OsEnforced and `0x02` for
TrustedLocalUnconfinedV1. Each string uses `u32be(UTF8 byte length) || UTF8
bytes`; the positive registry revision is its canonical base-10 ASCII string
under the same length prefix. OS tuple order is
`providerId,providerVersion,profile,networkMode,providerRegistryRevision,
providerRegistryDigest`; TrustedLocal has only the variant byte. The
canonical TrustedLocal golden is
`spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d`.
IDs are display identity only: P1 rejects unknown fields and receives no
`candidateId`. The digest is excluded from the unchanged tuple-ID preimage;
boundary or ownership drift may change a candidate's digest while its ID
stays the same. Existing tuple sorting, exact duplicate collapse and
conflicting-mapping failure do not deduplicate different IDs or reorder the
list; TrustedLocal remains exactly once and last. P13 maps the selected
candidate's digest, existing variant fields and common preconditions to the
existing P1 command payload.

For a stale committed policy, `NeedsDecision` still requires the exact pending
P4 requirement. Each refreshed candidate digest derives from the current
complete boundary and ownership snapshot, never the stale policy's stored
handle digest. The full V2 bundle currentness and existing P4/P9 execution
gates remain unchanged. If a CAS basis changes after this read, P1 returns
its existing `StaleSandboxPolicyInputs` durable receipt without committing a
policy. A selected profile's changed mount/access projection uses the existing
`SandboxHandleBindingDigest` stale field; existing revision fields remain
authoritative where changed. An ownership change that leaves the selected
digest and every other CAS input equal does not alone stale the command.
P13 discards the whole old read and requires a fresh human choice after
invalidation or explicit refetch, even when `candidateId` is unchanged.

V5 qualification matrix: an initial no-decision plus exact pending P4/P3
requirement returns one coherent candidate read with the common preconditions
and no invocation/binding identity; a committed TrustedLocal decision plus
provider-registry-only V2 bundle drift becomes NeedsDecision and returns the
new common bundle pair; a command using the old candidate read is rejected by
the existing P1 stale receipt, while a fresh explicit TrustedLocal selection
omits the registry branch precondition. Issuer, operator, and provider
registry child changes each advance the full bundle and stale both variants.
Restart before/after reapproval preserves stale state and reconstructs the
single new decision without automatic selection or dispatch. Empty valid
Supported tuple sets return exactly TrustedLocal; invalid bundle or
unprovable tuple source returns a typed failure and no candidates. Missing,
corrupt, duplicate, or mismatched P4 requirement proof is a typed failure,
while valid closed/terminal/stopped/non-pending state returns None. Verify
same-TransactionScope read, exact common/per-candidate/OS-only fields,
candidate ID golden
and sort order, no sensitive detail, no P3/P4 private-store access, and no
new persisted candidate/Attention state.
