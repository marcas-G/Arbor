# P1 — 01 Command Contracts

**Authority:** DID v1.6 §4.1, §4.1A, §4.2, §0A.1, §6A.15, §12.3, §12.5, §12.6, §12.10, §12.11; DID v1.36 §4.1C FT-DG-01 CreateProject v2
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
      readonly targetWorkspaceId: WorkspaceId };
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
         - absent -> continue
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

The current 26 registered command handlers all use schema version `"1"`.
That current registration set must have a corresponding result decoder plus
the shared rejection decoder. A missing descriptor, unsupported schema
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
truth. Durable Profile source attribution is OPEN-1 in the FT-DG-01 v3
proposal and is not claimed here.

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
