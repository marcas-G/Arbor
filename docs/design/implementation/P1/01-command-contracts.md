# P1 — 01 Command Contracts

**Authority:** DID v1.6 §4.1, §4.1A, §4.2, §0A.1, §6A.15, §12.3, §12.5, §12.6, §12.10, §12.11
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Closes:** A1 for the P1 command set; P1-DG-02 receipt/resolution; P1-DG-05 bootstrap; P1-DG-10 sub-items (ID generation, `AssignWork` rejections, child-workspace phase); fingerprint algorithm (P1-DG-03).

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
  DomainError | FencingRejected | ExecutionStopping | WorkspaceNotFound

CommandResolution<Result, Rejection> =
    Committed(Result)
  | TerminalRejected(Rejection)
```

- Domain instantiates `CommandResolution<R, DomainError>`.
- The Application command boundary instantiates
  `CommandResolution<R, CommandRejection>`.
- `FencingRejected` / `ExecutionStopping` / `WorkspaceNotFound` are
  Application-owned; they never appear in `DomainError`.

## 3. Generic command pipeline

```text
CommandGateway.execute(envelope, submissionContext)
  1. compute semanticRequestFingerprint + schemaVersion + algorithmVersion
  2. transact (03-transaction-model.md):
     a. read commands row by command_id
        - exists: same (fingerprint, schemaVersion, algorithmVersion)
              -> return existing Receipt (Committed or TerminalRejected)
          different -> TerminalRejected(IdempotencyConflict) [durable]
        - absent -> continue
     b. if ExecutionOrigin: fence check, then stop check (03 §4)
     c. authority / preconditions
     d. domain transition (P0 pure functions)
        - success: write canonical state + Committed receipt + events
        - terminal rejection: write TerminalRejected receipt, no event
     e. COMMIT
```

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
  - stable JSON: object keys sorted; arrays in order; undefined omitted;
    numbers/booleans/strings per JSON; tagged unions include _tag.
Hash algorithm (v1): SHA-256 over the canonical UTF-8 bytes, lowercase hex.
algorithmVersion = 1  (constant FINGERPRINT_ALGORITHM_VERSION)

Fingerprint input covers:
  commandType, projectId, declared actor, schemaVersion, semantic payload.
```

The Application boundary computes it (not the pure domain). P0's 32-bit
FNV-1a is superseded. Idempotency compares
`(fingerprint, schema_version, fingerprint_algorithm_version)`.

## 5. CreateProject

### Payload

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
    resourceBoundary: ResourceBoundary       // basisResponsibilityRevision == responsibilityRevision
    resourceBoundaryRevision: ResourceBoundaryRevision
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
| `resourceBoundary.basisResponsibilityRevision != responsibilityRevision` | `DomainError.AuthorityDenied` (reason) |
| same id + different fingerprint | `CommandRejection.IdempotencyConflict` |

### Events (same transaction, ordered)

```text
ProjectCreated → WorkspaceCreated
```

No Session Domain Event (DID §5.3). Session created atomically.

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
| project lifecycle != Open | `DomainError.TerminalLifecycleMutation` (entity `Project`) |
| workspace lifecycle != Active | `DomainError.TerminalLifecycleMutation` (entity `Workspace`) |
| no authority | `DomainError.AuthorityDenied` |
| work outside responsibility scope | `DomainError.AuthorityDenied` (reason) |
| `workspace.revision != expectedWorkspaceRevision` | `DomainError.RevisionConflict` |
| same id + different fingerprint | `CommandRejection.IdempotencyConflict` |

### Events

```text
WorkAssigned
```

## 8. Idempotency summary

```text
same commandId + same (fingerprint, schema, algorithm)  -> existing Receipt
same commandId + different fingerprint                  -> IdempotencyConflict
absent                                                  -> execute
```

`result_json` / `terminal_error_json` are JSON keyed by the stored
`schema_version` (see `04-sqlite-schema.md`).

## 9. Out of scope

- Exact payloads for non-P1 commands.
- `GovernanceMutationPlan` (DID §4.1A) beyond P1 commands.
