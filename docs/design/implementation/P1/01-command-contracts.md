# P1 — 01 Command Contracts

**Authority:** DID v1.6 §4.1, §4.1A, §4.2, §0A.1, §6A.15, §12.3, §12.5, §12.6, §12.10, §12.11; DID v1.38 §4.1C FT-DG-01 CreateProject v2 and source attribution; DID v1.39 EA-DG-01 ResolveExecutableApproval
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Implements:** P1 command contracts; P1-DG-02/05 (DID-resolved); P1-DG-10 sub-items (ID generation, `AssignWork` rejections, child-workspace phase); fingerprint algorithm (P1-DG-03).

## 1. P1 command set

`CreateProject`, `CreateChildWorkspace`, `AssignWork` (DID §11 P1). All other
commands close in their owning phase.

## 2. Failure vocabulary (DID §6A.15)

```text
DomainError =
  IdempotencyConflict | AuthorityDenied | RevisionConflict | WorkNotOpen |
  TerminalLifecycleMutation | RetirePreconditionFailed | ActiveExecutionConflict |
  VerificationAcceptanceMismatch | DependencyNotSatisfiable | PermissionRevoked

CommandRejection =
  DomainError | FencingRejected | ExecutionStopping | WorkspaceNotFound |
  ProjectResourceUnavailable

CommandResolution<Result, Rejection> =
    Committed(Result)
  | TerminalRejected(Rejection)
```

- Domain instantiates `CommandResolution<R, DomainError>`.
- The Application command boundary instantiates
  `CommandResolution<R, CommandRejection>`.
- `FencingRejected` / `ExecutionStopping` / `WorkspaceNotFound` /
  `ProjectResourceUnavailable` are
  Application-owned; they never appear in `DomainError`.

For CreateProject v2, `ProjectResourceUnavailable` carries only the
CommandId. It MUST NOT echo the submitted Profile ref/version, host path,
filesystem error, or registry contents. It is a deterministic terminal
rejection recorded by the existing CommandGateway receipt path. The external
receipt view exposes only the rejection tag; it is not a transport Problem and
contains no host detail.

> **P2 evolution (DID v1.7 G1):** P2 adds Application-owned
> `ExecutionNotFound { executionId }` and generalizes the authority fact to
> `CommandAuthorityFact = VerifiedCommandAuthority | VerifiedRuntimeCommandAuthority`
> (command-specific runtime facts). See
> `docs/design/implementation/P2/01-command-contracts.md` §2.

`CommandResolution<Result, Rejection>` and `CommandReceipt<Result, Rejection>`
are **domain-owned generic** types (parameterized; no concrete rejection).
`CommandRejection` is Application-owned. `CommandReceipt<Result, Rejection>`
is the typed, decoded receipt view. `ports.CommandStore.findResolution`
returns the P1 `StoredCommandResolution` representation defined in
`02-port-contracts.md`: tuple metadata plus raw, unparsed result/error JSON.
The Application compares the stored tuple before decoding that JSON; only an
exact tuple match may proceed to construct the existing typed
`CommandReceipt<R, CommandRejection>` (avoids a forbidden `ports →
application` edge).

P1 `CommandReceipt<Result, Rejection>` view of the `commands` row (frozen):

```ts
{ commandId, projectId, semanticRequestFingerprint, schemaVersion,
  fingerprintAlgorithmVersion,
  resolution: CommandResolution<Result, Rejection>,
  createdAt, settledAt }
```

P0's `CommandReceipt<R>` (`{ commandId, fingerprint, resolution: DomainError }`)
is superseded by this P1 view (P0→P1 evolution; see `03-transaction-model.md` §7).

## 2A. Authority as a trusted Application input fact (freezes P1-DG-11)

P1 does **not** resolve authority: there is no `PermissionGrant` lookup, no
parent/user role resolution, no RBAC/ABAC/ACL, no principal hierarchy, no
admin/root flag, and **no default-allow**. The Application boundary receives a
pre-verified fact and performs **deterministic exact-match validation** only.

```ts
// Application-owned (packages/application). Domain never imports this type.
type VerifiedCommandAuthority =
  | { readonly _tag: "CreateProjectAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId }
  | { readonly _tag: "CreateChildWorkspaceAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly parentWorkspaceId: WorkspaceId }
  | { readonly _tag: "AssignWorkAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly targetWorkspaceId: WorkspaceId }
  | { readonly _tag: "ExecutableApprovalDecisionAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly approvalId: string;
      readonly workspaceId: WorkspaceId;
      readonly executionId: ExecutionId;
      readonly expectedRevision: number };
```

Exact-match rule (all conjuncts required; any mismatch → `AuthorityDenied`
with a reason):

```text
common(authority, envelope, context, fingerprint):
    authority._tag                       == <command authority tag>
  ∧ authority.principal                  == context.principal
  ∧ authority.commandId                  == envelope.commandId
  ∧ authority.semanticRequestFingerprint == fingerprint
  ∧ authority.projectId                  == envelope.projectId
CreateChildWorkspace additionally: authority.parentWorkspaceId == payload.parentWorkspaceId
AssignWork           additionally: authority.targetWorkspaceId == payload.workspaceId
ExecutableApproval additionally: authority.approvalId == payload.approvalId
  ∧ authority.workspaceId == approval.workspaceId
  ∧ authority.executionId == approval.executionId
  ∧ authority.expectedRevision == payload.expectedRevision
```

- The fact is a **trusted input** produced outside the command pipeline. P1
  defines only its shape and the exact-match rule; it is not persisted and not
  re-derived. P1 does not decide **why** a principal holds the governance
  authority (a later phase's Authority Resolver does).
- Authority is **not** an input to `semanticRequestFingerprint` (§4): a change
  in authorization state must not change the logical identity of a request.
- An existing authoritative resolution is replayed **before** any authority
  validation (§3 step a, `03-transaction-model.md` §3.1): a previously
  `Committed` command is never re-judged as `AuthorityDenied`.
- A terminal `AuthorityDenied` receipt is durable. Re-attempting the same
  logical request requires a **new** `commandId` (a new logical intent).

## 3. Generic command pipeline

For an External submission, authentication, strict bounded wire-v1 decoding,
CommandId/ProjectId/Actor and payload-ID validation, Handler schema/fingerprint
derivation, exact declared-Actor-to-authenticated-Principal binding, and the
P12 Authority Resolver visibility check all complete in the
Application/Composition boundary **before** `CommandGateway.execute` is
invoked. No receipt is read or disclosed before that Resolver succeeds. See
DID §4.1B and P12 `10` §3 / `02` §2. The Command Gateway remains the shared
mutation and receipt boundary for every origin.

```text
CommandGateway.execute(envelope, submissionContext, verifiedCommandAuthority)
  1. compute semanticRequestFingerprint + schemaVersion + algorithmVersion
  2. transact (03-transaction-model.md):
     a. read stored resolution metadata and raw result/error JSON by command_id
         - absent -> if authority is `RetryVerificationReplayOnlyAuthority`,
           fail `PersistenceCorruption<"CommandStore">` and roll back with no
           attempt/handler/write; otherwise continue
         - exists: compare (fingerprint, schemaVersion, algorithmVersion)
           before interpreting either raw JSON field
             - any tuple field differs -> TerminalRejected(IdempotencyConflict);
               do not decode or disclose result/error JSON; stored row unchanged
             - exact tuple match -> decode the stored resolution and return the
               existing typed Receipt (Committed or TerminalRejected)
     b. if ExecutionOrigin: fence check, then stop check (03 §4)
     c. authority exact-match (§2A); mismatch -> TerminalRejected(AuthorityDenied)
     d. domain transition (P0 pure functions)
         - success: write canonical state + Committed receipt + events
         - terminal rejection: write TerminalRejected receipt, no event
     e. COMMIT
```

Step a **precedes** step c: an already-authoritative resolution is replayed
without re-running the authority predicate.

For an existing row, the stored tuple comparison is the first receipt
interpretation decision. In particular, a fingerprint, schema-version, or
fingerprint-algorithm mismatch takes the existing `IdempotencyConflict`
branch even when the row's raw result/error JSON is malformed: the mismatched
branch does not parse, validate, or disclose that JSON. Only an exact tuple
match reaches the existing Application receipt decoder. This amendment fixes
that ordering. The exact-tuple decoder's result/error schemas, corruption
failure type, and non-retryable Problem mapping are fixed in §3A; this clause
does not change the comparator or allow prior-receipt consumers outside the
Gateway to claim a candidate tuple comparison.

### 3A. Exact-tuple receipt result and rejection decoding

After an exact tuple match, the Application selects a strict runtime decoder
by the exact registered `(commandType, CommandHandler.schemaVersion)` pair.
The descriptor is server-owned and must exist for every reachable registered
command/version. The command-specific Committed result schema is owned by that
Command's contract (P1 or its owning P-phase); it is not inferred from a
DomainEvent schema, the incoming payload codec, the stored row, or TypeScript
casts. The TerminalRejected value is checked against the exhaustive current
Application `CommandRejection` union and every member's required fields. Both
decoders validate JSON syntax, object/union shape, owned fields, branded IDs,
primitive/range/enum values and nested result values; unexpected members and
missing required members fail closed.

The current production registry has 28 required command handlers. When the
optional `ResolveControlApproval` handler is composed, it adds one descriptor
(29 total); these counts align with the current P13 `02` matrix. Handler
`schemaVersion` is command-specific: `CreateProject` uses schema version `2`,
while the other current handlers use their owning contract's registered
version (currently `"1"`). This does not widen P1's own three-command phase
set or the ordinary `SendMessage/1` receipt DTO. Every exact registered
`(commandType, schemaVersion)` pair, including the optional one when composed,
must have a corresponding result decoder plus the shared rejection decoder. A missing descriptor, unsupported schema
version, invalid JSON, wrong shape, missing required resolution JSON, or
unknown rejection tag is a non-command stored-state corruption, never a
`TerminalRejected` or model-correctable rejection. Use the existing
`PersistenceCorruption<"CommandStore">` boundary with a fixed safe reason;
never include raw JSON, parser exception text, row contents or caller data.

The decoder implements the persisted JSON representation of the owning result
contract. In particular, `ConcludeVerificationResult.conclusionReason` is a
TypeScript field typed `ConclusionReason | undefined`; `JSON.stringify`
omits it when undefined. The v1 decoder therefore accepts the field as absent
and reconstructs `conclusionReason: undefined`, while validating any present
value against `ConclusionReason`. This is serialization round-tripping of the
existing DTO, not a new domain outcome. Unknown fields remain invalid.

This failure changes no receipt resolution and does not repair or rewrite the
row. It is not `CommandRejection`, does not insert a Command/attempt/Event or
invoke a handler, and is not a retryable model rejection. Gateway propagation
and the same-transaction rollback/no-attempt behavior are owned by
`03-transaction-model.md` §3.1/§3.3; external safe Problem mapping is owned by
DID §4.1B / the existing transport adapter. Historical tuple/schema mismatch
continues to take precedence and is never sent to a historical decoder unless
that exact schema version is explicitly registered.

For External requests, the preceding Composition Resolver is a visibility
gate, not a replacement for this in-transaction order: after Resolver success,
the Gateway still reads/replays the exact receipt tuple at step a before its
final exact authority check at step c. The Gateway's `BEGIN IMMEDIATE`
transaction remains the only receipt lookup/linearization point. A codec
failure returns the transport-only `InvalidCommandPayload` Problem before
Resolver/Gateway and is not part of `CommandRejection`, `CommandResolution`,
or receipt vocabulary. This external boundary does not widen P1 `07`'s sole
old-Committed direct-child AssignWork recovery exception; that exception still
requires the accepted AH10 binding proof.

### 3B. P8 permanent RetryVerification receipt origin (DID v1.46)

The external ordering above remains unchanged: authentication/codec/Actor
binding and the current P12 Resolver visibility/authorization check complete
before Gateway can inspect a receipt. For the historical P8
`RetryVerification` source, Composition loads the immutable
`retry_verification_origins` fact by candidate CommandId into declared
canonical authority inputs. This is a non-receipt source fact; there is no
external CommandStore pre-read, alternate tuple comparator, historical decoder,
or resolver cache. The Resolver requires the bound project, original actor,
source Work/Verification scope and current P8 human governance permission.
Current authorization is required on every replay; revoked/changed-owner
authorization or a different actor/project/source is a generic Resolver denial
before Gateway.

An existing but malformed, duplicate, contradictory, or corrupt origin-store
fact fails closed as typed
`PersistenceCorruption<"RetryVerificationOriginStore">`, mapped to the
existing fixed non-retryable `persistence/corruption` Problem before Gateway.
The response carries no origin/receipt fields or decoder/database detail.

For an authorized origin and same source/CommandId, the Resolver intentionally
does not compare candidate summary content, expected Work revision, successor
Verification ID, successor Execution ID, fingerprint, Handler schema version,
or fingerprint algorithm version. Gateway `BEGIN IMMEDIATE` remains the sole
receipt lookup and full
`(semantic_request_fingerprint, schema_version,
fingerprint_algorithm_version)` comparison point. An exact tuple returns the
existing typed receipt; a changed tuple remains the existing
`TerminalRejected(IdempotencyConflict)` branch before JSON decode, with no
receipt/event/canonical write. The replay-only authority is not accepted by the
P8 handler. If it reaches Gateway with no receipt row, Gateway returns the
fixed safe `PersistenceCorruption<"CommandStore">` failure, rolls back and
does not record an attempt or invoke a handler. The P8 origin, source
conclusion, successor, spawn intent and successful receipt are one transaction
under P1 `03` §3.1; an origin is not a substitute for a receipt.

### 3C. P6 UnboundLegacy current-route fallback (DID v1.47/v1.52)

No v1 P1 owner/Parent-governance command mutates the canonical Work owner or
Workspace Parent. Therefore only command-level route-move/failure qualification
is N/A for v1; this does not make the same-key helper or its future-command
constraint N/A. If a future separately governed command changes that route and
cannot move the same-key P6 UnboundLegacy Governance Inbox row in the same P1
command transaction, it returns the existing typed
`TerminalRejected(AuthorityDenied)` (or the narrowest existing typed
rejection) through CommandGateway. This is an ordinary terminal command
outcome, not a pre-Gateway transport/Resolver error. The normal receipt and
`CommandAttempt` are persisted: the rejection path leaves canonical
Work/Workspace/owner state, Domain Events, Inbox rows and the immutable
UnboundLegacy disposition unchanged. Same CommandId/tuple replay returns that
same terminal receipt; a different CommandId independently reaches the
rejection. P1 `03` owns the transaction and before/after receipt-commit
recovery boundary. No new `CommandRejection` variant is introduced.

> **P2 evolution:** the `authority` parameter is generalized to
> `CommandAuthorityFact`; `CommandHandler` declares an explicit `stopAdmission`
> ADT, and `FenceStopCheck.check` receives it. See
> `docs/design/implementation/P2/01-command-contracts.md` §2.3/§3 and `02` §4.

- Declared actor (`envelope.actor`) is validated separately from the
  authenticated principal (`submissionContext`), DID §4.1.
- **ID generation:** all entity IDs are caller-preallocated and carried in
  the payload; handlers never generate IDs. A caller-preallocated ID that
  collides with an existing entity is a **defect** (invariant violation), not
  a typed rejection (DID §0A.1).
- `CommandAttempt` is a non-authoritative trace (DID §9.9).

## 4. Fingerprint contract (freezes P1-DG-03)

```text
Canonical serialization (v1):
  - stable JSON: object keys sorted (code-unit order); arrays in order;
    undefined omitted; null kept; tagged unions include _tag.
  - numbers: JSON number, no trailing zeros; NaN/Infinity rejected at build.
  - strings: JSON escaping; branded strings serialize as their underlying value.
  - fingerprint input is exactly
    { commandType, projectId, actor, schemaVersion, payload }.
Hash algorithm (v1): SHA-256 over the canonical UTF-8 bytes, lowercase hex.
algorithmVersion = 1  (constant FINGERPRINT_ALGORITHM_VERSION)

Fingerprint input covers:
  commandType, projectId, declared actor, schemaVersion, semantic payload.
```

The Application boundary computes it (not the pure domain). P0's 32-bit
FNV-1a is superseded (see `03-transaction-model.md` §7). Idempotency compares
`(fingerprint, schema_version, fingerprint_algorithm_version)`.

## 5. CreateProject

### Payload

CreateProject semantic Handler schemaVersion **2** (external wire codec remains
the server-selected wire-v1 codec; DID §4.1B). The v2 root resource choice is a
closed selector; the client does not submit a ResourceBoundary or path.
ResourceProfileRef and ResourceProfileVersion are bounded non-empty opaque
host identifiers, not Domain entity IDs or authority capabilities.

```ts
type ResourceProfileRef = string;
type ResourceProfileVersion = string;

/** Project-owned historical source of its initial root resource boundary. */
type ProjectResourceSource =
  | { readonly _tag: "Profile";
      readonly resourceProfileRef: ResourceProfileRef;
      readonly version: ResourceProfileVersion }
  | { readonly _tag: "ConversationOnly" }
  | { readonly _tag: "LegacyUnknown" };

interface Project {
  readonly resourceSource: ProjectResourceSource;
}

type NewProjectResourceSource = Exclude<
  ProjectResourceSource,
  { readonly _tag: "LegacyUnknown" }
>;

interface CreateProjectInput {
  readonly resourceSource: NewProjectResourceSource;
}
```

```ts
{
  name: string
  revision: Revision                       // Project aggregate revision
  projectPolicy: ProjectPolicy
  projectPolicyRevision: Revision
  defaultConfiguration: Readonly<Record<string, unknown>>
  environmentRef: string
  rootWorkspaceId: WorkspaceId             // caller-preallocated
  primarySession: { sessionId: SessionId; contextEpoch: ContextEpochNumber }
  rootWorkspace: {
    name: string
    responsibilityDefinition: ResponsibilityDefinition
    responsibilityRevision: ResponsibilityRevision
    resourceSelection:
      | { _tag: "Profile"; resourceProfileRef: ResourceProfileRef;
          version: ResourceProfileVersion }
      | { _tag: "ConversationOnly" }
    agentBinding: ResponsibilityBoundAgentBinding
    workspacePolicy: WorkspacePolicy
    workspacePolicyRevision: Revision
    revision: Revision
  }
}
```

`envelope.projectId` is the new Project id.

### Result

```ts
{ projectId: ProjectId; rootWorkspaceId: WorkspaceId; primarySessionId: SessionId }
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| no authority | `DomainError.AuthorityDenied` |
| Profile ref/version is absent, unknown, or stale in the immutable host registry | `CommandRejection.ProjectResourceUnavailable` (no Project/Workspace/Session/Event write) |
| same id + different fingerprint | `CommandRejection.IdempotencyConflict` |

For Profile selection, the handler resolves the exact ref/version through the
P1 `02` ProjectResourceProfilePort only after CommandGateway's existing receipt
tuple check has found no row. The port returns a trusted host-canonical
FileTree address from its immutable in-memory snapshot; it performs no slow
filesystem I/O in the semantic transaction. ConversationOnly constructs an
empty ResourceBoundary. In both cases the handler sets the initial
ResourceBoundary basis to the root Responsibility revision and initial
boundary revision to 0; no caller-supplied address or boundary revision is
copied.

The Profile ref/version is part of the v2 semantic fingerprint via the closed
payload. The ProjectCreated and WorkspaceCreated event types, EventVersion=1,
their payloads, and relative order remain unchanged. For a non-empty Profile
boundary only, the command additionally writes the P1-owned
`WorkspaceResourceActivationIntent(Pending)` and appends
`WorkspaceResourceActivationChanged(Pending)` after WorkspaceCreated in this
same transaction. ConversationOnly has no intent and no activation event. The
canonical Workspace ResourceBoundary persisted by this command is the resource
truth. The Project persists the selected `resourceSource` in the same existing
transaction as its other state. The handler derives it directly from the v2
selector: `Profile` copies the exact ref/version and `ConversationOnly` stays
tagged; `LegacyUnknown` is migration/read compatibility state and cannot be
created by a new CreateProject command. This source records the historical
choice only: it is not authority, does not retarget the Workspace boundary,
and contains no filesystem path. Existing Projects receive
`LegacyUnknown` in migration 0042 without inference from Workspace state,
events, receipts, host catalog, or filesystem. ProjectCreated and
WorkspaceCreated EventVersion-1 payloads and their relative order remain
unchanged.

Historical CreateProject v1 requests/receipts remain preserve-only. A raw v1
address payload is rejected by the strict current codec before Resolver or
receipt lookup. A valid v2 request reusing a v1 CommandId reaches the normal
Gateway tuple comparison after authentication, Actor binding, and Resolver
visibility; schema mismatch returns non-disclosing `IdempotencyConflict` and
leaves the old receipt unchanged. No old-schema decoder, receipt pre-read,
fingerprint recomputation, or v1 receipt migration is added.

### Events (same transaction, ordered)

```text
ProjectCreated → WorkspaceCreated
  → WorkspaceResourceActivationChanged(Pending) [Profile only]
```

No Session Domain Event (DID §5.3). Session created atomically.
`WorkspaceResourceActivationChanged` is a separate operational status fact;
it does not modify either existing event payload and is not written for the
empty ConversationOnly boundary. P1 `05` owns its EventVersion-1 payload and
reader contract. A post-commit ownership failure cannot roll back this
committed intent, these events, or the receipt.

## 6. CreateChildWorkspace

P1 owns this command (DID v1.6 §11; removed from P6).

### Payload

```ts
{
  parentWorkspaceId: WorkspaceId
  workspaceId: WorkspaceId                 // caller-preallocated
  primarySession: { sessionId: SessionId; contextEpoch: ContextEpochNumber }
  name: string
  responsibilityDefinition: ResponsibilityDefinition
  responsibilityRevision: ResponsibilityRevision
  resourceBoundary: ResourceBoundary
  resourceBoundaryRevision: ResourceBoundaryRevision
  agentBinding: ResponsibilityBoundAgentBinding
  workspacePolicy: WorkspacePolicy
  workspacePolicyRevision: Revision
  revision: Revision
}
```

### Result

```ts
{ workspaceId: WorkspaceId; projectId: ProjectId; parentWorkspaceId: WorkspaceId; primarySessionId: SessionId }
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| parent not found | `CommandRejection.WorkspaceNotFound` |
| parent not in `envelope.projectId` | `DomainError.AuthorityDenied` |
| parent lifecycle != Active | `DomainError.TerminalLifecycleMutation` |
| no authority | `DomainError.AuthorityDenied` |
| `resourceBoundary.basisResponsibilityRevision != responsibilityRevision` | `DomainError.AuthorityDenied` (reason) |
| same id + different fingerprint | `CommandRejection.IdempotencyConflict` |

### Events

```text
WorkspaceCreated
```

No Session Domain Event. Child `WorkspacePrimary` Session created atomically.

## 7. AssignWork

### Payload

```ts
{
  workId: WorkId                           // caller-preallocated
  workspaceId: WorkspaceId
  expectedWorkspaceRevision: Revision      // optimistic precondition
  objective: string
  why: string
  constraints: ReadonlyArray<string>
  completionExpectation: string
  verificationMission: VerificationMission
  provenance: Provenance
  revision: WorkRevision
}
```

### Result

```ts
{ workId: WorkId; workspaceId: WorkspaceId; lifecycle: "Open"; revision: WorkRevision }
```

### Preconditions / rejections (DID v1.6 §0A.1 / §6A.15)

| Condition | Rejection |
|---|---|
| workspace not found | `CommandRejection.WorkspaceNotFound` |
| `workspace.projectId != envelope.projectId` | `DomainError.AuthorityDenied` |
| project lifecycle != Open | `DomainError.TerminalLifecycleMutation` (entity `Project`) |
| workspace lifecycle != Active | `DomainError.TerminalLifecycleMutation` (entity `Workspace`) |
| no authority | `DomainError.AuthorityDenied` |
| work outside responsibility scope | `DomainError.AuthorityDenied` (reason) |
| `workspace.revision != expectedWorkspaceRevision` | `DomainError.RevisionConflict` |
| same id + different fingerprint | `CommandRejection.IdempotencyConflict` |

P0 `assignWork` returns `RetirePreconditionFailed` when the workspace does not
accept work; the P1 handler pre-checks workspace lifecycle and returns
`TerminalLifecycleMutation` instead. The P0 branch is superseded by this
contract (P0→P1 artifact evolution).

"work outside responsibility scope" is expressed by the trusted authority fact
(§2A): P1 does not evaluate the workspace `responsibilityDefinition` (that is
Authority Resolver semantics, deferred). The handler enforces only the
deterministic preconditions above.

### Events

```text
WorkAssigned
```

## 7A. Cross-phase `ResolveExecutableApproval` Command (EA-DG-01)

The approval decision uses the existing P1 CommandGateway/receipt boundary;
P1's original three phase-owned creation commands remain unchanged.

```ts
type ResolveExecutableApprovalPayload = {
  readonly approvalId: string;
  readonly expectedRevision: number;
  readonly decision: "Approve" | "Reject";
  readonly reason: string | null;
};

Command type: `ResolveExecutableApproval`; Handler `schemaVersion = "1"`.

type ResolveExecutableApprovalResult = {
  readonly approvalId: string;
  readonly executionId: ExecutionId;
  readonly state: "Approved" | "Rejected" | "Expired";
  readonly revision: number;
};
```

P12 resolves `ExecutableApprovalDecisionAuthority` from the authenticated
human, exact project/workspace/Execution/approval and decision policy before
Gateway entry. Missing and foreign approval targets return the same safe
not-found response before receipt lookup; the user-visible route does not
reveal target existence. For an authorized target, Gateway/Handler validates
`route_kind='Executable'`, active Execution, Pending state and exact
`expectedRevision`. If the request is still Pending but `expiresAt <= now`,
the command commits Expired rather than the requested human decision and
returns that committed state/revision. Otherwise it CASes Approved or Rejected.

State change, exact Inbox revision consumption, `ExecutableApprovalResolved`
event and Committed Command receipt share one transaction. At-least-once
receipt replay returns the committed decision without another revision change,
Inbox consumption or wake. A stale revision is the existing typed
`RevisionConflict`. This command cannot read/decide `route_kind='Control'` or
consume an approval; CAPA `ResolveControlApproval` remains unchanged.

## 8. Idempotency summary

```text
same commandId + same (fingerprint, schema, algorithm)  -> existing Receipt
same commandId + any tuple field differs                -> IdempotencyConflict
absent                                                  -> execute
```

> **DID v1.20 AHT-4 propagation.** Agent recovery adds a stable
> `LogicalActionId` / `LogicalSettlementId` outside the Command model. Every
> lease generation derives a new immutable `CommandId` only after receipt-first
> eligibility checks; ordinary transient retry of that exact request still
> reuses the same CommandId. See `07-agent-loop-step-command-identity.md`.

`result_json` / `terminal_error_json` are JSON keyed by the stored
`schema_version` (see `04-sqlite-schema.md`).

## 9. Out of scope / Must Not Decide

- Exact payloads for non-P1 commands.
- `GovernanceMutationPlan` (DID §4.1A) beyond P1 commands.

Authority (P1-DG-11) — P1 MUST NOT implement or introduce:

```text
PermissionGrant lookup; parent/user role resolution; RBAC; ABAC; ACL;
principal hierarchy; admin flags (isRootUser() / allowAll());
AuthorityRepository; an Authority Resolver.
```

A later phase owns `Canonical facts + PermissionGrant + Parent/User governance
+ authenticated Principal → Authority Resolver → VerifiedCommandAuthority`.
When it arrives, P1 handlers need no change — that is the value of this seam.

## Native OS Sandbox accepted command amendment

`DecideSandboxPolicy` is an External human-only command bound to exact
Project/Workspace/Execution/full canonical Episode and the V21 closed policy
request/preconditions below. The former shorthand wording “expected
Execution/policy revisions, profile, provider, network mode/targets,
provider-policy digest” is superseded; caller wire values are the exact
human-selected policy union plus caller-visible CAS values, not internal
provider/evidence digests or destinations as an alternate codec. P12 `02`
must produce the Application-owned
`SandboxPolicyDecisionAuthority` before any receipt read. Resolver-before-
receipt remains mandatory; only after successful preflight does normal
receipt-first replay apply.

The authority binds the authenticated HumanPrincipal, exact CAPA v2
PermissionGrant projection (including raw scope/lifetime and revision/state/
issuer), exact `ExecutionId` target and immutable
`SandboxPolicyGrantIssuerProvenanceV1`. P1's only §2A sandbox exception is a
same-transaction exact re-read/compare of that Grant and provenance row; P1
does not parse CAPA scope, resolve operators, infer roles or widen authority.
The operator is the authenticated configured host operator, differs from the
Grant/decision subject, and may issue only this exact Grant capability.
P1 `GrantPermission` writes provenance only after P12 authority and exact
Gateway validation; TerminalRejected writes no provenance/event.

Trusted Resolver and Gateway clocks independently validate
`validFrom <= now < Grant.expiresAt` and `now < decisionExpiresAt <=
Grant.expiresAt`. Neither uses `CommandEnvelope.issuedAt`. Grant target must
be one exact ExecutionId; canonical Execution relations establish
Project/Workspace/Episode and foreign targets fail closed without disclosure.
`TerminalRejected` writes no decision or event; Committed decision/event/
receipt is atomic. Grant issuance order and event identity are fixed in P1
`03`/`05` below.

## Accepted full-chain Native Sandbox decision command contract (V21)

The closed external `DecideSandboxPolicy` request contains only human-selected
policy inputs and caller-visible CAS preconditions. It carries the exact
canonical `ExecutionEpisodeBinding` codec (all existing variant fields, not
`{kind,id}` shorthand), `expectedEpisodeRevision` sourced from
`executions.episode_revision`,
`expectedWorkspaceRevision`, `expectedResourceBoundaryRevision`, and
`expectedPolicyRevision`. Environment revision is not a sandbox precondition.
The human supplies the profile and its exact network-policy union, provider
choice where applicable, expiry, and other already-exposed stable selection
fields. The current AuthorityBundle/operator-config/provider-registry
revision+digest references returned by the authorized Workspace Detail view
are echoed as expected values; arbitrary unseen references are rejected.
The wire decoder rejects unknown/duplicate fields and cross-variant fields.

PermissionGrantId, issuer provenance, authority snapshots, qualification
entry/evidence, runtime basis digests, expected effective-policy digest,
GatewayNow, lease/generation/fence and actor provenance are internal trusted
envelope values supplied by P12/P5/P4/Application; clients cannot submit
them. The P1 semantic fingerprint is exactly the existing full canonical
envelope `{commandType,projectId,actor,schemaVersion,payload}` algorithm,
including the canonical human actor, command type, schema version and exact
wire payload. The fingerprint algorithm version is receipt metadata, not a
hash input. Same CommandId replays the committed receipt exactly; a different
fingerprint conflicts. No new command identity or pre-receipt envelope table
is introduced.

The committed internal result has exact closed outer key order
version,commandId,projectId,workspaceId,executionId,episodeBinding,
policyRevision,policyDigest,effectivePolicySnapshot. It is a closed
SandboxPolicyDecisionCommittedInternalV1 with either OsEnforced full snapshot
(profile ReadOnly/WorkspaceWrite, provider/T3/network fields) or
TrustedLocalUnconfined full snapshot (profile FullAccess, networkBoundary
Unconfined; no provider-qualification/T3/networkMode fields). It includes the
exact canonical effectivePolicySnapshot, its policyDigest, bounded auditRefs,
and the public-view projection source.
`commands.result_json` is the existing durable result carrier; P12 projects a
closed `SandboxPolicyDecisionCommittedViewV1` with only safe fields. The
decision table remains anchored by `decision_command_id`; recovery joins the
decision row to its exact Command result receipt and verifies the stored
`policy_digest` against canonical result bytes. No new DDL is required.

`SandboxPolicySummaryTooLarge` is an existing closed terminal rejection when
the canonical internal result would exceed 65,536 UTF-8 bytes: no decision or
event is committed, the exact durable rejection receipt is replayed, and P13
renders an inline fixed hint. It is not a 409/Problem and fields are not
truncated.
The exact selected human payload is the following closed shape (the existing
CommandEnvelope supplies commandId/actor/schemaVersion outside payload):

The common fields are projectId, workspaceId, executionId, full existing
canonical ExecutionEpisodeBinding, expectedEpisodeRevision,
expectedPolicyRevision, expectedWorkspaceRevision,
expectedResourceBoundaryRevision, expectedSandboxHandleBindingDigest,
expectedAuthorityBundleRevision/digest, expectedOperatorConfigRevision/
digest, profile, providerId, networkPolicy and decisionExpiresAt. The closed
variant is either OsEnforced (profile ReadOnly|WorkspaceWrite, exact provider,
closed NetworkPolicyV1, expectedProviderRegistryRevision/digest) or
TrustedLocalUnconfinedV1 (profile FullAccess, providerId TrustedLocal, exact
Unconfined codec, and no provider-registry fields). No executionRevision or
expectedEnvironmentRevision alias exists.

Canonical external payload key order is projectId,workspaceId,executionId,
episodeBinding,expectedEpisodeRevision,expectedPolicyRevision,
expectedWorkspaceRevision,expectedResourceBoundaryRevision,
expectedSandboxHandleBindingDigest,expectedAuthorityBundleRevision,
expectedAuthorityBundleDigest,expectedOperatorConfigRevision,
expectedOperatorConfigDigest, then for OsEnforced only
expectedProviderRegistryRevision,expectedProviderRegistryDigest, then profile,
providerId,networkPolicy,decisionExpiresAt. TrustedLocal omits those two
registry keys as a codec rule, not nullable values. The top-level P1
CommandEnvelope still supplies actor/commandId/schemaVersion outside payload.

The provider-registry expected pair is present only for the OsEnforced variant;
TrustedLocalUnconfinedV1 uses its exact closed discriminant and has no registry
precondition. No environment revision/fingerprint, network-broker result,
operator/registry entry, evidence blob, GrantId/provenance, actor override,
expected effective-policy digest, lease/fence, trusted clock, host path,
target ref or audit ref is caller-supplied. Unknown fields at either union
level are rejected. StaleSandboxPolicyInputs is an existing closed durable
TerminalRejected receipt with safeDetails.field exactly one of
EpisodeRevision,PolicyRevision,WorkspaceRevision,ResourceBoundaryRevision,
SandboxHandleBindingDigest,AuthorityBundleRevision,OperatorConfigRevision,
ProviderRegistryRevision. It exposes no old/current numeric value, digest,
target/path or diagnosis. POST /commands
returns HTTP 200 CommandReceiptView and same-CommandId replay returns that
same receipt. Do not add 409 or Problem mapping.

## Accepted V3 policy producer receipt bindings

The committed internal snapshot is derived from P5's exact
SandboxAuthorityBundleV2 and P11's complete current ResourceBoundary, never
from caller/tool-target subset data. `authorityBundleRevision/Digest` and
`operatorConfigRevision/Digest` in both snapshot variants must equal the
verified V2 bundle and embedded operator-config subobject; OsEnforced's
provider-registry pair must equal its embedded V2 registry. TrustedLocal
continues to omit provider-registry fields. Configured limits and the
environment allowlist are values from that operator config; no wire field
overrides them. `trustedRuntimeVersion` is exactly `builtin-v1` in the
existing TrustedLocal snapshot/basis variant.

P1 accepts `auditRefs` only as the bounded internal provenance projection
provided by the trusted producer: an existing stable authority-audit
reference when the audit store exposes one (otherwise omitted), the exact
committed command/receipt reference, and for OsEnforced the exact qualification
manifest blob reference (omitted for TrustedLocal). Deduplicate exact refs,
UTF-8 sort and enforce the existing count/length bounds before computing the
snapshot digest. Never synthesize a ref from a timestamp, log offset, path,
provider diagnostic, or client input. Public receipt/view projections
continue to redact every audit ref. This adds no payload field, event, DDL,
receipt variant, or fingerprint input beyond the already frozen V21 command.

## Accepted Option A provider-tuple selector amendment (2026-10-20)

Accepted under `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`, fixed
proposal SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`.
This amendment supersedes only the V21 OsEnforced payload-shape and P10/P13
mapping sentences that described the provider choice without
`providerVersion` and `capabilityRevision`; all other V21/V3 fields and
semantics remain unchanged.

`DecideSandboxPolicy` advances its semantic handler/receipt schema from `1`
to `2`; its previous receipt schema `1` is allowed only for exact prior
receipt replay through the existing Gateway compatibility path. The external
wire codec remains v1 and the internal CommandEnvelope continues to supply
the handler schemaVersion outside the payload. For the OsEnforced payload,
the exact closed key order is the existing common prefix through
`expectedProviderRegistryDigest`, then `profile,providerId,providerVersion,
capabilityRevision,networkPolicy,decisionExpiresAt`. `providerVersion` is the
exact canonical string; `capabilityRevision` is a positive safe integer.
TrustedLocalUnconfinedV1 has no such fields and rejects them as unknown.
OsEnforced `NetworkPolicyV1.mode` must equal the selected registry tuple's
`networkMode`.

The external decoder accepts exactly the legacy OsEnforced shape with both
new fields absent (for exact receipt replay or a current-schema terminal
rejection), or the current shape with both present; a partial pair is
MalformedRequest. A new submission always uses handler schema `2`. If an
exact legacy-shaped request has a stored schema-1 receipt, Gateway uses its
existing allowlisted prior-receipt path and exact old fingerprint/result
validator; payload shape never selects schema 1. If no receipt exists, the
legacy shape has no exact tuple selector and commits the existing durable
`SandboxAuthorityUnavailable` rejection under schema 2, with no decision or
event. No new command writes a schema-1 receipt. A changed tuple under a
previously used CommandId remains `IdempotencyConflict`.

Before decision materialization, P1 matches exactly one current P5 V2
Supported registry row by the human-selected `providerId`, `providerVersion`
and `capabilityRevision`, trusted currentHost `osFamily/osBuild`, selected
profile, `NetworkPolicyV1.mode`, codec version `1`, and canonical
`enforcementRuleSetDigest`. It copies all provider/evidence/host facts from
that row; none are trusted from client input. Missing, non-Supported,
ambiguous, wrong-version/capability/host/profile/mode, missing evidence or
rule-set mismatch returns the existing terminal
`SandboxAuthorityUnavailable` rejection without a decision/event and never
falls back to TrustedLocal. The existing provider-registry revision/digest
and full authority-bundle/operator/boundary CAS remain authoritative; stale
expected refs retain the existing safe `StaleSandboxPolicyInputs` receipt.

The committed result remains
`SandboxPolicyDecisionCommittedInternalV1` with its existing canonical
OsEnforced snapshot, which already stores providerVersion and
capabilityRevision. Result bytes, result codec version, public safe view,
decision row, event, auditRefs and SQLite schema do not change. Register the
existing strict result validator for handler schema 2 as well as schema 1;
schema-1 stored result bytes remain immutable. No migration or historical row
rewrite is introduced.

## Accepted Sandbox Policy Candidate Read Model V5 command boundary

The P10 `sandboxPolicyCandidateRead` is presentation/read-model data only.
P1 does not accept `candidateId`, candidate list, or candidate-read reason as
payload or authority. P13 maps the human's selected existing variant and
common preconditions to the DecideSandboxPolicy payload as amended by Option
A; the OsEnforced variant also carries the exact providerVersion and
capabilityRevision selector. Both
OsEnforced and TrustedLocal carry the common exact
`expectedAuthorityBundleRevision/Digest`; OsEnforced additionally carries
the existing provider-registry pair, while TrustedLocal omits that branch
precondition. P1 compares the full current V2 bundle for either variant, so
registry-only bundle drift rejects an old TrustedLocal submission as the
existing durable `StaleSandboxPolicyInputs` receipt. The candidate ID never
changes the frozen P1 fingerprint, receipt, decision, or `policy_digest`.

Qualification cases: both variants with stale common bundle revision/digest
return the existing durable `StaleSandboxPolicyInputs` receipt before any
decision/event; an OsEnforced-only stale registry pair is independently
rejected; provider-registry-only full-bundle drift rejects a TrustedLocal
command through its common authority-bundle precondition; a fresh explicit
TrustedLocal command succeeds without registry branch fields. `candidateId`,
candidate list/reason, and candidate-only fields are rejected as unknown wire
fields, and identical P1 fingerprint/receipt replay semantics remain exact.

## Accepted candidate profile binding digest V6 command mapping

P13 copies only the human-selected candidate's
`sandboxHandleBindingDigest` into the existing
`expectedSandboxHandleBindingDigest` payload field. The common candidate
preconditions contain no handle digest. P1 recomputes the current complete
P11 boundary and exact active ownership through the existing P4 profile
producer for the submitted variant and applies its unchanged CAS; a changed
selected-profile mount/access projection uses the existing
`StaleSandboxPolicyInputs` `SandboxHandleBindingDigest` field. Existing
revision preconditions remain authoritative when they change. `candidateId`
remains presentation identity and is never submitted. This mapping adds no P1
wire field, codec, fingerprint input, rejection, event, decision snapshot,
SQL table or migration.
