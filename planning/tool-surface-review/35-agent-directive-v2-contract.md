# AgentDirective v2 Canonical Contract

**Date:** 2026-09-27
**Status:** Canonical contract design; production implementation and
model-facing representation are not authorized

## 1. Contract identity and scope

The proposed canonical contract identity is **`agent-directive-v2`**, contract
revision **2**. Its structured union has **14 branches**:

```text
InvokeTool
AssignWork
Wait
ClaimCompletion
AcceptWorkOutcome
RecordVerificationEvidence
ConcludeVerification
SendMessage
DeclareDependency
ProduceDeliverable
RequestDependencyMatch
Deliver
ProposeChildWorkspace
SpawnSpecialist
```

`RespondToHuman` is an ACTIVE canonical Agent Action, but is represented by the
ordinary bounded `ModelOutput` of a P14 Coordination execution. It is not a
branch in this union. This avoids two competing response channels for one
P14 response episode (`planning/tool-surface-review/27-agent-action-language-governance.md`;
`docs/design/implementation/P14/02-conversation-execution.md` §§1, 4).

`ResponsibilityHandoff` remains `DEFERRED`; it is not an empty or reserved
branch. Runtime automation, human controls, and Prompt or provider
representation details are outside this union.

This document defines canonical semantic payloads only. It does not define
provider tools, JSON Schema, provider-specific flattening, or a representation
compiler. In each branch, `_tag` is the canonical action identity and is
classified as `REPRESENTATION_IDENTITY`; it determines which action is being
expressed, while the payload carries the branch's semantic choices.

## 2. Shared invariants

1. A directive expresses agent intent. It is not an Application Command DTO.
2. The Runtime binds identities and trusted facts already fixed by the
   execution, creates generated identifiers, applies freshness and authority
   checks, and maps accepted intent to existing command/event boundaries.
3. Runtime binding cannot supply missing model intent, choose among ambiguous
   semantic targets, relax an owning validator, or assert a result that only a
   verifier, matcher, Parent, or Human may decide.
4. Existing referenced entities may be selected by their visible canonical
   identity where selection is part of the action semantics. Such an ID is a
   selector, not a caller-generated Runtime ID. Runtime resolves and
   revalidates it.
5. Stale, absent, unauthorized, or ambiguous required targets fail closed.
6. No branch may cause a direct canonical repository write. Canonical mutation
   remains behind the owning Application/CommandGateway boundary.
7. Exact tool schemas, current binding, revisions, authority facts, principals,
   generated IDs, timestamps, session/execution identities, and persistence
   references are not free model choices.

## 3. Branch contracts

The canonical payload fields below are the semantic design. `DESIGN_GAP`
marks an unresolved downstream transformation; it is not permission to fill
the value with a default.

### `InvokeTool`

- **Purpose:** Request one exact admitted capability operation.
- **Model-supplied:** `toolName`; `arguments` conforming to the selected
  model-visible ToolDefinition's input contract.
- **Runtime-bound:** Exact visible tool definition version/hash; invocation
  identity; execution, workspace, session, project, actor/principal; trusted
  InvocationAuthority; control-basis digest; resource resolution; approval
  identity and decision; request time.
- **Representation identity:** `_tag = InvokeTool`. Provider-generated
  `callRef` is transport correlation and is not canonical action meaning.
- **Validation invariants:** Tool name resolves to exactly one definition in
  the turn's manifest; arguments validate against that definition's exact
  input schema; authority, capability ceiling, resource scope, approval,
  freshness, and stop/quiescence checks pass. No tool is invoked by merely
  decoding a proposal.
- **Downstream mapping:** Canonical tool intent → P4 `ToolIntent` plus trusted
  `ToolExecutionContext` → `ToolRuntimePort.invoke` → bounded observation or
  typed denial/failure/unknown settlement.
- **Authority boundary:** P4 ToolRuntime/P12 authority decision. Model
  visibility is not authorization.

### `AssignWork`

- **Purpose:** Assign a new bounded outcome requirement to one Workspace.
- **Model-supplied:** `objective`, `why`, `constraints`,
  `completionExpectation`, and a valid `verificationMission` (goal, structured
  criteria, and risk requirements), as required by the P1 Work payload and
  P8 verification lifecycle.
- **Runtime-bound:** Target Workspace when fixed by the execution/action
  context; project/principal/authority; Work ID; expected Workspace revision;
  Work revision; command identity; provenance envelope.
- **Representation identity:** `_tag = AssignWork`.
- **Validation invariants:** Required semantic text is present; mission meets
  P8's valid mission requirements (non-empty goal, at least one required
  criterion, each criterion has an identity and requirement); assignment
  cannot weaken protected upstream requirements; target is active and
  authorized; revision is current.
- **Downstream mapping:** Intent → P1 `AssignWork` payload and trusted
  authority → `WorkAssigned`/receipt → Work becomes Open.
- **Authority boundary:** P1 AssignWork authority and exact Workspace target.
- **Open mapping issue:** P1 requires `Provenance`, whose member-value
  derivation is not defined by the accepted Action Language or P1 command
  contract. The action decision says provenance is Runtime-bound, but the
  frozen sources do not establish the exact values that preserve causal
  meaning. Do not infer them from `why` or silently fabricate a predecessor.

### `Wait`

- **Purpose:** End the current slice until one or more real canonical
  conditions change.
- **Model-supplied:** Non-empty `reason`; non-empty set of condition intents:
  `DependencyChanged(dependencyId)`,
  `DecisionChanged(decisionId)`,
  `VerificationChanged(workId)`,
  `InboxAdvanced(workspaceId)`,
  `EnvironmentChanged(environmentRef)`,
  `TimeReached(instant)`, or `Manual`.
- **Runtime-bound:** Current Work/Execution binding; authoritative target
  resolution where uniquely fixed; observed dependency/decision/verification
  revision, inbox sequence, or environment revision; durable WorkWait; timer
  and wake registration.
- **Representation identity:** `_tag = Wait`.
- **Validation invariants:** At least one condition; every selected target is
  visible, exists, and is admissible for this execution; observed revisions
  and sequences come from authoritative state, never model input; unbounded
  human wait is explicit `Manual`; no suggestion of a next Work is encoded.
- **Downstream mapping:** Condition intent + Runtime observations → P2
  `WaitSpec` → `SettleExecution(Completed(Yielded))`; P2 registers WorkWait
  and rechecks observed facts atomically.
- **Authority boundary:** P2 settlement and scheduler contracts; source
  phases own wake-signal production.

### `ClaimCompletion`

- **Purpose:** State that the current Work outcome is ready for independent
  verification.
- **Model-supplied:** `claimRef`, the claim/reference supplied by the producer.
- **Runtime-bound:** Current Work and exact revision; execution settlement
  identity/fence; command identity and verification handoff.
- **Representation identity:** `_tag = ClaimCompletion`.
- **Validation invariants:** Only a Work-bound producer can claim; the exact
  current Work revision is carried into settlement; a claim neither completes
  the Work nor stands in for Verification, Acceptance, or `CompleteWork`.
- **Downstream mapping:** Intent → `SettleExecution(Completed(CompletionClaimed
  { workRevision, claimRef }))` → durable `ExecutionSettled` → deterministic
  P8 `StartVerification`.
- **Authority boundary:** P2 execution settlement; P8 owns the verification
  consumer.

### `AcceptWorkOutcome`

- **Purpose:** Record the Parent's judgment that a verified result is
  sufficient for the Parent's outcome.
- **Model-supplied:** Sufficiency judgment. When more than one eligible
  result is presented, an exact selector for the chosen existing
  `(workId, verificationId)` pair; when exactly one is eligible, the selector
  may be omitted and bound uniquely.
- **Runtime-bound:** Selected Work revision; authenticated/authorized actor;
  acceptance identity; project and command identity.
- **Representation identity:** `_tag = AcceptWorkOutcome`.
- **Validation invariants:** The selected Verification is Pass and is bound
  to the selected Work's current exact revision; no silent target selection;
  if no eligible result or an ambiguous unselected set exists, fail closed.
  Acceptance does not itself make Work complete.
- **Downstream mapping:** Intent → P8 `AcceptWorkOutcome` → immutable
  `WorkOutcomeAccepted` → deterministic `CompleteWork` consumer, which
  rechecks the full chain.
- **Authority boundary:** Parent Workspace governance; Root milestone
  acceptance requires the frozen Human authority path.

### `RecordVerificationEvidence`

- **Purpose:** Attribute a concrete evidence source to one Verification
  criterion.
- **Model-supplied:** `criterionId`; selection of an already available
  evidence source relevant to that criterion.
- **Runtime-bound:** Open Verification and exact verifier execution;
  `EvidenceId`; recorded execution identity/time; artifact and environment
  provenance.
- **Representation identity:** `_tag = RecordVerificationEvidence`.
- **Validation invariants:** Criterion belongs to the mission; source exists
  in the verifier's admissible context; only exact VerifierExecution
  authority can append; evidence is append-only; the model cannot create an
  evidence ID or attest an unavailable observation.
- **Downstream mapping:** Intent → P8 `RecordVerificationEvidence` with
  Runtime-created EvidenceRecord → append-only evidence record.
- **Authority boundary:** P8 exact verifier authority; Runtime persists and
  validates provenance.
- **Open mapping issue:** P8's EvidenceRecord schema has `kind`,
  `criterionId`, optional `artifactRef`, environment revision,
  `recordedByExecutionId`, and `recordedAt`, but no frozen field linking a
  `ToolObservation` to its exact source observation/invocation. The canonical
  selected source therefore cannot yet be proven to survive persistence
  without loss.

### `ConcludeVerification`

- **Purpose:** Conclude an open Verification with criterion-level
  Pass/Fail/Unknown judgments and the corresponding overall judgment.
- **Model-supplied:** For each mission criterion, `criterionId`,
  `criterionVerdict`, selected `evidenceRefs`; and the overall
  `Pass | Fail | Unknown` judgment that the model asserts from those
  criterion judgments.
- **Runtime-bound:** Open Verification, target Work/revision, mission
  snapshot, verifier authority, evidence records, conclusion identity/time,
  stored summary reference if its content source is separately resolved.
- **Representation identity:** `_tag = ConcludeVerification`.
- **Validation invariants:** Every mission criterion is represented;
  evidence references resolve and are bound to the criterion; the aggregate
  verdict equals P8's deterministic required-criterion aggregation; concluded
  verdict is immutable. Only the explicit governance orphan path may set
  `conclusionReason = Orphaned`, and only with Unknown; an ordinary verifier
  action cannot request that exemption.
- **Downstream mapping:** Intent → P8 `ConcludeVerification` → immutable
  `VerificationConcluded` and wake effects.
- **Authority boundary:** Exact VerifierExecution authority, except the
  explicitly governed orphan-clearing path.
- **Open mapping issue:** P8's command requires `summaryRef`, but frozen
  sources do not specify whether the referenced content is model-authored,
  an existing artifact, or a deterministic projection. The canonical branch
  cannot invent content or create a reference with no content source.

### `SendMessage`

- **Purpose:** Send one typed cognitive work-plane message.
- **Model-supplied:** `kind = Query | Reply | Report | DecisionRequest`;
  authored body text. `Query` selects an authorized recipient. `Reply`
  selects an exact existing `queryMessageId` only when multiple eligible
  pending Queries exist; a single eligible Query is uniquely Runtime-bound.
- **Runtime-bound:** Sender/principal/project/execution; Report and
  DecisionRequest direct-Parent target; unique Reply target when applicable;
  message/command IDs; body persistence and `bodyRef`; correlation/causation;
  timestamp and fixed `Normal` urgency.
- **Representation identity:** `_tag = SendMessage`; `kind` is a model
  semantic choice inside that action, not a separate canonical action.
- **Validation invariants:** Query recipient is in the authorized query set;
  Report/DecisionRequest recipient is direct Parent; Reply target is an
  eligible pending Query; missing/stale/ambiguous target fails closed; body
  is persisted and resolvable before Message commit; Runtime never changes
  kind, body, discretionary recipient, or selected Query.
- **Downstream mapping:** Intent → Communication Runtime `BlobStore.put`
  and P6 `SendMessage` → `MessageSent`, Inbox admission, and kind-specific
  promotion/wake.
- **Authority boundary:** P6 communication authority and P4 BlobStore body
  persistence; exact semantic closure is
  `31-communication-binding-closure.md` and
  `32-send-message-kind-matrix.md`.

### `DeclareDependency`

- **Purpose:** Create an unmet result contract for the consumer Work.
- **Model-supplied:** `producerBinding` (`AnyProducer`,
  `WorkspaceBound(existing workspace)`, or `WorkBound(existing work)`) and
  `expectedDeliverable` (`kind` and required artifact roles).
- **Runtime-bound:** Consumer Work/current revision and owning Workspace
  from the exact consumer execution; dependency ID/revision; project,
  command, and authority facts.
- **Representation identity:** `_tag = DeclareDependency`.
- **Validation invariants:** Consumer Work is Open and belongs to the
  executing consumer Workspace; producer selectors exist in the same
  Project; expected deliverable is structurally valid; declaration creates
  Unsatisfied state and does not imply waiting or satisfaction.
- **Downstream mapping:** Intent → P7 `DeclareDependency` → `DependencyDeclared`
  → deterministic coordinator reevaluation.
- **Authority boundary:** Consumer-side Workspace authority. Producer-side
  executions cannot declare on behalf of the consumer.

### `ProduceDeliverable`

- **Purpose:** Publish an immutable formal result fact for a source Work.
- **Model-supplied:** `kind`; selected existing artifact references paired
  with their semantic `role`.
- **Runtime-bound:** Source Work/revision from the producer execution;
  Deliverable ID; project, provenance, command, and authority facts.
- **Representation identity:** `_tag = ProduceDeliverable`.
- **Validation invariants:** Artifacts exist and are admissible; source Work
  belongs to the executing Workspace; the source revision is current; the
  Deliverable is immutable. It is a result fact, not proof of verification
  or Parent acceptance.
- **Downstream mapping:** Intent → P7 `ProduceDeliverable` →
  `DeliverableProduced` → coordinator candidate reevaluation.
- **Authority boundary:** Workspace that owns the source Work.

### `RequestDependencyMatch`

- **Purpose:** Ask Runtime to evaluate one exact candidate Dependency and
  Deliverable pair.
- **Model-supplied:** Existing `dependencyId` and `deliverableId` selected
  from available context.
- **Runtime-bound:** Consumer execution/Workspace; current dependency
  revision; project, command identity, and exact ConsumerExecution authority.
- **Representation identity:** `_tag = RequestDependencyMatch`.
- **Validation invariants:** Execution belongs to the Workspace owning the
  consumer Work; both entities exist in the same Project; Dependency is
  Unsatisfied and at the current revision; a match request never asserts
  satisfaction.
- **Downstream mapping:** Intent → P7 `SatisfyDependency` command →
  structural matcher → `DependencySatisfied` only if matcher succeeds;
  otherwise typed rejection and no state transition.
- **Authority boundary:** Exact `ConsumerExecution`; P7 matcher remains the
  only satisfaction authority.

### `Deliver`

- **Purpose:** Formally hand an existing Deliverable from Child to its direct
  Parent.
- **Model-supplied:** Existing `deliverableId`; authored bounded handover
  summary/body.
- **Runtime-bound:** Source Work and owning Workspace; direct-Parent
  recipient; message/command IDs; body persistence/reference; project and
  authority; optional causation/correlation only when uniquely bound.
- **Representation identity:** `_tag = Deliver`. It remains a separate
  Agent Action from `SendMessage`.
- **Validation invariants:** Deliverable exists and belongs to the sending
  Workspace; recipient is exactly the direct Parent; body reference resolves;
  Deliver never creates a Deliverable and never satisfies a Dependency.
- **Downstream mapping:** Intent → P7 Deliver realization → P6
  `SendMessage(kind=Deliver)` → `MessageSent`, Parent Inbox admission, and
  `ChildDelivered` wake.
- **Authority boundary:** Source Workspace ownership and direct-Parent rule.

### `ProposeChildWorkspace`

- **Purpose:** Propose a durable child responsibility with a bounded
  responsibility and resource boundary.
- **Model-supplied:** `name`, `responsibilityDraft`, the semantic resource
  addresses in `resourceBoundaryDraft`, `rationale`, optional `initialWork`
  (`objective`, `why`, `constraints`, `completionExpectation`).
- **Runtime-bound:** Parent Workspace/project/principal/authority; proposal
  identity/revision; structural depth; generated Workspace/Session/Work and
  command identities; the draft boundary's
  `basisResponsibilityRevision` from the current Parent Responsibility;
  first-layer human gate.
- **Representation identity:** `_tag = ProposeChildWorkspace`.
- **Validation invariants:** Non-empty proposal content; boundary must be
  within the Parent's effective ceiling and bind to the current
  Responsibility revision; structural depth, not the model's optional
  informational `formationDepthHint`, determines the human gate;
  approval is an explicit Human fact and never model-authored.
- **Downstream mapping:** Intent → P6 FormationProposal admission; Root
  first-layer proposal → human Inbox and revision-bound RecordDecision;
  deeper proposal → P1 `CreateChildWorkspace`; optional initial Work →
  P1 `AssignWork`.
- **Authority boundary:** Parent formation authority; Root first-layer Human
  approval gate remains mandatory.
- **Open mapping issue:** Frozen P6 `initialWork` omits
  `verificationMission` and maps to a placeholder mission. P8 later rejects
  that placeholder when verification starts and requires a valid mission.
  No ACTIVE v2 action or frozen deterministic transformation supplies the
  missing mission while preserving the approved proposal. This is an
  unresolved formation-to-Work semantic gap.

### `SpawnSpecialist`

- **Purpose:** Request one temporary specialist execution without creating a
  long-lived Workspace responsibility.
- **Model-supplied:** Non-empty `mission`, `constraints`, selected existing
  `skillIds`.
- **Runtime-bound:** Current Workspace/project/principal/authority; parent
  execution; generated specialist Execution/Session/command IDs; safety,
  quiescence, and admission checks.
- **Representation identity:** `_tag = SpawnSpecialist`.
- **Validation invariants:** Mission is non-empty; requested skills resolve
  through the Registry; admission is ExecutionBound to the current Workspace
  and parent execution; stop/quiescence and safety gates pass; settlement
  returns only through the Parent Inbox.
- **Downstream mapping:** Intent → P6 specialist handler/P2
  `AdmitExecution(ExecutionBound)` → specialist Execution settlement →
  Parent Inbox observation.
- **Authority boundary:** Current Workspace execution and capability ceiling.

## 4. Exclusions from the union

| Item | Contract boundary |
|---|---|
| `RespondToHuman` | Ordinary bounded P14 Coordination `ModelOutput`; no directive branch |
| `ResponsibilityHandoff` | `DEFERRED`; no branch or placeholder |
| `StartVerification`, `CompleteWork`, coordinator-side dependency matching | Runtime automation |
| `RecordDecision`, `SteerWork`, `CriticalSteer`, `StopExecution` | Human/Governance controls |
| Provider-specific tool decomposition/flattening | Later Model-family Compiler design; not part of this contract |

## 5. Frozen-source anchors

- Accepted action scope and exclusions: `27-agent-action-language-governance.md`,
  `28-action-language-final-matrix.md`, `29-responsibility-handoff-decision.md`,
  `34-agent-directive-v2-final-readiness.md`.
- Work assignment: `docs/design/implementation/P1/01-command-contracts.md` §7;
  Work fields: `docs/design/03-detailed-implementation-design.md` §3.3.
- Wait and settlement: `docs/design/implementation/P2/05-scheduler-wait.md`
  §§2, 5; `docs/design/implementation/P2/01-command-contracts.md` §7.
- Tool call and effect rules: `docs/design/implementation/P4/01-tool-contracts.md`
  §§1–6; `02-tool-runtime-pipeline.md` §§1–6.
- Completion and acceptance: `docs/design/implementation/P5/03-agent-loop-driver.md`
  §§3–6; `docs/design/implementation/P8/01-verification-commands.md` §§3–5.
- Formation: `docs/design/implementation/P6/01-formation-semantics.md` §§2–4.
- Communication: `31-communication-binding-closure.md`,
  `32-send-message-kind-matrix.md`, `33-reply-target-semantics.md`.
- Dependency/Deliverable: `docs/design/implementation/P7/01-dependency-deliverable-commands.md`
  §§2–4, 9; `02-deliver-primitive.md` §§3–8; `04-coordinator-satisfaction.md` §5.
- Verification evidence: `docs/design/implementation/P8/01-verification-commands.md`
  §§2–4; `04-evidence-binding.md` §§1–3.
