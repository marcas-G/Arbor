# Agent Action Consolidation Matrix

**Date:** 2026-09-27
**Status:** Design analysis only; no implementation authorization

This matrix consolidates the 43 scenario-level rows into the smallest
candidate action vocabulary that still preserves S1–S4 semantics. It compares
the dimensions that determine whether two names are truly different actions:

```text
Intent
Target
Effect
Authority
Lifecycle transition
Required model semantics
Runtime binding
```

The result is a semantic consolidation, not a JSON schema or a provider-facing
tool design.

## Consolidation result

| Source rows | Candidate action or disposition | Intent | Target | Effect / lifecycle | Authority | Decision |
|---|---|---|---|---|---|---|
| `ClarifyDirection`, `AssessStageCompletion`, `ChoosePostStageConversation` | `RespondToHuman` | Explain, clarify, summarize, or hand control back. | Root human conversation. | User-visible bounded response and P14 answered transcript state. | Coordination execution / authenticated conversation context. | **Merge.** The scenarios change the reason for the response, not its durable effect or authority. |
| `CommitToStartWork`, `SelectNextWorkAction`, `ChooseLocalResolution`, `ContinueIndependentWork`, `RecoverAfterDenial`, `RecoverAfterExecutionFault`, `ReconcileUnknownExternalEffect`, `RestoreContinuationContext`, `AssessStalenessAndDrift`, `ChooseReentryPath` | Reasoning around a next action | Decide what to do next from the current frontier. | Varies by next action. | No independent durable transition. | Inherited from the selected action. | **Keep as MODEL_DECISION.** Creating a generic `Act` action would duplicate every real effect surface. |
| `CommitToStartWork` when it becomes a concrete assignment | `AssignWork` | Create a bounded Work record from the accepted objective. | Target Workspace and new Work. | Durable Work lifecycle; exact current Workspace revision. | Workspace governance authority. | **Add explicit action.** Readiness is reasoning; the P1 `AssignWork` command is the effect boundary. |
| `ProposeResponsibilitySplit` | `ProposeChildWorkspace` or `SpawnSpecialist` | Form durable responsibility or temporary execution delegation. | Parent Workspace or current execution. | Workspace/proposal lifecycle versus ExecutionBound admission. | Parent Workspace authority / execution capability ceiling. | **Split by lifecycle.** The source decision is reasoning; the two effects are not mergeable. |
| `ProposeResponsibilityHandoff`, `DistinguishContinuationOrNewResponsibility` | `MISSING_ACTION: ResponsibilityHandoff` | Change long-lived ownership while preserving history. | Workspace lineage / successor relationship. | Successor/retire/handoff lifecycle. | Governance/tree authority. | **Do not invent.** P6 explicitly lacks a complete frozen successor/retire contract. |
| `TriageIncomingInput`, `ClassifySteerScope`, `AbsorbCorrection`, `ResumeAutonomy` | Reasoning before an existing action | Decide scope and next safe step. | Current Work, Inbox, or conversation. | Work revision/Inbox handling is Runtime/application-owned. | Existing steer/stop authority. | **Merge as reasoning.** No separate action is needed for “absorb” or “resume”. |
| `InvokeExecutableTool` | `InvokeTool` | Request one named capability with exact arguments. | Tool and admitted resource regions. | Tool invocation and observation/effect settlement. | Tool catalog, capability, approval, resource, control basis. | **Keep.** Narrow executable boundary with independent audit and reconciliation semantics. |
| `ClaimCompletion` | `ClaimCompletion` | Claim readiness for independent verification. | Current Work/revision. | Execution settlement and deterministic verification dispatch. | Work-bound execution authority. | **Keep.** Changes the Work execution settlement and starts a distinct lifecycle chain. |
| `JudgeVerification` | `RecordVerificationEvidence` + `ConcludeVerification` | Evidence and verdict. | Verification/revision/criteria. | Append evidence versus terminal verdict. | Exact verifier execution authority. | **Split.** Different effects, replay behavior, and lifecycle transitions. |
| `RepairOrGatherEvidence` | Existing Work/tool/message/wait actions | Select a repair or evidence path. | Producer Work, evidence surface, Parent. | No generic Repair lifecycle frozen. | Inherited from selected action. | **Reasoning only.** A generic repair action would be ambiguous and overlap ordinary Work actions. |
| `IntegrateVerifiedResult` | `AcceptWorkOutcome` or supplementary Work | Decide whether verified child output is enough for Parent. | Parent Work / child Work revision. | Acceptance or new Work. | Parent governance chain; exact verification binding. | **Keep acceptance as explicit action; keep sufficiency as reasoning.** |
| `SummarizeForParent`, `IntegrateIncomingResult` | `SendMessage` or `Deliver` | Choose what result meaning must cross Workspace boundary. | Parent or Query target. | Durable message/inbox or formal handover. | Communication authority / direct-parent rule. | **Reasoning merges; effects remain message or delivery.** |
| `ChooseCommunicationIntent`, `RequestParentRuling` | `SendMessage(kind=...)` | Query, Reply, Report, or DecisionRequest. | Kind-specific target/correlation. | Same P6 `SendMessage → MessageSent` and Inbox admission. | Same communication authority; kind-specific validation. | **Merge action identity; retain `kind` as semantic parameter.** |
| `RequestGovernance` | `SendMessage(kind=DecisionRequest)` or formation-derived gate | Parent ruling versus first-layer formation approval. | Parent Inbox versus exact FormationProposal. | Message admission versus governance proposal consumer. | Parent communication authority versus human `RecordDecision`. | **Remove as a generic action.** FormationApproval is derived from first-layer proposal; DecisionRequest is a message kind. Permission expansion has no frozen standalone command. |
| `ProduceDeliverable` | `ProduceDeliverable` | Create an immutable formal result fact. | Source Work/revision and artifact roles. | `DeliverableProduced`; can trigger structural matching. | Source Workspace/Work authority. | **Keep.** Durable fact and audit identity are unique. |
| `Deliver` | `Deliver` | Hand an existing Deliverable to the direct Parent. | Existing Deliverable and direct Parent. | `MessageSent(kind=Deliver)` plus `ChildDelivered` wake; never satisfaction. | Source Workspace ownership and direct-parent constraint. | **Keep separate from `SendMessage`.** Same underlying command family, but different target derivation, payload meaning, wake, and audit semantics. |
| `SatisfyDependency`, `EvaluateDependencySatisfaction` | `RequestDependencySatisfaction` plus Runtime matcher | Request satisfaction for an exact Dependency/Deliverable pair; matcher decides the transition. | Dependency and Deliverable. | `DependencySatisfied` or typed rejection. | Consumer execution request or P7 coordinator; matcher is authoritative. | **Keep the explicit consumer action required by P7 G6, plus automatic Runtime path.** Authority source differs; preserve the frozen route. |
| `DeclareDependency` | `DeclareDependency` | Create an unmet result contract. | Consumer Work and producer binding. | `DependencyDeclared`; no implicit Yield. | Consumer-side Workspace authority. | **Keep.** New durable contract with model-supplied semantic fields. |
| `WaitOnCanonicalCondition`, `PersistIdleAndWait` | `Wait` | Declare a condition under which the current slice can re-enter. | Work/Execution and canonical condition. | WorkWait registration and settlement; zero polling. | Current execution plus scheduler/wake Runtime. | **Keep `Wait`; merge only the model/runtime boundary.** Persisting idle is Runtime automation, not another action. |
| `RecordHumanFormationDecision` | Human `RecordDecision` | Approve, modify, or reject exact proposal revision. | FormationProposal. | Governance fact; consumer may create Workspace after approval. | Authenticated Human only. | **Human control, outside Agent Action Language.** |
| `ClassifyCriticalStop`, `ReconcileAfterCriticalStop` | Human/system Critical Steer + ordinary reconciliation | Stop authority and post-stop reality assessment. | Active execution/effect. | Quiescence fence is human/system control; reconciliation uses existing actions. | Authenticated Critical Steer / Runtime safety. | **Do not expose a generic Agent stop action.** Keep model assessment as reasoning only. |
| `StartVerification`, `CompleteWork`, `RouteResultAndWake`, `EnforceNoBlindReplay`, `AuthorizeAndAdmit` | Runtime automation | Deterministic consumer/safety/admission. | Canonical state, effects, or pending events. | State transitions, gates, wake, replay protection. | Runtime/application authority. | **No Agent actions.** |

## Communication decision: one action or several?

The P6 kinds share one durable command and one core lifecycle:

```text
SendMessage(kind, target/body/correlation)
  → MessageSent
  → Inbox admission
  → kind-specific promotion/wake
```

For `Query`, `Reply`, `Report`, and `DecisionRequest`, the following remain
different:

- `Query` chooses an authorized observation target;
- `Reply` must bind an exact active Query;
- `Report` is child-to-parent cognitive exposure;
- `DecisionRequest` asks for a ruling and triggers parent reevaluation.

Those differences are semantic parameters and validation rules under one
canonical `SendMessage` action because the authority family, durable command,
and basic lifecycle are the same. A future model-family representation may
still expose separate affordances for clarity; that is a representation choice,
not a canonical action split.

`Deliver` remains separate because it references an existing Deliverable,
derives the direct-parent target, emits `ChildDelivered`, and is explicitly
forbidden from satisfying a Dependency. It is not merely another Report
wording.

## RequestGovernance decision

`RequestGovernance` is not a minimal action:

| Apparent intent | Correct action |
|---|---|
| Ask a Parent for a ruling | `SendMessage(kind=DecisionRequest)` |
| Ask the first-layer human to approve a child proposal | `ProposeChildWorkspace` followed by the deterministic FormationProposal gate and human `RecordDecision` |
| Request permission for one concrete operation | Existing authority/approval path; if semantic help is needed, `SendMessage(kind=DecisionRequest)` |
| Escalate an unresolved design issue | `SendMessage(kind=DecisionRequest)` with bounded question and evidence |
| Expand authority or capability | No frozen standalone Agent action; governance contract is deferred |

Keeping one `RequestGovernance` action would make target, actor, authority, and
lifecycle ambiguous.

## Delegation decision

`SpawnSpecialist` and `ProposeChildWorkspace` remain separate:

| Dimension | `SpawnSpecialist` | `ProposeChildWorkspace` |
|---|---|---|
| Target | One ExecutionBound specialist | Long-lived child Workspace |
| Lifetime | One bounded execution; no durable Agent identity | Durable responsibility and primary Session |
| Effect | `AdmitExecution(ExecutionBound)` | FormationProposal or `CreateChildWorkspace`/`AssignWork` |
| Return path | Specialist settlement to Parent Inbox | Workspace/Work lifecycle and later results |
| Authority | Current execution capability ceiling | Parent Workspace formation authority; first-layer human gate |
| Consolidation | **Do not merge** | **Do not merge** |

## P7 disposition

| P7 operation | Classification | Reason |
|---|---|---|
| `ProduceDeliverable` | **Explicit Agent Action** | Creates an immutable, revision-bound result fact with artifact roles and audit identity. |
| `Deliver` | **Explicit Agent Action** | Performs a formal child-to-parent handover with distinct target derivation and wake semantics. |
| `SatisfyDependency` | **Explicit consumer request + Runtime/protocol transition** | Consumer-side Agent may request an exact pair under P7 G6; the matcher, not the model, decides whether the durable transition is legal. P7 coordinator also submits the same command automatically. |

`Deliver` therefore does not collapse into Completion.
`SatisfyDependency` is a model-facing request only on the P7
`ConsumerExecution` route; it is never a model-facing “mark satisfied”
decision, and the P7 coordinator route remains deterministic automation.

## Redundancy and ambiguity findings

| Finding | Source rows | Result |
|---|---|---|
| `REDUNDANT_ACTION` | `RequestParentRuling` vs `SendMessage(kind=DecisionRequest)` | Remove the separate action name. |
| `REDUNDANT_ACTION` | `RequestGovernance` for DecisionRequest vs `SendMessage(kind=DecisionRequest)` | Remove generic governance action. |
| `REDUNDANT_ACTION` | `PersistIdleAndWait` vs `Wait` | Keep only `Wait`; persistence/wake are Runtime. |
| `OVERLAPPING_ACTION` | `ChooseCommunicationIntent`, `SummarizeForParent`, `IntegrateIncomingResult` | Keep as reasoning; final effect is `SendMessage` or `Deliver`. |
| `OVERLAPPING_ACTION` | `SelectNextWorkAction`, `ChooseLocalResolution`, `RecoverAfterDenial`, `RecoverAfterExecutionFault` | Keep as reasoning; selected effect determines action identity. |
| `SAME_EFFECT_DIFFERENT_NAME` | `ClarifyDirection`, `ChoosePostStageConversation`, stage summary | `RespondToHuman`. |
| `SAME_EFFECT_DIFFERENT_NAME` | `RequestParentRuling`, unresolved design escalation, parent help request | `SendMessage(kind=DecisionRequest)`. |
| `SAME_NAME_DIFFERENT_EFFECT` | `Communicate` | Replace with `SendMessage` and separate `Deliver`. |
| `SAME_NAME_DIFFERENT_EFFECT` | `RequestGovernance` | Remove; it spans human approval, parent ruling, and deferred authority governance. |
| `MISSING_ACTION` | `ProposeResponsibilityHandoff`, `DistinguishContinuationOrNewResponsibility` | Frozen S2/S4 semantics require a future handoff/successor contract. |

## Consolidation conclusion

The minimum action identity is determined by downstream effect and authority,
not by the number of reasoning decisions or the number of provider tools. The
candidate language should contain one `SendMessage` action with P6 `kind`
semantics, a separate `Deliver`, separate temporary and durable delegation
actions, and no generic governance/recovery/communication action.
