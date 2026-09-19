# P1 — 01 Command Contracts

**Authority:** DID v1.5 §4.1, §4.1A, §4.2, §12.3, §12.5, §12.6, §12.11, §6A.15, §0A.1
**Status:** P1 phase-scoped closure (draft for review)
**Closes:** A1 for the P1 command set; P1-DG-02 receipt/resolution; P1-DG-05 bootstrap; P1-DG-10 sub-items (ID generation, `AssignWork` rejections, child-workspace phase).

## 1. P1 command set

Only these are closed in P1 (per DID §11 P1):

```text
CreateProject
CreateChildWorkspace
AssignWork
```

All other commands (UpdateProjectPolicy, RefineWork, CompleteWork, …) are
closed in their owning phase.

## 2. Generic command pipeline (applies to every P1 command)

```text
CommandGateway.execute(envelope, submissionContext)
  1. compute semanticRequestFingerprint (DID §4.1)
  2. transact (see 03-transaction-model.md):
     a. read commands row by command_id
        - Committed / TerminalRejected:
            same fingerprint   -> return existing Receipt (no re-execution)
            different fingerprint -> CommandRejection = IdempotencyConflict
        - absent -> continue
     b. if submissionContext is ExecutionOrigin: fence validation
        (04-sqlite-schema.md predicate)
     c. authority / preconditions
     d. domain transition (P0 pure functions)
     e. write canonical state
     f. write Committed receipt + result_json
     g. append Domain Events
  3. COMMIT
```

- Declared actor (`envelope.actor`) is validated separately from the
  authenticated principal (`submissionContext`), DID §4.1.
- ID generation: **all entity IDs are caller-preallocated and carried in the
  payload**; command handlers do not generate IDs (`IdGenerator` is used by
  callers/CLI, not inside the transaction). This keeps the fingerprint
  deterministic.
- `CommandAttempt` is a non-authoritative trace (DID §9.9).

## 3. CreateProject

### Payload (`CreateProjectPayload`)

```ts
{
  name: string
  rootWorkspaceId: WorkspaceId          // caller-preallocated
  primarySessionId: SessionId           // caller-preallocated
  projectPolicy: ProjectPolicy
  projectPolicyRevision: Revision
  defaultConfiguration: Readonly<Record<string, unknown>>
  environmentRef: string
  rootWorkspace: {
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
}
```

`envelope.projectId` **is** the new Project id (caller-preallocated).

### Result

```ts
{ projectId: ProjectId; rootWorkspaceId: WorkspaceId; primarySessionId: SessionId }
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| bootstrap principal lacks authority | `DomainError.AuthorityDenied` |
| duplicate `projectId` with different fingerprint | `CommandRejection.IdempotencyConflict` |

### Emitted events (same transaction, ordered)

```text
ProjectCreated
WorkspaceCreated
```

`primarySessionId` Session is created atomically; **no Session Domain Event**
(DID §5.3 catalog has none).

### Atomicity

Single transaction creates `projects` + `workspaces` (root) + `sessions`
(WorkspacePrimary) using deferred FKs (DID §9.13; DDL in
`04-sqlite-schema.md`).

## 4. CreateChildWorkspace

P1 owns this command (resolves P1-DG-10 child-workspace phase item).

### Payload (`CreateChildWorkspacePayload`)

```ts
{
  parentWorkspaceId: WorkspaceId
  workspaceId: WorkspaceId              // caller-preallocated
  primarySessionId: SessionId           // caller-preallocated
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
| parent workspace not in `envelope.projectId` | `DomainError.AuthorityDenied` |
| parent lifecycle != Active | `DomainError.TerminalLifecycleMutation` |
| expected parent revision mismatch (if supplied) | `DomainError.RevisionConflict` |
| no authority | `DomainError.AuthorityDenied` |
| duplicate id + different fingerprint | `CommandRejection.IdempotencyConflict` |

### Emitted events

```text
WorkspaceCreated
```

Child `WorkspacePrimary` Session is created atomically; no Session event.

## 5. AssignWork

### Payload (`AssignWorkPayload`)

```ts
{
  workId: WorkId                        // caller-preallocated
  workspaceId: WorkspaceId
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

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| workspace not found | `DomainError.WorkspaceNotFound` ⚠ |
| project lifecycle != Open | `DomainError.ProjectClosed` ⚠ |
| no authority | `DomainError.AuthorityDenied` |
| work outside responsibility scope | `DomainError.ResponsibilityViolation` ⚠ |
| workspace retired / not accepting work | `DomainError.RetirePreconditionFailed` |
| duplicate id + different fingerprint | `CommandRejection.IdempotencyConflict` |

⚠ `WorkspaceNotFound`, `ProjectClosed`, `ResponsibilityViolation` are required
by DID §0A.1 but are **not yet in the frozen `DomainError`**. They require a
DID governance patch (to be batched with the P1 authority index, DID v1.6).
Until then this contract lists them as pending and P1 code must not invent
them.

### Emitted events

```text
WorkAssigned
```

## 6. Per-command idempotency

For every P1 command:

```text
same commandId + same fingerprint  -> existing Receipt (Committed or TerminalRejected)
same commandId + different fingerprint -> CommandRejection.IdempotencyConflict
absent -> execute
```

`terminal_error_json` / `result_json` codec: JSON keyed by stored
`schema_version` (frozen in `04-sqlite-schema.md`).

## 7. Out of scope

- Exact payloads for non-P1 commands.
- `GovernanceMutationPlan` (DID §4.1A) beyond P1 commands.
- Message/Decision/Permission commands.
