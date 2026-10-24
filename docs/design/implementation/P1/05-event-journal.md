# P1 — 05 Event Journal

**Authority:** DID v1.59 §2.3/§5.3/§9.3; DID v1.6 §5.1–§5.4/§9.9
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Closes:** P1-DG-06 (sequence scope, `eventVersion` policy, offset atomicity).

## 1. Sequence scope (frozen)

DID §2.3 allows "Project-local sequence **或** journal partition sequence".
P1 freezes **Project-local monotonic sequence**, backed by a **durable
counter** independent of event rows:

```sql
project_event_sequences (
  project_id     TEXT PRIMARY KEY,
  last_sequence  INTEGER NOT NULL
)
```

Allocation (inside the command transaction, which uses `BEGIN IMMEDIATE`,
`03-transaction-model.md` §2) is an **upsert**, so a new project allocates its
first sequence without a pre-seeded row:

```sql
INSERT INTO project_event_sequences(project_id, last_sequence)
VALUES (?, 1)
ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1
RETURNING last_sequence;
```

`DomainEventJournal.lastSequence(projectId)` returns `0` when the row is
absent.

Rules:

- Allocation happens in the same transaction as the canonical write and the
  event insert; a rollback also rolls back the counter → **no gaps** for
  committed events.
- `BEGIN IMMEDIATE` serializes writers, so concurrent allocation is safe.
- The counter is **not** derived from `domain_events` rows, so retention
  pruning cannot reset it.
- Consumers order strictly by `(project_id, sequence)`.
- `EventId` and `EventSequence` remain distinct (DID §2.3).
- Guarantee is "no gaps at commit time"; consumers must not depend on
  gap-freeness across pruning.

## 2. Append contract

```text
DomainEventJournal.append(drafts)
  input: ReadonlyArray<PendingDomainEvent> = {
    projectId, eventType, eventVersion, occurredAt, aggregateRef, actor,
    causedByCommandId?, causedByEventId?, correlationRef?, payload }
  - requires TransactionScope
  - the journal allocates `eventId` (via IdGenerator) and the next
    project-local `sequence`
  - appended in emitted order
  - payload stored as JSON in domain_events.payload_json
  - atomic with canonical state + Committed receipt (DID §12.6)
```

`domain_events` is the durable outbox (DID §9.9); no separate delivery flag.

## Native OS Sandbox accepted events

`SandboxPolicyDecisionRecorded` is EventVersion 1 and is appended only for a
Committed `DecideSandboxPolicy`, atomically with the decision and receipt.
Payload is the minimal wake/audit tuple
`{workspaceId, executionId, episodeBinding, policyRevision,
permissionGrantId, operatorConfigRevision, operatorConfigDigest}`. The
decision row is written before the Committed receipt/commands row, which is
written before this event; all are one transaction. The consumer rereads the
exact P1 decision row; event payload alone grants no authority.

`SandboxPolicyGrantIssued` is EventVersion 1, emitted only for an exact
Committed `GrantPermission` whose capability is `DecideSandboxPolicy`. Its
closed payload is `{permissionGrantId, grantPermissionCommandId, executionId,
operatorConfigRevision, operatorConfigDigest}`; event envelope Project and
actor bind tenant and issuer. Frozen P1 §3.1 ordering is Grant → provenance →
Committed receipt/commands row → existing `PermissionChanged` event →
this additive event. Both follow the committed receipt; existing
`PermissionChanged` payload/meaning is unchanged. A `TerminalRejected`
command emits neither event.

### FT-DG-01 OPEN-3 activation status event (EventVersion 1)

`WorkspaceResourceActivationChanged` is a new event type whose first and
current EventVersion is 1. Its closed tagged payload is:

```ts
{
  _tag: "WorkspaceResourceActivationChanged";
  workspaceId: WorkspaceId;
  resourceBoundaryRevision: ResourceBoundaryRevision;
  status: "Pending" | "Active";
}
```

The event envelope's `projectId` and `aggregateRef=workspaceId` bind the
payload to the canonical root Workspace. A non-empty Profile CreateProject
appends `Pending` after its existing ProjectCreated(v1) → WorkspaceCreated(v1)
events in the Gateway transaction that also inserts the activation intent and
Committed receipt. ConversationOnly emits no activation event. P11 appends
`Active` only in the same transaction as the exact intent CAS and complete
ownership claim-set commit. The recovery event uses the fixed runtime actor
`system:workspace-resource-activation`; it is not a human, Profile, or authority
identity.

This event carries only workspace/revision/status identifiers. It contains no
path, Profile ref/version, filesystem diagnostic, or user/model text. The new
type is added to the DomainEvent payload/catalog and the P10 consumer's
registered handler; an unregistered type is a projection defect, not a
successful no-op. This event remains exactly v1 under the F18 exact pair
registry below; no EventVersion=2 or upcast is introduced for it.

## 3. `eventVersion` policy (frozen)

```text
- Each event type starts at eventVersion = 1 (per type, not global).
- v1 writer supports eventVersion = 1 only; a draft with another version is a
  writer defect (not a runtime poison).
- v1 reader supports eventVersion <= 1; a stored eventVersion > 1 is poison
  (quarantine + skip).
- Consumers MUST tolerate a higher version by ignoring unknown OPTIONAL
  fields within a supported range (forward-compatible).
- If an event is unprocessable (a required field/version ceiling is exceeded,
  or any deterministic projection defect), it is a POISON EVENT:
    in the SAME transaction: write consumer_dead_letters(consumer_id,
    project_id, sequence, reason) AND advance consumer_offsets.last_sequence
    past that sequence (skip), then alert.
  The offset MUST advance past a quarantined sequence so the consumer never
  stalls (no head-of-line block). Operator reviews dead letters.
- v1 performs NO upcasting.
```

## Accepted F18 exact event type/version registry (DID v1.58)

The accepted F18 Verification v2 decision supersedes the global numeric
reader ceiling above for all new implementations and writes. The authoritative
capability is the exact `(eventType, eventVersion)` pair. `EVENT_CATALOG` is a
closed registry and must equal the following 58 event names exactly:

```text
ProjectCreated, ProjectPolicyChanged, ProjectRenamed, ProjectClosed,
WorkspaceCreated, WorkspaceResourceActivationChanged, ResponsibilityChanged,
ResourceBoundaryChanged, ResourceOwnershipChanged, WorkspacePolicyChanged,
WorkspaceRetired, WorkspaceLineageRecorded, PrimarySessionReplaced,
WorkAssigned, CurrentWorkChanged, WorkRefined, WorkCompleted, WorkCancelled,
WorkSteered, WorkAmended, WorkBlockerResolved, WorkBlockerSuperseded, DependencyDeclared,
DependencySatisfied, DependencyContractRevised, DependencyWithdrawn,
DependencyMarkedUnfulfillable, DeadlockAttentionRequested,
ReconciliationEscalated, AssignWorkTargetBindingEscalated,
DeliverReplayEscalated, ToolObservationReplayEvidenceEscalated,
SubmittedDecisionBindingEscalated, SandboxProviderUnavailable,
LegacyAdoptionEvidenceEscalated, LegacyAdoptionEvidenceResolved,
DeliverableProduced, MessageSent, VerificationStarted, WorkOutcomeAccepted,
ExecutionAdmitted, ExecutionStopRequested, ExecutionSettled,
PermissionChanged, SandboxPolicyGrantIssued, SandboxPolicyDecisionRecorded,
DecisionRecorded, EnvironmentChanged, WorktreeCreated, WorktreeRetired,
HumanInterventionApplied, HumanMessageSubmitted,
ConversationResponseResumed, ConversationResponseCancelled,
ControlApprovalResolved, ExecutableApprovalRequested,
ExecutableApprovalResolved, VerificationConcluded
```

Accepted S2-RDG-01 adds the distinct versioned `WorkAmended` event for a
human-authored Work `ContractAmendment`; `WorkSteered` v1 remains the
DirectionGuidance event. The S2 acceptance does not define a new payload
field set or alter historical event bytes; any payload schema is frozen by its
owning event contract before implementation.

The only legal new writer pair for `VerificationConcluded` is v2. Its strict
historical v1 pair remains reader-only. `WorkAmended` has only the v1 writer
and reader pair; the new event does not version or alter historical
`WorkSteered` v1. Each of the other 56 names has only the v1 writer and reader
pair. There is no default version. A writer validates
the exact pair before sequence allocation or event insertion; an unsupported
new pair is a writer defect and leaves no journal mutation. A reader validates
exact membership before decoding. Unknown event type v1, any non-Verification
v2, and every unlisted version are poison and use the existing CC-3 atomic
dead-letter plus offset-advance disposition. Supported `VerificationConcluded`
v2 uses its strict VCS decoder; no payload is decoded under a different pair.

The same pair table governs Application polling, the SQLite generic runner,
raw journal readers including P10 Attention polling, and every rebuild/replay
path. Adding or removing a catalog name without the exact corresponding
writer/reader decision is a qualification failure. Existing historical bytes,
dead letters and offsets are not rewritten or reset.

## 4. Consumer offset / projection boundary (frozen)

Offset advance and projection write are in the **same SQLite database and
the same transaction** (apply-then-advance), so a crash re-delivers and
re-applies:

```text
transact {
  read events after consumer.last_sequence (batch)
  apply projection writes (same DB)
  advance consumer_offsets.last_sequence to batch end
}
COMMIT
```

- Re-apply idempotency key: `(project_id, sequence)` (equivalently `event_id`).
- `ConsumerOffsetStore.read` returns `0` when the row is absent; `advance`
  upserts.
- Processing a batch: apply each event in order; a poison event is
  dead-lettered and skipped; the offset advances to the last
  processed-or-quarantined sequence in the batch (never stuck on a poison
  event).
- Projection target: a `ProjectionStore` port (`apply(batch)`, `reset()`)
  writing to the same SQLite DB as `consumer_offsets`. P1 provides an in-DB
  test projection; external stores are out of P1 scope.
- Projection failure never rolls back the domain transaction (DID §5.4).
- `consumer_offsets` keyed `(consumer_id, project_id)`, never deleted.
- Single-flight per `(consumer_id, project_id)`; concurrent dispatchers rely
  on `BEGIN IMMEDIATE` + idempotent re-apply.

## 5. Duplicate delivery / event→command

```text
- at-least-once delivery (DID §5.4)
- Event→Command uses a deterministic CommandId so redelivery is idempotent
- Consumer never mutates Domain except through a Command handler
```

## 6. Rebuild

```text
Projection rebuild:
  pruned floor = MIN(domain_events.sequence) for the project (0 if none)
  refuse if consumer offset < pruned floor (events already pruned)
  reset consumer_offsets.last_sequence to the pruned floor
  replay domain_events in (project_id, sequence) order
```

`domain_events` is append-only before the retention horizon
(`04-sqlite-schema.md`); rebuild within retention is always possible.

## 7. Out of scope

- Projection query models (P10).
- Scheduler/coordination consumers (later phases).
- External projection stores.

## Accepted V5 provider-unavailable wake event

P9 appends `SandboxProviderUnavailable` EventVersion 1 atomically with its
immutable P9 source fact and P10 queue row. The exact event payload is
`{attentionFactId, executionId, workspaceId, policyRevision}`; envelope binds
canonical project/workspace, uses the system recovery actor and has no
Command cause. It is only a wake/audit channel, not the fact source. P10
validates it against the P9 fact/queue identity before wake processing. The
fact's `event_id` is not FK-bound to prunable `domain_events`, and journal
pruning cannot delete the P9 fact or durable queue work.

## V21 event boundary

`DecideSandboxPolicy` emits only the existing `SandboxPolicyDecisionRecorded`
event in the exact P1 decision/result/receipt transaction. RecoveryBinding
proof failure has no P9 failure-code event, no P40 replay event, and no
attention marker/event. P10 derives its RecoveryBinding Attention from
existing P4 rows; no event is a truth or rebuild source for that projection.
Actual `SandboxProviderUnavailable(v1)` emission for provider failure remains
as defined above. No event enum/version or journal schema is added.
