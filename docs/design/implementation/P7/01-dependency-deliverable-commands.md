# P7 — 01 Dependency / Deliverable Commands

**Authority:** DID v1.10 §1.8, §4.2, §5.3, §12.10, §12.11, §2.3, §8.15, §8.16, §11 P7; v1.10 G1/G2/G5/G6; SD v1.3 §3.7/§3.8, §7.5; P0 domain (dependency.ts — frozen ADT / transitions / matcher / producer-loss algebra); P6 `01` §4 (deterministic CommandId precedent), P6 `02` §3 (rejection vocabulary), P6 `03` §3 (authority fact projection); `04` (satisfaction submission face), `03` (classification inputs).
**Status:** DRAFT (first draft for contract review). v1.10 G1–G7 are frozen governance inputs; this document implements them and adds no new adjudication.

## 1. Semantic baseline (no domain re-derivation)

```text
Message     = communication                (P6 `02`; Deliver kind owned by `02` of this set)
Deliverable = formal result                (this doc — ProduceDeliverable)
Dependency  = unmet result requirement     (this doc — six state commands)
```

- Every ADT, lifecycle transition, the structural matcher (`matchesExpectedDeliverable`) and the producer-loss algebra are the frozen P0 implementation (`packages/domain/src/dependency.ts`). P7 reuses them verbatim. This contract freezes only command-level semantics: payload / precondition / rejection / event / authority shapes, at signature level (handler form follows `send-message.ts` / `record-decision.ts`).
- G2 division of labor (frozen): `ProduceDeliverable` creates the Deliverable fact (bound to a source Work revision); `Deliver` (Message kind, `02`) delivers an existing Deliverable child → parent; `SatisfyDependency` is the only Dependency state mutation. No command in this document is triggered or satisfied by a Deliver message.
- Orthogonality (G2, incorporating ex-GQ5): satisfaction is structural matching only. **No Verification PASS, no CompletionClaim, no Acceptance is a precondition of any command here.** Quality gates live in P8's Verification → Acceptance chain (SD §3.7; DID v1.9 G4). A structurally matched but unverified Deliverable satisfies.
- All six commands are Project-scoped via `CommandEnvelope.projectId` (P1); cross-Project targets are rejected (see per-command rows).

## 2. `DeclareDependency`

Discharges the last `DirectiveUnsupported` row of P5 `03` §2 (DID §11 P7).

### Payload

```ts
{
  readonly dependencyId: DependencyId;                  // caller-preallocated
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;            // AnyProducer | WorkspaceBound | WorkBound (P0)
  readonly expectedDeliverable: ExpectedDeliverable;    // kind + requiredArtifactRoles (P0)
  readonly expectedConsumerWorkRevision: WorkRevision;  // optimistic consumer Work binding
  readonly revision: DependencyRevision;                // initial 0 (P0 DeclareDependencyInput)
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| consumer Work not found | `CommandRejection.WorkNotFound` (P6 `04` §2 frozen enum) |
| consumer Work lifecycle != Open | `DomainError.TerminalLifecycleMutation`(Work) |
| `expectedConsumerWorkRevision` != current Work revision | `DomainError.RevisionConflict` |
| consumer Work's Workspace Retired | `DomainError.TerminalLifecycleMutation`(Workspace) |
| declarer authority ≠ agent (or human governance chain) of the Workspace owning the consumer Work | `DomainError.AuthorityDenied` |
| `WorkspaceBound(ws)` target not found or in another Project | `DomainError.AuthorityDenied` (cross-Project producer binding forbidden) |
| `WorkBound(w)` target not found or in another Project | `DomainError.AuthorityDenied` (cross-Project producer binding forbidden) |

### Events

```text
DependencyDeclared { dependencyId, consumerWorkId, producerBinding, expectedDeliverable, revision }
```

`DependencyDeclared` is a coordinator re-check trigger (`04` §1).

### Authority fact

```text
DeclareDependencyAuthority {
  targetWorkspaceId,        // Workspace owning consumerWorkId
  consumerWorkId,
  commandId, semanticRequestFingerprint, projectId
}
```

P6 `03` §3 projection family (WorkspaceAgentAuthority). DeclareDependency does not imply Yield (DID §8.16).

## 3. `ProduceDeliverable`

### Payload

```ts
{
  readonly deliverableId: DeliverableId;                // caller-preallocated
  readonly sourceWorkId: WorkId;
  readonly observedSourceWorkRevision: WorkRevision;    // optimistic binding at produce time
  readonly kind: DeliverableKind;                       // branded string (P0)
  readonly artifacts: ReadonlyArray<{ role: ArtifactRole; artifactId: ArtifactId }>;
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| source Work not found | `CommandRejection.WorkNotFound` |
| source Work lifecycle = Cancelled | `DomainError.TerminalLifecycleMutation`(Work) |
| `observedSourceWorkRevision` != current Work revision | `DomainError.RevisionConflict` |
| submitter authority ≠ agent of the Workspace owning the source Work | `DomainError.AuthorityDenied` |

- Completed source Work is **not** rejected: a Deliverable is a result fact, not a verified result; late recording against a Completed Work revision remains traceable. The quality chain belongs to P8 (G2 orthogonality, §1).
- A Work may produce multiple Deliverables (distinct deliverableId / revision bindings). Re-submitting the same deliverableId is absorbed by the existing CommandReceipt (P1 §8); Deliverables are immutable — no update path (§10).

### Events

```text
DeliverableProduced { deliverableId, sourceWorkId, sourceWorkRevision, kind, artifactRoles }
```

`DeliverableProduced` is the coordinator's primary trigger (`04` §1).

### Authority fact

```text
ProduceDeliverableAuthority {
  sourceWorkspaceId,        // Workspace owning sourceWorkId
  sourceWorkId,
  commandId, semanticRequestFingerprint, projectId
}
```

## 4. `SatisfyDependency`

The single Dependency-satisfaction command face: agent path and coordinator path submit the **same Command**, hit the **same handler and rejection table**, and are gated by the **same matcher** (v1.10 G6; `04` §5). Request ≠ satisfaction: the authority fact legalizes submission; the matcher decides the fact.

### Payload

```ts
{
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;  // must equal current revision (DID §1.8)
  readonly deliverableId: DeliverableId;
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| dependency not found | `CommandRejection.DependencyNotFound` (**P7 frozen new enum**) |
| dependency state != Unsatisfied | `DomainError.TerminalLifecycleMutation`(Dependency) |
| `targetDependencyRevision` != dependency.revision | `DomainError.RevisionConflict` |
| deliverable not found | `CommandRejection.DeliverableNotFound` (**P7 frozen new enum**) |
| deliverable belongs to another Project | `DomainError.AuthorityDenied` (Project boundary precedes the matcher; `AnyProducer` must not cross Projects) |
| `matchesExpectedDeliverable(producerBinding, expectedDeliverable, view) === false` | `DomainError.DependencyNotSatisfiable` (state unchanged; DID §1.8) |
| authority fact not exact-bound to (dependencyId, deliverableId) | `DomainError.AuthorityDenied` |

### Events

```text
DependencySatisfied { dependencyId, targetDependencyRevision, deliverableId, satisfiedAtDependencyRevision }
```

Satisfaction records are immutable; later contract changes form a new revision, never a silent reinterpretation (DID §1.8 / §12.11).

### Authority fact (exact-bound, G6)

```ts
{
  readonly _tag: "SatisfyDependencyAuthority";
  readonly source:
    | { readonly _tag: "ConsumerExecution"; readonly workspaceId: WorkspaceId; readonly executionId: ExecutionId }
    | { readonly _tag: "P7Coordinator" };
  readonly targetWorkspaceId: WorkspaceId;             // Workspace owning the consumer Work
  readonly dependencyId: DependencyId;
  readonly deliverableId: DeliverableId;
  readonly commandId: CommandId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly projectId: ProjectId;
}
```

- Source is exactly two-valued (`ConsumerExecution` = an execution of the Workspace owning the consumer Work; `P7Coordinator`). Anything else → `DomainError.AuthorityDenied` (G6; `04` §5).
- Agent directive path: the executing Workspace must own the consumer Work; the directive handler projects the `ConsumerExecution`-sourced fact (P6 `03` §3 shape). A producer-side agent cannot satisfy on the consumer's behalf.
- Coordinator automatic path: event-driven (`DeliverableProduced` / re-check triggers), project-scoped candidate lookup, deterministic matcher, submission via CommandGateway with `source: P7Coordinator` — fully specified in `04`; this section owns only the command contract.
- Automatic-path CommandId is deterministic: `f(deliverableId, dependencyId, targetDependencyRevision)` — at-least-once redelivery is absorbed idempotently by the existing receipt (DID §5.4; P6 `01` §4.2 precedent). Agent path uses caller-preallocated ids.

### Concurrency (frozen)

Two deliverables racing for one dependency → first committer wins (state + revision CAS at `DependencyRepository`, L3). The loser receives a typed rejection according to what it observes: `TerminalLifecycleMutation`(Dependency) (already Satisfied), `RevisionConflict` (revision moved, stale binding), or `DependencyNotSatisfiable` (matcher false under a revised contract). The automatic path never retries a lost race — redelivery is absorbed by the deterministic CommandId (`04` §2).

### Commit boundary

State CAS + event + `DependencyChanged` wake-signal production share one transaction (DID §8.16 source-phase duty). Wake-reason mapping and consumer-side routing are owned by the P7 wake-integration contract, not here.

## 5. `WithdrawDependency` (v1.10 G1)

Consumer no longer requires the result (DID §12.11).

### Payload

```ts
{
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;  // must equal current
  readonly reason: string;                               // non-empty governance trace
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| dependency not found | `CommandRejection.DependencyNotFound` |
| state != Unsatisfied | `DomainError.TerminalLifecycleMutation`(Dependency) |
| revision mismatch | `DomainError.RevisionConflict` |
| authority ≠ consumer-side governance (agent or human governance chain of the Workspace owning the consumer Work) | `DomainError.AuthorityDenied` |

### Events

```text
DependencyWithdrawn { dependencyId, fromRevision, reason }
```

Terminal (`Withdrawn`); a new requirement means a new Dependency, never history rewrite (DID §12.11).

### Authority fact

```text
WithdrawDependencyAuthority { targetWorkspaceId, dependencyId, commandId, semanticRequestFingerprint, projectId }
```

## 6. `MarkDependencyUnfulfillable` (v1.10 G1)

Requirement still needed but the current contract is confirmed unfulfillable — an adjudicated conclusion (S3 step 12).

### Payload

```ts
{
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;  // must equal current
  readonly justification: string;                        // non-empty
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| dependency not found | `CommandRejection.DependencyNotFound` |
| state != Unsatisfied | `DomainError.TerminalLifecycleMutation`(Dependency) |
| revision mismatch | `DomainError.RevisionConflict` |
| authority ≠ adjudication source (parent governance chain of the consumer Workspace, or human principal) | `DomainError.AuthorityDenied` |

The consumer's own agent may Withdraw ("no longer needed") but cannot unilaterally declare Unfulfillable — that is a producer-loss / escalation adjudication, not a consumer-side want.

### Events

```text
DependencyMarkedUnfulfillable { dependencyId, fromRevision, justification }
```

- Terminal (`Unfulfillable`) and **emits an Attention fact** (§12.10 invariant column; SD §7.2). Attention is an L6 derived projection input; no new event kind and no Attention projection shape is frozen here.
- Terminal state is also a coordinator re-check trigger point (uniformly idempotent, no submission possible — `04` §1).

### Authority fact

```text
MarkDependencyUnfulfillableAuthority { targetWorkspaceId, dependencyId, commandId, semanticRequestFingerprint, projectId }
```

## 7. `ReviseDependencyContract` (v1.10 G1)

### Payload

```ts
{
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;   // must equal current
  readonly newExpectedDeliverable: ExpectedDeliverable;   // replacement contract
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| dependency not found | `CommandRejection.DependencyNotFound` |
| state != Unsatisfied ("not yet terminal", §12.11) | `DomainError.TerminalLifecycleMutation`(Dependency) |
| revision mismatch | `DomainError.RevisionConflict` |
| authority ≠ consumer-side (same rule as Declare, §2) | `DomainError.AuthorityDenied` |

- Transition: `Unsatisfied → Unsatisfied`, `revision = targetDependencyRevision + 1` (P0 `reviseExpectedContract`; §12.11 "revise expected contract" row).
- **`producerBinding` is immutable for a Dependency identity** (P0 freezes only expectedDeliverable replacement): re-binding requires Withdraw + new Declare — deterministic, no history rewrite (§12.11 "新 contract 在 terminal dependency 后创建新 Dependency").
- Never reinterprets prior satisfaction: recorded satisfaction stays bound to its `satisfiedAtDependencyRevision` (§12.10 invariant column; DID §1.8). Deliverables bound to old source Work revisions do not satisfy the new revision by accident — matcher re-evaluation is per current contract only.

### Events

```text
DependencyContractRevised { dependencyId, fromRevision, toRevision, expectedDeliverable }
```

(v1.10 G1 addition to the §5.3 catalog.) Coordinator re-check trigger (`04` §1).

### Authority fact

```text
ReviseDependencyContractAuthority { targetWorkspaceId, dependencyId, commandId, semanticRequestFingerprint, projectId }
```

## 8. Derived in-transaction transitions (not standalone commands)

- **Consumer Work cancellation**: within the `CancelWork` governance transaction, `withdrawDependenciesOnWorkCancel(consumerWorkId, deps)` (P0) transitions remaining Unsatisfied dependencies of that Work to `Withdrawn`; one `DependencyWithdrawn` event per affected dependency, same transaction (§12.11).
- **Producer loss**: within the Work-cancellation / Workspace-retirement governance transaction, `markUnfulfillableOnProducerLoss(facts, deps)` (P0) applies the §12.11 producer-loss rules (`WorkBound` + Work cancelled → Unfulfillable; `WorkspaceBound` + Workspace retired → Unfulfillable; `AnyProducer` immune; atomic replacement exempt via `replacedInSameGovernanceChange`); one `DependencyMarkedUnfulfillable` + Attention fact per affected dependency, same transaction.
- These are consequences of owning governance commands, not free-floating batch mutations; no consumer path may bypass the Command Handler (DID §5.4).

## 9. Directive realization (§8.15, v1.10 G2/G6)

The §8.15 `AgentDirective` vocabulary gains `ProduceDeliverable` / `SatisfyDependency` (G6) and already lists `DeclareDependency`; `Deliver` is owned by `02` §8.

```ts
interface DeclareDependencySpec {
  readonly consumerWorkId: WorkId;                 // must be a Work of the executing Workspace
  readonly producerBinding: ProducerBinding;
  readonly expectedDeliverable: ExpectedDeliverable;
}
interface ProduceDeliverableSpec {
  readonly sourceWorkId: WorkId;
  readonly kind: DeliverableKind;
  readonly artifacts: ReadonlyArray<{ role: ArtifactRole; artifactId: ArtifactId }>;
}
```

- Directive handlers allocate ids (dependencyId / deliverableId / commandId caller-preallocated), read observed revisions at submission (consumer Work revision; source Work = the executing Workspace's Work), project the authority facts of §2/§3, and submit via `CommandGateway` (P3 `03` §3).
- The `SatisfyDependency` directive (consumer side only, `ConsumerExecution` authority) is frozen in `04` §5 — single command face, no agent-path exemption from the matcher.
- Command rejections surface as directive execution results / model-visible observations (P5 `03` vocabulary), never as Execution failures.

## 10. Persistence boundary

- Stores: `DependencyRepository` / `DeliverableRepository` (§12.10 store column); tables `dependencies` / `deliverables` / `deliverable_artifacts` (§9.3).
- `DependencyRepository` applies state + revision CAS (first committer wins; P6 `FormationProposalStore.decideIfPendingRevision` precedent). `deliverables` / `deliverable_artifacts` are immutable — no update path.
- SQL DDL and migration numbering are task-level implementation, constrained by architecture tests (P6 R5 precedent).

## 11. Must Not Decide

- No matcher / algorithm / Dependency state-machine modification (DID §1.8, §12.11; P0 implemented).
- No metadata query / regex / semantic similarity / LLM matcher (DID §1.8 ban).
- No P8 semantics: no Verification / Acceptance / `CompleteWork`, no quality gate on satisfaction (G2 orthogonality).
- No Message kind set / Inbox semantics modification (P6 `02` owns; the `Deliver` kind is owned by `02` of this set).
- No candidate-lookup implementation shape freeze — scan vs index is explicitly open (G5; `04` §3).
- No scheduler decision-table / WorkWait mechanism modification (P2; §8.18A; classification inputs owned by `03`).
- No wake-reason mapping or consumer-side routing (P7 wake-integration contract owns; this doc only freezes same-boundary signal production).
- No new WakeCondition / WakeReason variants.
- No Attention / deadlock projection shape (L6 derived facts; `DeadlockAttentionRequested` and the wait-graph are owned by the P7 wait-graph contract).
- No Authority Resolver / PermissionGrant principal system (deferred seam; P6 `03` §1).
- No `RetireWorkspace` / Successor semantics (this contract only consumes retirement facts per §12.11).
- No DDL / migration-numbering freeze (task level).
