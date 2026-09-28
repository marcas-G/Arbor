# Action Decision vs Explicit Action Review

**Date:** 2026-09-27
**Status:** Design analysis only; no implementation authorization

This review reclassifies the 43 rows in
[22-agent-action-inventory.md](./22-agent-action-inventory.md). The earlier
inventory intentionally listed every observable semantic boundary. It did not
claim that every row deserved a Tool, Directive branch, or canonical Action
identity.

## Classification test

An inventory row remains an explicit action only when it has at least one of
these properties:

1. it produces an external effect;
2. it changes durable system state;
3. it changes Work, Responsibility, or Verification lifecycle;
4. it crosses a Runtime authority/admission boundary;
5. it requires another Workspace or a Human to receive something;
6. it must be audited or replayed as a distinct operation;
7. it must produce a typed structured output.

A model judgment that merely selects *which explicit action comes next* remains
`MODEL_DECISION`. It is observable through the action it causes, but it is not
itself another action surface.

## Result counts

| Classification | Count | Meaning |
|---|---:|---|
| `MODEL_DECISION` | 27 | Reasoning that chooses, scopes, or explains a later action. |
| `EXPLICIT_AGENT_ACTION` | 8 | A typed effect/command boundary that an Agent may request. |
| `RUNTIME_AUTOMATION` | 7 | Deterministic state, safety, consumer, matcher, wake, or admission work. |
| `HUMAN_CONTROL` | 1 | Authenticated human governance choice; not an Agent action. |
| **Total** | **43** | All rows from the prior inventory. |

The earlier count of 26 `MODEL_FACING_ACTION` candidates was a surface
inventory count. It included rows that are now correctly recognized as
reasoning-only or mixed boundaries. The 27 rows below are the stricter
`MODEL_DECISION` count.

## Row-by-row reclassification

| Inventory row | Classification | Reason | Explicit action or destination |
|---|---|---|---|
| `ClarifyDirection` | `MODEL_DECISION` | Chooses whether clarification is needed; the effect is an ordinary human response. | `RespondToHuman` |
| `CommitToStartWork` | `MODEL_DECISION` | Readiness judgment; it does not itself create Work or authority. | `ProposeChildWorkspace`, `SpawnSpecialist`, or ordinary Work action |
| `ProposeResponsibilitySplit` | `MODEL_DECISION` | Chooses own/serial/parallel structure; lifecycle effect belongs to a formation action. | `ProposeChildWorkspace` or `SpawnSpecialist` |
| `SelectNextWorkAction` | `MODEL_DECISION` | General next-step selection is a dispatcher decision, not a new action type. | One explicit action below |
| `TriageIncomingInput` | `MODEL_DECISION` | Decides absorb/queue/steer scope; Inbox and admission are Runtime-owned. | `RespondToHuman`, `SendMessage`, `Wait`, or next Work action |
| `ClassifySteerScope` | `MODEL_DECISION` | Semantic scope classification; it cannot change authority or ownership by itself. | Steer handling, `SendMessage`, or handoff gap |
| `AbsorbCorrection` | `MODEL_DECISION` | Decides which assumptions survive; the durable revision is Runtime/application work. | Next Work action, `SendMessage`, or `Wait` |
| `ResumeAutonomy` | `MODEL_DECISION` | Chooses whether useful work can continue; wake/admission is mechanical. | Any eligible explicit action |
| `ProposeResponsibilityHandoff` | `MODEL_DECISION` | The semantic choice exists, but no complete frozen successor/retire command exists. | `MISSING_ACTION` until the handoff contract is frozen |
| `InvokeExecutableTool` | `EXPLICIT_AGENT_ACTION` | Selects a named capability and exact arguments across ToolRuntime authority. | `InvokeTool` / `A-ENV-01` |
| `ClaimCompletion` | `EXPLICIT_AGENT_ACTION` | Settles a Work turn and starts the verification consumer. | `ClaimCompletion` / `A-WORK-02` |
| `JudgeVerification` | `EXPLICIT_AGENT_ACTION` | S1–S4 require a typed criterion verdict with evidence references; P8 splits its durable effects into evidence append and conclusion. | `RecordVerificationEvidence`, `ConcludeVerification` |
| `RepairOrGatherEvidence` | `MODEL_DECISION` | Chooses the next repair/evidence step; no new generic Repair command is frozen. | `InvokeTool`, `SendMessage`, `Wait`, or normal Work action |
| `IntegrateVerifiedResult` | `MODEL_DECISION` | Parent sufficiency judgment; acceptance is the separate lifecycle command. | `AcceptWorkOutcome` or supplementary Work |
| `SummarizeForParent` | `MODEL_DECISION` | Chooses content and meaning of a later message/delivery. | `SendMessage` or `Deliver` |
| `AssessStageCompletion` | `MODEL_DECISION` | Stage sufficiency is not a canonical transition by itself. | `RespondToHuman`, formation, Work, or communication action |
| `ChoosePostStageConversation` | `MODEL_DECISION` | Chooses the conversational next move. | `RespondToHuman` |
| `ChooseLocalResolution` | `MODEL_DECISION` | Selects local action vs delegation/escalation. | `InvokeTool`, formation, `SendMessage`, or Work action |
| `ChooseCommunicationIntent` | `MODEL_DECISION` | Chooses message meaning; the durable command is shared by P6 kinds. | `SendMessage(kind=...)` or `Deliver` |
| `DeclareDependency` | `EXPLICIT_AGENT_ACTION` | Creates a durable Dependency contract and crosses authority/admission. | `DeclareDependency` / `A-COORD-02` |
| `ProduceDeliverable` | `EXPLICIT_AGENT_ACTION` | Creates an immutable Deliverable fact bound to Work revision. | `ProduceDeliverable` / `A-COORD-03` |
| `ContinueIndependentWork` | `MODEL_DECISION` | Semantic independence determines the next Work action; no separate state transition exists. | Normal Work action or `Wait` |
| `WaitOnCanonicalCondition` | `EXPLICIT_AGENT_ACTION` | Registers durable WorkWait and settles the current slice. | `Wait` / `A-WORK-01` |
| `RequestParentRuling` | `EXPLICIT_AGENT_ACTION` | Sends a typed request to another Workspace; its distinct name is redundant with a message kind. | `SendMessage(kind=DecisionRequest)` |
| `RecoverAfterDenial` | `MODEL_DECISION` | Chooses an allowed alternative after Runtime denial. | `InvokeTool`, `SendMessage`, formation, or `Wait` |
| `RecoverAfterExecutionFault` | `MODEL_DECISION` | Chooses a recovery path; retry limits and safety remain Runtime-owned. | `InvokeTool`, `SendMessage`, `Wait`, or reconciliation read |
| `ReconcileUnknownExternalEffect` | `MODEL_DECISION` | Selects evidence/reconciliation; it does not create a second side-effect action. | `InvokeTool` or `SendMessage` |
| `RestoreContinuationContext` | `MODEL_DECISION` | Selects relevant prior context; retrieval and budget are Runtime-owned. | The next explicit action |
| `AssessStalenessAndDrift` | `MODEL_DECISION` | Determines relevance of changes; invalidation/freshness gates are mechanical. | `InvokeTool`, `SendMessage`, `Wait`, or next Work action |
| `ChooseReentryPath` | `MODEL_DECISION` | Chooses S1/S3 continuation; re-admission is Runtime-owned. | Any eligible explicit action |
| `DistinguishContinuationOrNewResponsibility` | `MODEL_DECISION` | Semantic ownership judgment; no frozen handoff action exists. | Existing Work or `MISSING_ACTION` |
| `ClassifyCriticalStop` | `MODEL_DECISION` | Classifies ordinary-language risk only; the judgment cannot itself create the stop fence. | Advise/clarify; actual `CriticalSteer` / `StopExecution` remains human/system control |
| `ReconcileAfterCriticalStop` | `MODEL_DECISION` | Chooses safe observation/reconciliation after the fence; no new stop action. | `InvokeTool`, `SendMessage`, or `Wait` |
| `IntegrateIncomingResult` | `MODEL_DECISION` | Decides relevance and summary; Inbox admission/wake are Runtime-owned. | `SendMessage`, `Deliver`, or next Work action |
| `RecordHumanFormationDecision` | `HUMAN_CONTROL` | Approval/modify/reject is an authenticated human governance decision. | `RecordDecision`, outside Agent Action Language |
| `StartVerification` | `RUNTIME_AUTOMATION` | Completion consumer deterministically dispatches it. | P8 `StartVerification` |
| `AcceptWorkOutcome` | `EXPLICIT_AGENT_ACTION` | Parent acceptance changes Work lifecycle and requires exact authority/revision binding. | `AcceptWorkOutcome` / `A-WORK-03` |
| `CompleteWork` | `RUNTIME_AUTOMATION` | Deterministic consumer after Pass + Acceptance; no model judgment. | P8 `CompleteWork` |
| `RouteResultAndWake` | `RUNTIME_AUTOMATION` | Inbox, deduplication, and wake are canonical transitions. | P6/P7 routing and wake |
| `EvaluateDependencySatisfaction` | `RUNTIME_AUTOMATION` | Structural matcher, not model judgment. | P7 `SatisfyDependency` protocol path |
| `PersistIdleAndWait` | `RUNTIME_AUTOMATION` | Durable parking and event wake must not depend on a prompt. | P5/P7/P9 wait/continuity |
| `EnforceNoBlindReplay` | `RUNTIME_AUTOMATION` | Hard side-effect safety invariant. | P4/P9/P12 recovery fence |
| `AuthorizeAndAdmit` | `RUNTIME_AUTOMATION` | Authority, capability, resource, and approval checks are mechanical. | P4/P12 admission |

## Pure reasoning decisions

The following clusters should not become extra Tools or Directive branches:

- readiness, stage completion, post-stage conversation, and next-step choice;
- local-vs-parent resolution, dependency relevance, and continue-vs-wait;
- stale/fresh classification, evidence sufficiency, completion readiness, and
  repair necessity;
- steer scope, correction absorption, responsibility continuity, and
  continuation path;
- parent-result relevance and the choice of summary content;
- unknown-effect assessment before choosing a read/reconciliation action.

These decisions remain observable through the explicit action they cause. A
separate reasoning action would create a second representation for the same
intent and would make the model choose “think action” followed by “real
action” without adding a durable semantic boundary.

## Important exceptions

`JudgeVerification` is an explicit typed action because its result crosses two
durable boundaries: append-only evidence and terminal verification conclusion.
The semantic criterion judgment is model-owned; the two command effects remain
separately authorized and audited.

`IntegrateVerifiedResult` is reasoning, but a successful Parent decision crosses
the exact-bound `AcceptWorkOutcome` lifecycle gate. The sufficiency judgment
and the acceptance effect remain distinct.

`RequestParentRuling` is an explicit effect, but it is not a separate canonical
action from `SendMessage(kind=DecisionRequest)`. Its explicitness is retained
through the message kind and command validation, not through a second action
name.

`SatisfyDependency` is a typed protocol transition but not an independent
semantic decision. The matcher decides satisfaction; the P7 coordinator may
submit it automatically, while P7 G6 also preserves a ConsumerExecution
request path. The request is explicit, but the satisfaction result remains
Runtime/protocol-owned.

## Reclassification conclusion

The inventory should no longer be read as “43 tools” or “43 directives”.
After this review, eight source rows are explicit Agent actions, one is a
human control, seven are Runtime automations, and the other 27 are reasoning
that selects or explains one of those boundaries.
