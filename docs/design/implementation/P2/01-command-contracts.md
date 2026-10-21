# P2 — 01 Command Contracts

**Authority:** DID v1.7 §3.4, §4.1, §4.3, §4.4, §6A.5, §6A.6, §9.6, §9.7,
§9.9, §12.3, §12.6, §12.7, §12.10, §12.11; DID v1.7 G1/G2/G5.
**Status:** DRAFT (first draft for gap review).
**Implements:** P2 command set, command-specific runtime authority facts,
execution-originated mutation classes.

## 1. P2 command set

`AdmitExecution`, `StopExecution`, `SettleExecution` (DID §4.3).

FT-DG-03 codec/validation contract (DID §4.1B): the exact typed payloads and
origin distinctions below remain P2-owned. The current composed registry has
one descriptor per P2 handler; wire-v1 decoding and typed internal semantic
validation use these payload contracts without widening P2 origins or
authority facts. External `AdmitExecution` remains unexposed under P13 U-3.

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
      readonly submissionOrigin: "System" | "External";   // External: P12 TR-8
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "AdmitExecution";
      readonly workspaceId: WorkspaceId;
      readonly episodeBinding: ExecutionEpisodeBinding }
  | { readonly _tag: "StopExecutionAuthority";
      readonly submissionOrigin: "System" | "ExecutionOrigin" | "External";   // External: P12 TR-8
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
- P2 admits the runtime origins (`System`, `ExecutionOrigin`,
  `RecoveryController`) plus the **external** (human/parent) origin for
  `AdmitExecution` / `StopExecution`. External origin is **produced** by the
  Authority Resolver (P12 `02` §4), which resolves PermissionGrant / Parent /
  User governance; P2 only consumes/validates the trusted fact. This is why the
  facts are command-specific runtime facts, not a generic system/execution
  category.
- **P12 TR-8 propagation (P12 `02` §4; DID v1.14 G2 / v1.13 G4).** The
  `submissionOrigin` unions above are widened to include `"External"` for
  `AdmitExecutionAuthority` / `StopExecutionAuthority`, matching DID §4.1. This
  reconciles the P2 `00` R1 restriction (the deferred resolver is P12, not
  P6/P10); P2 runtime semantics are otherwise unchanged. The authority facts
  remain trusted Application-boundary inputs, never constructed from model
  output or `CommandEnvelope.payload`.
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

`CommandHandler` gains a declared `stopAdmission` as an explicit ADT (never a
boolean):

```ts
type StopAdmission =
  | { readonly _tag: "NormalExecutionMutation" }
  | { readonly _tag: "QuiescenceControlMutation" }
  | { readonly _tag: "StopControl" }     // StopExecution itself
  | { readonly _tag: "Unclassified" };   // System / RecoveryController only
```

Stop-admission policy (fail-closed; the hook is evaluated only for
`ExecutionOrigin`):

```text
NormalExecutionMutation  -> ExecutionStopping if stop_requested_at != null
QuiescenceControlMutation-> Pass (fence still authoritative)
StopControl              -> Pass (the stop request itself)
Unclassified             -> defect for ExecutionOrigin;
                            valid only for System / RecoveryController
```

Any future Execution-originated command MUST declare
`NormalExecutionMutation` or `QuiescenceControlMutation`; `Unclassified` is
reserved for the P2 commands whose origin is System / RecoveryController.
The gateway passes `handler.stopAdmission` to the `FenceStopCheck` hook
(`02` §4).

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
               ∧ authority.episodeBinding == payload.episodeBinding
StopExecution  : authority.executionId == payload.executionId
SettleExecution: authority.executionId == payload.executionId
```

`context._tag` mapping: `External` / `System` / `ExecutionOrigin` /
`RecoveryController` are compared literally.

## 5. AdmitExecution

### Payload

```ts
type AdmitExecutionPayload =
  { readonly executionId: ExecutionId;          // caller-preallocated
    readonly workspaceId: WorkspaceId;
    readonly episodeBinding: ExecutionEpisodeBinding };
```

`envelope.projectId` is the owning Project. All IDs are caller-preallocated;
handlers never generate IDs.

### Result

```ts
{ executionId, workspaceId, sessionId, episodeBinding }
```

### Behaviour

- Resolve the exact binding-specific Session and enforce the
  binding's identity/revision contract; an episode is not selected by a
  Work/Coordination focus flag.
- Admission **atomically** creates the durable Execution and its bound Session
  in the same transaction; it does not introduce a first-class Specialist or
  Coordination execution category.
- `execution.sessionId` is immutable after admission.
- The durable `Execution` record carries the owning `workspaceId` (`04` §3.1);
  its exact episode identity is carried by `ExecutionEpisodeBinding`.

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| workspace not found | `CommandRejection.WorkspaceNotFound` |
| `workspace.projectId != envelope.projectId` | `DomainError.AuthorityDenied` |
| workspace lifecycle != Active | `DomainError.TerminalLifecycleMutation` (Workspace) |
| project lifecycle != Open | `DomainError.TerminalLifecycleMutation` (Project) |
| exact episode binding conflicts with an already active exact binding | `DomainError.ActiveExecutionConflict` |
| `executionId` already used | defect (invariant violation), not a typed rejection |
| authority mismatch | `DomainError.AuthorityDenied` |

RAI-DG-01 admission overlay: for a candidate bound to an exact Work Episode,
the handler revalidates canonical Work identity/revision and
`WorkReadmissionGateStore.hasBlockingSource` inside the same authoritative
`BEGIN IMMEDIATE` transaction that commits `ExecutionAdmitted`. A matching
durable source yields typed `WorkReadmissionHeld`; canonical target identity,
scope or revision mismatch yields `ReadmissionTargetMismatch`; malformed,
missing, duplicate or conflicting source evidence yields
`ReadmissionGateIntegrityFailure`. Each branch commits no Execution. These
are runtime admission results, not new Domain Events, Work lifecycle changes
or `CommandRejection` variants. Non-Work Episode admission is unchanged.

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
existing `stopRequestedAt` is returned and no new event is emitted. The domain
`Execution` carries `stopRequestedAt: string | null`, matching
`executions.stop_requested_at` (R9).

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

The accepted `Completed(Blocked)` result carries the exact shape:

```ts
type BlockedWorkEpisode = {
  readonly workId: WorkId;                 // Runtime-bound from episodeBinding
  readonly targetWorkRevision: WorkRevision;
  readonly waitFor: {
    readonly mode: "Any";
    readonly conditions: readonly [
      { readonly _tag: "Manual" },
      { readonly _tag: "InboxAdvanced"; readonly workspaceId: WorkspaceId;
        readonly observedSequence: number }
    ];
  };
  readonly failedActionRefs: NonEmptyArray<{
    readonly executionId: ExecutionId;
    readonly providerTurnId: ProviderTurnId;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex: number;
    readonly logicalActionId: LogicalActionId;
    readonly callRef: string;
    readonly resultRef: string;
    readonly settlementRef: string;
    readonly observationSourceRef: string;
    readonly toolInvocationId?: ToolInvocationId;
    readonly terminalDenial: TerminalActionDenial;
  }>;
  readonly request: BoundedText;           // descriptive only
  readonly blockerId: Sha256;              // Runtime-computed
};
```

`Completed(Blocked)` is valid only for an exact WorkEpisode and its typed
terminal denied-action evidence. The same canonical transaction writes the
settlement/event, opens or updates each deterministic `WorkBlocker`, stores
the latest bounded request, and registers `Manual + InboxAdvanced` for the
Runtime-bound Workspace Inbox sequence. It re-reads exact Work revision and
Inbox sequence before commit; if either changed it commits the stable outcome
but queues immediate reevaluation rather than parking. Missing or mismatched
denial evidence rejects the settlement. P2 does not consult Plan status.

`Completed(CompletionClaimed)` persists the claim/reference + target Work
revision so the durable `ExecutionSettled` event deterministically drives
`StartVerification` (P8); the consumer never bypasses the Command handler.

`failedActionRefs[].providerTurnId` uses the closed DID §2.2.1 codec. New P2
Blocked results can reference only the exact current P3 Action/Step source and
therefore use its V2 identity. The external action-reference decoder may read
a legacy UUIDv7 only when P2's existing source binding proves that exact
persisted reference; caller text never allocates or rebinds a ProviderTurn.
The resulting `CommandReceipt` retains the original encoded value for exact
same-CommandId replay. Unknown ProviderTurnId formats fail the existing strict
command/source validation.

### Events

```text
ExecutionSettled
```

`SettleExecution` is **not** a lease operation: lease acquisition/renewal/loss
is Runtime ownership state (`03`), not an Execution lifecycle transition.

> **P12 TR-9 propagation (P12 `06` §3).** The lease holder / fence identity is
> the triple `(worker_id, worker_incarnation_id, generation)`; `worker_incarnation_id`
> is added to `execution_leases` (`04` §3.2) and the `ExecutionRepository` /
> `LeaseService` / `SessionRepository.appendEntry` / `FenceStopCheck` surfaces
> (`02` §2–§4, §6) carry it. This is not a command payload/authority change:
> `expectedFencingGeneration` and the authority facts are unchanged.

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
  Verifier); P2 owns only generic exact `ExecutionEpisodeBinding` admission.
- No full Work runnability/dependency reevaluation (P7).
- No new Domain Event types; no Session Domain Event.
- No PermissionGrant / Parent / User authority resolution (later Authority
  Resolver).
- No durable `Pending` command state; no dual-transaction model.
