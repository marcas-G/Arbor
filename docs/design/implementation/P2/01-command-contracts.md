# P2 — 01 Command Contracts

**Authority:** DID v1.7 §3.4, §4.1, §4.3, §4.4, §6A.5, §6A.6, §9.6, §9.7,
§9.9, §12.3, §12.6, §12.7, §12.10, §12.11; DID v1.7 G1/G2/G5.
**Status:** DRAFT (first draft for gap review).
**Implements:** P2 command set, command-specific runtime authority facts,
execution-originated mutation classes.

## 1. P2 command set

`AdmitExecution`, `StopExecution`, `SettleExecution` (DID §4.3).

`RecordEnvironmentChange` is **P11** (DID v1.7 G2). P2 does not implement it
and does not own its DDL; P2 only consumes `environment_revisions` facts
through the P1 `EnvironmentRevisionStore` / `ProjectEnvironmentPort`.

No new Domain Event types are introduced: P2 emits `ExecutionAdmitted`,
`ExecutionStopRequested`, `ExecutionSettled` (DID §5.3). Lease heartbeat,
provider turns, tool invocations and session entry appends are runtime
operational records, **not** Project Domain Events.

## 2. Runtime authority facts (freezes DID v1.7 G1)

Internal runtime commands are **not** exempt from authority. `CommandGateway`
requires an Application-level trusted authority fact for every command. P1
`01` §2A `VerifiedCommandAuthority` remains the fact for the three P1 commands;
P2 adds **command-specific** runtime variants (no generic
`SystemAuthority`/`ExecutionAuthority` category):

```ts
type VerifiedRuntimeCommandAuthority =
  | { readonly _tag: "AdmitExecutionAuthority";
      readonly submissionOrigin: "System";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "AdmitExecution";
      readonly workspaceId: WorkspaceId;
      readonly bindingKind: "WorkspaceMain" | "ExecutionBound" }
  | { readonly _tag: "StopExecutionAuthority";
      readonly submissionOrigin: "System" | "ExecutionOrigin";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "StopExecution";
      readonly executionId: ExecutionId }
  | { readonly _tag: "SettleExecutionAuthority";
      readonly submissionOrigin: "ExecutionOrigin" | "RecoveryController";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "SettleExecution";
      readonly executionId: ExecutionId;
      readonly fencingGeneration?: LeaseGeneration };
```

- The facts are trusted Application-boundary inputs produced by the Runtime;
  they must not be constructed from model output or `CommandEnvelope.payload`.
- Authority is **not** part of `semanticRequestFingerprint`.
- Runtime facts perform deterministic exact-match only. PermissionGrant /
  Parent / User governance resolution stays a later phase.
- `ExecutionOrigin` settlement **must** pass authoritative fencing;
  `RecoveryController` settlement carries no worker `fencingGeneration` and
  uses recovery authority.
- P2 admits only **runtime** origins (`System`, `ExecutionOrigin`,
  `RecoveryController`). External (human/parent) `AdmitExecution` /
  `StopExecution` requires the deferred Authority Resolver
  (PermissionGrant / Parent / User governance) and is **not** admitted in P2;
  it lands with the governance phase (P6/P10). This is why the facts are
  command-specific runtime facts, not a generic system/execution category.
- `CommandRejection` remains `DomainError | FencingRejected | ExecutionStopping
  | WorkspaceNotFound`, extended in P2 with Application-owned
  `ExecutionNotFound { executionId }` (§2.1).

### 2.1 `CommandRejection` evolution (P2)

```ts
type CommandRejection =
  | DomainError
  | { _tag: "FencingRejected" }
  | { _tag: "ExecutionStopping" }
  | { _tag: "WorkspaceNotFound"; workspaceId: WorkspaceId }
  | { _tag: "ExecutionNotFound"; executionId: ExecutionId };   // P2
```

`ExecutionNotFound` is Application-owned and never appears in `DomainError`
(same rule as `WorkspaceNotFound`).

### 2.2 `CommandSubmissionContext` evolution (P2 domain artifact)

Recovery-originated settlement needs an authenticated origin distinct from a
live worker. P2 evolves the P0 `CommandSubmissionContext` (P1 already evolved
P0 artifacts) by adding:

```ts
{ readonly _tag: "RecoveryController";
  readonly principal: Principal;
  readonly causationRef: string }
```

All P1 contexts (`External`, `ExecutionOrigin`, `System`) are unchanged.

### 2.3 Gateway authority parameter (P2 evolution of the P1 seam)

The P1 `CommandGateway.execute(envelope, submissionContext, authority)`
authority parameter type is generalized to:

```ts
type CommandAuthorityFact =
  | VerifiedCommandAuthority          // P1 01 §2A (unchanged)
  | VerifiedRuntimeCommandAuthority;  // P2 §2
```

The P1 exact-match rule is unchanged; each P2 handler declares its authority
tag and target matcher (§4).

## 3. Execution-originated mutation classes (freezes DID v1.7 G1)

The class vocabulary applies **only to Execution-originated mutations**:

```ts
type ExecutionMutationClass =
  | "NormalExecutionMutation"
  | "QuiescenceControlMutation";
```

```text
NormalExecutionMutation
  = admission of a new ProviderTurn / ToolInvocation /
    Execution-originated canonical Command / Specialist spawn
  = forbidden once stopRequestedAt != null -> ExecutionStopping

QuiescenceControlMutation
  = control mutation required to make progress toward quiescence,
    including the ExecutionOrigin path of SettleExecution and
    post-stop reconciliation
  = admitted after stopRequestedAt != null
```

- `AdmitExecution`, `StopExecution` and the `RecoveryController` settlement path
  are **not** forced into this dichotomy (DID v1.7 rev. 2).
- Only `SettleExecution` on the `ExecutionOrigin` path is classified in P2
  (`QuiescenceControlMutation`). Future `NormalExecutionMutation` commands land
  in P3+ and declare their class.
- Both classes still require authoritative fencing; neither may use a
  transaction-external pre-check as final authority.

`CommandHandler` gains a declared `stopAdmission`:

```ts
type StopAdmission =
  | "Normal"             // NormalExecutionMutation
  | "QuiescenceControl"  // QuiescenceControlMutation
  | "Unclassified";      // Admit/Stop/Recovery; not in the dichotomy
```

The gateway passes `handler.stopAdmission` to the `FenceStopCheck` hook
(`02` §4); the hook is only evaluated for `ExecutionOrigin`.

## 4. Authority exact-match (P2)

All conjuncts required; any mismatch → `TerminalRejected(AuthorityDenied)`:

```text
common(authority, envelope, context, fingerprint):
    authority._tag                       == <command authority tag>
  ∧ authority.principal                  == context.principal
  ∧ authority.commandId                  == envelope.commandId
  ∧ authority.semanticRequestFingerprint == fingerprint
  ∧ authority.projectId                  == envelope.projectId
  ∧ authority.submissionOrigin           == context._tag
AdmitExecution : authority.workspaceId == payload.workspaceId
               ∧ authority.bindingKind == payload binding kind
StopExecution  : authority.executionId == payload.executionId
SettleExecution: authority.executionId == payload.executionId
```

`context._tag` mapping: `External` / `System` / `ExecutionOrigin` /
`RecoveryController` are compared literally.

## 5. AdmitExecution

### Payload

```ts
type AdmitExecutionPayload =
  | { readonly _tag: "WorkspaceMain";
      readonly executionId: ExecutionId;        // caller-preallocated
      readonly workspaceId: WorkspaceId;
      readonly focus: ExecutionFocus }          // Work(workId) | Coordination
  | { readonly _tag: "ExecutionBound";
      readonly executionId: ExecutionId;        // caller-preallocated
      readonly workspaceId: WorkspaceId;
      readonly parentExecutionId: ExecutionId;
      readonly mission: string;
      readonly sessionId: SessionId };          // caller-preallocated
```

`envelope.projectId` is the owning Project. All IDs are caller-preallocated;
handlers never generate IDs.

### Result

```ts
{ executionId, workspaceId, sessionId, bindingKind }
```

### Behaviour

- `WorkspaceMain`: snapshot `workspace.primarySessionId` as
  `execution.sessionId`; admission enforces the one-active-main invariant.
- `ExecutionBound`: admission **atomically** creates the durable Execution and
  its `ExecutionScoped` Session in the same transaction; no one-active-main
  constraint and no new specialist concurrency limit.
- `execution.sessionId` is immutable after admission.

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| workspace not found | `CommandRejection.WorkspaceNotFound` |
| `workspace.projectId != envelope.projectId` | `DomainError.AuthorityDenied` |
| workspace lifecycle != Active | `DomainError.TerminalLifecycleMutation` (Workspace) |
| project lifecycle != Open | `DomainError.TerminalLifecycleMutation` (Project) |
| another active main exists (`WorkspaceMain`) | `DomainError.ActiveExecutionConflict` |
| `executionId` already used | defect (invariant violation), not a typed rejection |
| authority mismatch | `DomainError.AuthorityDenied` |

### Events

```text
ExecutionAdmitted
```

## 6. StopExecution

### Payload

```ts
{ readonly executionId: ExecutionId }
```

### Result

```ts
{ executionId, stopRequestedAt }
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| execution not found | `CommandRejection.ExecutionNotFound` |
| `execution.projectId != envelope.projectId` | `DomainError.AuthorityDenied` |
| execution already Settled | `DomainError.TerminalLifecycleMutation` (Execution) |
| authority mismatch | `DomainError.AuthorityDenied` |

Stop on an already-stop-requested Active execution is **idempotent**: the
existing `stopRequestedAt` is returned and no new event is emitted.

### Events

```text
ExecutionStopRequested
```

Stop is a runtime control; it does not cancel the Work (DID §3.4).

## 7. SettleExecution

### Payload

```ts
{ readonly executionId: ExecutionId;
  readonly settlement: ExecutionSettlement;
  readonly expectedFencingGeneration?: LeaseGeneration }
```

`expectedFencingGeneration` is required on the `ExecutionOrigin` path and
absent on the `RecoveryController` path.

### Result

```ts
{ executionId, settlement }
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| execution not found | `CommandRejection.ExecutionNotFound` |
| `execution.projectId != envelope.projectId` | `DomainError.AuthorityDenied` |
| already Settled with a different settlement (new commandId) | `DomainError.TerminalLifecycleMutation` (Execution) |
| already Settled with the same logical request | idempotent existing Receipt (gateway) |
| `ExecutionOrigin` fence invalid | `CommandRejection.FencingRejected` |
| `ExecutionOrigin` + `stopRequestedAt != null` | **admitted** (QuiescenceControlMutation) |
| invalid Settlement ADT (e.g. empty `Yielded` WaitSpec, `OutcomeUnknown` without refs) | `DomainError.AuthorityDenied` (reason) or defect — frozen in `03` §5 |
| authority mismatch | `DomainError.AuthorityDenied` |

`Completed(Yielded)` registers/replaces the durable `WorkWait` **in the same
transaction** and re-reads observed facts; if any observed fact already
changed, the Work must not be permanently parked (`05` §5).

`Completed(CompletionClaimed)` persists the claim/reference + target Work
revision so the durable `ExecutionSettled` event deterministically drives
`StartVerification` (P8); the consumer never bypasses the Command handler.

### Events

```text
ExecutionSettled
```

`SettleExecution` is **not** a lease operation: lease acquisition/renewal/loss
is Runtime ownership state (`03`), not an Execution lifecycle transition.

## 8. Idempotency (inherited)

P2 inherits the P1 pipeline (DID §9.9): same `commandId` + same
`(fingerprint, schemaVersion, algorithmVersion)` → existing receipt; different
fingerprint → `IdempotencyConflict`; operational failure → no authoritative
resolution, retry with the same `commandId`.

## 9. Must Not Decide

- No Worker lease acquisition/renewal/loss as a Command; it is a Runtime port
  operation (`03`).
- No `RecordEnvironmentChange` (P11).
- No specialist spawn/delegation semantics (P6 delegation, P8 Execution-bound
  Verifier); P2 owns only generic `ExecutionBound` admission.
- No full Work runnability/dependency reevaluation (P7).
- No new Domain Event types; no Session Domain Event.
- No PermissionGrant / Parent / User authority resolution (later Authority
  Resolver).
- No durable `Pending` command state; no dual-transaction model.
