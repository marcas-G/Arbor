# AgentDirective v2 Branch Matrix

**Date:** 2026-09-27
**Status:** Canonical semantic mapping review; no implementation or
model-facing representation

The 14 rows below are the entire structured v2 scope. `_tag` is
`REPRESENTATION_IDENTITY`; fields in “Model-supplied semantics” carry intent.
Runtime-bound values are added only from authoritative state or derived by a
frozen deterministic contract. Existing entity IDs may appear as model
selectors when target selection is itself semantic.

| Tag / Purpose | Model-supplied semantics | Runtime-bound semantics | Validation invariants | Downstream command/event mapping | Authority boundary | Mapping state |
|---|---|---|---|---|---|---|
| `InvokeTool` — request one admitted capability operation | `toolName`; exact `arguments` for its visible definition | Manifest-bound tool version/hash; invocation ID; execution/session/workspace/project/principal; authority, control basis, resources, approval, timestamp | Unique visible definition; exact input schema; authority/resource/approval/freshness checks; no execution on decode alone | P4 `ToolIntent` + `ToolExecutionContext` → `ToolRuntimePort.invoke` → bounded observation/settlement | P4/P12; visibility ≠ authorization | **CLOSED** |
| `AssignWork` — assign a bounded outcome | `objective`, `why`, `constraints`, `completionExpectation`, valid `verificationMission` | Target Workspace when unique; project/principal/authority; Work ID/revisions/command ID; provenance envelope | P1/P8 mission validity; protected requirements not weakened; active authorized Workspace; exact revision | P1 `AssignWork` → `WorkAssigned` → Open Work | Workspace governance authority | **PARTIAL:** P1 requires Provenance but its exact derivation from active action intent is unspecified |
| `Wait` — stop until canonical condition changes | Non-empty reason; condition intents with existing target selectors or `TimeReached(instant)`/`Manual` | Current Work/Execution; observed revisions/sequences; resolved target when unique; WorkWait/timer/wake identity | Non-empty conditions; references resolve; Runtime alone supplies observed tokens; Manual explicit; lost-wake protection | P2 `SettleExecution(Yielded)` + WorkWait registration → source wake → scheduler reevaluation | P2 settlement/scheduler; source phases produce wake | **CLOSED** |
| `ClaimCompletion` — submit producer readiness for verification | `claimRef` | Current Work/revision; execution settlement/fence; command identity | Work-bound producer only; exact revision; claim does not complete Work | `SettleExecution(CompletionClaimed)` → `ExecutionSettled` → deterministic `StartVerification` | P2 settlement / P8 consumer | **CLOSED** (claimRef retains P2's frozen string meaning) |
| `AcceptWorkOutcome` — Parent sufficiency judgment | Sufficiency judgment; exact existing `(workId, verificationId)` selector if multiple eligible outcomes | Current revision from selected Work; authorized actor; acceptance ID/command ID | Selected verification is Pass for exact current revision; no silent choice; no Work completion by acceptance itself | P8 `AcceptWorkOutcome` → `WorkOutcomeAccepted` → deterministic `CompleteWork` | Parent governance; Root milestone Human authority | **CLOSED** with explicit fail-closed selector rule |
| `RecordVerificationEvidence` — attribute evidence to criterion | `criterionId`; selection of an existing admissible evidence source | Open verification/exact verifier execution; evidence ID, execution ID, time and provenance | Criterion exists; source exists; verifier authority; append-only; no invented evidence | P8 `RecordVerificationEvidence` → EvidenceRecord append | Exact VerifierExecution | **PARTIAL:** EvidenceRecord cannot preserve the exact source of a ToolObservation |
| `ConcludeVerification` — judge criteria and conclude Pass/Fail/Unknown | Per-criterion verdicts and evidence refs; overall verdict assertion | Mission/Work/revision/verification; evidence binding; verifier authority; conclusion identity/time; stored summary reference after content ownership is defined | Complete criteria; all refs resolve; overall verdict equals deterministic aggregation; immutable result; `Orphaned` only in governed Unknown path | P8 `ConcludeVerification` → `VerificationConcluded` + wake | Exact VerifierExecution except governed orphan-clearing | **PARTIAL:** required `summaryRef` content source/owner is not frozen |
| `SendMessage` — typed cognitive communication | Kind; authored body; Query recipient; Reply `queryMessageId` only for multiple pending targets | Sender/project/execution; fixed Parent target or unique Reply binding; IDs; bodyRef/correlation/causation/time | Exact kind/target rules; stale/ambiguous fails closed; persist and resolve body before durable Message | P6 `SendMessage` → `MessageSent` + Inbox/promotion/wake | P6 communication authority / P4 BlobStore | **CLOSED** by 31–33 |
| `DeclareDependency` — define unmet result contract | `producerBinding`; `expectedDeliverable(kind, requiredArtifactRoles)` | Consumer Work/revision/Workspace; Dependency ID/revision; project/authority/command | Open consumer Work; valid same-Project producer selector; declaration does not wait or satisfy | P7 `DeclareDependency` → `DependencyDeclared` → coordinator reevaluation | Consumer-side Workspace authority | **CLOSED** |
| `ProduceDeliverable` — publish immutable result fact | Deliverable `kind`; selected existing `{role, artifactId}` pairs | Source Work/revision; Deliverable/project/command IDs; authority/provenance | Current producer Work; artifacts resolve; immutable result fact; no verification implied | P7 `ProduceDeliverable` → `DeliverableProduced` → coordinator reevaluation | Source Work's Workspace | **CLOSED** |
| `RequestDependencyMatch` — request exact pair evaluation | Existing `dependencyId` + `deliverableId` | Consumer execution/Workspace; current dependency revision; project/command/authority | Exact pair resolves; Dependency Unsatisfied/current; request never claims satisfaction | P7 `SatisfyDependency` → matcher → `DependencySatisfied` or typed rejection | Exact ConsumerExecution; matcher authoritative | **CLOSED** |
| `Deliver` — formal Child-to-Parent handover | Existing `deliverableId`; authored handover summary/body | Source ownership; direct Parent target; IDs, bodyRef, correlation/causation/time, authority | Existing Deliverable owned by sender; direct Parent only; body resolves; no implicit satisfaction | P7 Deliver realization → P6 `SendMessage(kind=Deliver)` → MessageSent/Inbox/ChildDelivered wake | Source Workspace and direct-Parent rule | **CLOSED** |
| `ProposeChildWorkspace` — propose durable child responsibility | Name, responsibility draft, resource addresses, rationale, optional initial Work | Parent/project/principal; current Responsibility revision used as boundary basis; proposal revision/ID; structural depth; child IDs; human gate | Boundary is current-revision-bound and within ceiling; structural depth decides gate; Human approves first-layer proposal; no model-authored approval | P6 FormationProposal; Root gate → exact-revision Human decision; deep path → P1 `CreateChildWorkspace`; optional initial Work → P1 `AssignWork` | Parent formation authority; Root Human gate | **PARTIAL:** optional initial Work lacks valid P8 VerificationMission and no lossless frozen mapping exists |
| `SpawnSpecialist` — request temporary ExecutionBound delegation | Mission, constraints, selected skill IDs | Current Workspace/parent execution/project/principal; generated execution/session/command IDs; safety/quiescence | Non-empty mission; skills resolve; same owning Workspace; admission and stop checks pass | P6/P2 `AdmitExecution(ExecutionBound)` → specialist settlement → Parent Inbox | Current Workspace execution authority | **CLOSED** |

## Field ownership rules

- **Model-supplied** means a semantic choice, authored content, or selected
  existing target/reference. It does not mean the model creates entity identity.
- **Runtime-bound** means a trusted current fact, generated identity,
  observed revision/sequence, provenance, authority, timestamp, or persistence
  result. A Runtime-bound field still needs an authoritative source; the label
  is not permission to guess.
- **Representation identity** is the canonical action tag. Any later mapping
  from a concrete model-visible tool identity to `_tag` belongs to a separate
  representation design.
- No application IDs, authority facts, version tokens, current binding
  metadata, or persistence references are model canonical fields unless an
  existing frozen semantic specifically makes an already-existing identity a
  target selector.

## Scope arithmetic

```text
ACTIVE canonical Agent Actions            15
RespondToHuman on P14 response channel      1
Structured agent-directive-v2 branches    14
ResponsibilityHandoff                      DEFERRED
```
