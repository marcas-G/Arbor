# Arbor Agent Action Inventory

**Date:** 2026-09-27  
**Status:** Design / audit only; no production implementation authorized  
**Scope:** S1–S4 frozen scenarios, the 49-point behavioral decision map, and the
current P1/P3/P4/P5/P6/P7/P8/P9/P11/P12 contracts.

This inventory deliberately does not use the current ten `agent-directive-v1`
branches as its starting point. It starts from the semantic actions required by
S1–S4, then classifies each action as a model-facing decision, an executable
tool call, an application command request, a mixed model/runtime boundary, or a
Runtime-only transition.

The source decision points are:

- [S1 decision map](../behavioral-eval/01-s1-decision-map.md), DP01–DP13;
- [S2 decision map](../behavioral-eval/02-s2-decision-map.md), DP14–DP20;
- [S3 decision map](../behavioral-eval/03-s3-decision-map.md), DP21–DP36;
- [S4 decision map](../behavioral-eval/04-s4-decision-map.md), DP37–DP49;
- [S1–S4 scenarios](../../docs/design/01-scenarios.md);
- [P6 Communication](../../docs/design/implementation/P6/02-communication-protocol.md);
- [P6 Formation](../../docs/design/implementation/P6/01-formation-semantics.md);
- [P7 Dependency / Deliverable](../../docs/design/implementation/P7/01-dependency-deliverable-commands.md);
- [P8 Verification](../../docs/design/implementation/P8/01-verification-commands.md);
- [P9 fault hardening](../../docs/design/implementation/P9/04-provider-tool-hardening.md);
- [current Tool Inventory](./01-tool-inventory.md);
- [Execution Tool Exposure Contract](./13-execution-tool-exposure-contract.md).

## Classification rule

The important boundary is:

```text
semantic agent action
  → canonical action/directive value
  → deterministic command or tool request
  → authority / freshness / resource checks
  → effect or durable transition
  → bounded observation
```

An executable tool is a narrow capability such as `read`, `list`, `patch`, or
`shell`. It is not a substitute for the Agent's decision about why the tool is
needed, whether to wait, whether to escalate, or whether an outcome is good
enough. An application command request carries a semantic request across a
domain boundary; Runtime adds identity, authority, revisions, idempotency, and
generated IDs. A Runtime-only transition is never made true by prompt wording.

This matches the useful part of the OpenCode/Codex tool boundary. OpenCode's
[tool API](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/tool.ts)
defines an id, description, parameter schema, and executable function; its
wrapper validates arguments before execution and returns a typed invalid
argument result to the model. Codex's
[CLI/tool documentation](https://developers.openai.com/codex/cli/) keeps the
tool catalog and tool modes separate from execution policy, sandbox, and
approval decisions. The implication for Arbor is a small-purpose model-facing
action vocabulary plus separately catalogued executable tools and mechanically
enforced Runtime policy.

## Model-facing action inventory

These actions require semantic judgment or authored content from the Agent.
Their model-facing representation should be single-purpose and shallow enough
for the selected model/provider profile. It must not expose Runtime-owned
identity, authority, revision, or generated IDs as free model choices.

| Action | Purpose | Model Decision | Model Inputs | Runtime Bindings | Effect | Observation | Source Scenario | Downstream Contract | Should Be Model-facing? |
|---|---|---|---|---|---|---|---|---|---|
| `ClarifyDirection` | Keep a still-ambiguous request in high-level discussion. | Whether a remaining ambiguity changes the direction enough to ask a question. | User goal, constraints, materials, unresolved questions, prior agreement. | Session, authenticated principal, conversation execution. | Emits a bounded clarification or continuation reply; creates no Work by itself. | Conversation response and next admitted input. | S1 DP01, DP13. | P14 human message / conversation; Base or Human Conversation action surface. | **Yes — MODEL_FACING_ACTION** |
| `CommitToStartWork` | Move from direction discussion to practical work organization. | Whether the shared understanding is sufficient to begin. | Goal, constraints, completion expectation, unresolved direction-level risks. | Workspace/Project/Session and current admission. | Produces an organization or work-start proposal; does not grant authority. | Accepted or rejected proposal and next context. | S1 DP01–DP02. | P3 Work/Responsibility context; P6 formation when a split is proposed. | **Yes — MODEL_FACING_ACTION** |
| `ProposeResponsibilitySplit` | Decide whether work should remain local or be divided. | Own vs serial vs parallel; first-layer vs recursive formation; rationale. | Outcome, responsibility, resource boundary, candidate sub-outcomes, dependencies, coordination cost. | Parent Workspace, project, authority ceiling, tree depth, proposal/revision IDs. | Creates a formation proposal, specialist request, or local continuation. | Formation proposal, specialist settlement, or rejection. | S1 DP02, DP04; S2 DP20. | P6 `ChildWorkspaceProposal`, `SpecialistSpec`, P1 Create/Assign path. | **Yes — MODEL_FACING_ACTION** |
| `SelectNextWorkAction` | Advance the current Work loop without waiting for “continue”. | Next useful action, evidence step, repair, decomposition, or claim readiness. | Objective, why, constraints, completion expectation, current frontier, observations, available tools. | Current Work/execution/revision, capability profile, authority, freshness fence. | Produces a semantic action, tool request, message, wait, or claim. | Tool/command observation, updated frontier, or typed denial. | S1 DP05, DP12; S3 DP21; S4 DP44. | P3 WorkExecution / P5 directive handling. | **Yes — MODEL_FACING_ACTION** |
| `TriageIncomingInput` | Preserve current work while handling newly arriving user/Parent input. | Absorb now, queue as independent work, or route to steer/stop handling. | Active objective/frontier, input content, source, urgency/steer kind, completed work. | Sender, target Workspace, Inbox identity, execution state, explicit command kind. | Updates the next plan or leaves input in the durable inbox. | Promotion/consumption observation and revised next action. | S1 DP06; S2 DP15–DP16. | P6 Inbox / Steer; P14 human message. | **Yes — MODEL_FACING_ACTION** |
| `ClassifySteerScope` | Distinguish local correction, high-level direction change, and responsibility transfer. | Which responsibility and descendants are semantically affected. | User message, selected Workspace, parent chain, current objective/constraints, ownership intent. | Target Workspace, authority chain, existing responsibility revisions. | Selects local update, parent discussion, or governed handoff proposal. | Scoped steer, escalation request, or transfer proposal. | S2 DP15, DP20. | P6 Human Steer; P11 ownership wiring; P14 conversation. | **Yes — MODEL_FACING_ACTION** |
| `AbsorbCorrection` | Continue from valid progress after a local steer. | Which assumptions/results remain valid and how the plan changes. | Correction, prior decisions/evidence, current frontier, material conflicts. | Session/history append, Work revision, steer kind, safe boundary. | Revised plan or next action; valid unaffected progress remains. | New frontier, retained/revised assumptions, or ruling request. | S2 DP16, DP19. | P6 Human Steer; P5 continuation. | **Yes — MODEL_FACING_ACTION** |
| `ResumeAutonomy` | Return to useful autonomous progress after intervention. | Proceed now or request one specific missing ruling/precondition. | Absorbed correction, remaining authority, frontier, blockers, pending decisions. | Wake/admission, execution lease, explicit wait conditions. | Work action or bounded request; no confirmation ritual. | Provider/tool turn or durable wait. | S2 DP19; S1 DP07, DP13. | P5/P7 wake and Work execution. | **Yes — MODEL_FACING_ACTION** |
| `ProposeResponsibilityHandoff` | Change long-lived ownership without silently rewriting the tree. | Update existing responsibility or create a formal successor/handoff. | Old/new responsibility, parent chain, open Work, artifacts, dependencies, user intent. | Workspace lineage, parent links, authority, generated IDs, revisions. | Handoff proposal or ordinary responsibility update. | Governance proposal, assignment/retirement result, or rejection. | S2 DP20; S3 DP28; S4 DP49. | P6 formation/delegation; P11 ownership wiring. | **Yes — MODEL_FACING_ACTION** |
| `InvokeExecutableTool` | Request one narrow filesystem/shell/project capability. | Tool identity and exact arguments needed for the selected step. | Current goal, resource boundary, tool definition/schema, prior observations. | Tool catalog version, execution/session/project/principal, authority, approval, invocation identity. | `read`, `list`, `patch`, `shell`, or a ready project tool runs through ToolRuntime. | Bounded tool observation, effect settlement, or typed denial/unknown outcome. | S1 DP05; S3 DP21, DP31–DP33; S4 DP40. | P4 ToolRuntime; current builtins in `01-tool-inventory.md`. | **Yes — EXECUTABLE_TOOL_CALL** |
| `ClaimCompletion` | State that the current Work appears ready for independent quality checking. | Whether the completion expectation is supported and what claim reference explains it. | Objective, completion expectation, result, evidence, known gaps. | Exact Work/execution/revision, settlement identity, verification binding. | Settles the turn as a completion claim and triggers verification; does not complete Work. | `ExecutionSettled(CompletionClaimed)` and verification start. | S1 DP05; S3 DP34. | P5 CompletionClaim; P8 StartVerification consumer. | **Yes — MODEL_FACING_ACTION** |
| `JudgeVerification` | Produce an evidence-backed quality verdict. | Criterion-level Pass, Fail, or Unknown and the supporting evidence. | Verification mission, target revision, result, direct observations, artifacts, environment. | Verification ID, verifier execution authority, evidence IDs/revisions. | Records evidence and concludes verification. | Criterion results and aggregate verdict. | S1 DP08; S3 DP35. | P8 `RecordVerificationEvidence` / `ConcludeVerification`. | **Yes — MODEL_FACING_ACTION** |
| `RepairOrGatherEvidence` | Respond to verification Fail or Unknown without hiding the problem. | Repair the producer result, gather missing evidence, or request a ruling. | Criterion verdicts, evidence gaps, producer frontier, tools, authority boundary. | Work/revision, verifier result identity, allowed recovery path. | New work action, evidence request, or bounded escalation. | Updated result/evidence or DecisionRequest. | S1 DP09; S3 DP34–DP35; S4 DP42. | P8 verification return; P5 Work execution; P6 communication. | **Yes — MODEL_FACING_ACTION** |
| `IntegrateVerifiedResult` | Decide whether a locally verified result is sufficient for the Parent's outcome. | Accept/integrate or identify specific additional work; do not reclassify child quality. | Parent objective, completion expectation, child result/evidence, dependencies, gaps. | Parent authority, exact Work/revision/verification binding, acceptance ID. | Requests or causes acceptance, supplementary Work, and parent integration. | Acceptance fact, added Work, or bounded explanation. | S1 DP10; S3 DP36. | P8 `AcceptWorkOutcome`; P5 Work lifecycle. | **Yes — MODEL_FACING_ACTION** |
| `SummarizeForParent` | Carry decision-critical result information upward without transcript flooding. | What conclusion, basis, impact, and unresolved issue the Parent needs. | Child result, evidence refs, Parent objective, blockers, prior decisions. | Sender/recipient relation, message identity, bounded body storage, correlation. | Emits a Report, Reply, DecisionRequest, or Deliver intent. | Parent Inbox admission and bounded message observation. | S1 DP11; S3 DP26, DP36. | P6 communication; P7 Deliver/Deliverable where applicable. | **Yes — MODEL_FACING_ACTION** |
| `AssessStageCompletion` | Decide whether the overall stage meets the high-level outcome. | Continue, add work, revisit a responsibility, or summarize to the user. | Stage goal, first-layer results/bases, open Work, dependencies, user constraints. | Workspace/Project stage context and current facts. | Starts another action or emits a user-facing stage summary. | New Work/communication or stage result. | S1 DP12. | P14 conversation; P5/P8 result surfaces. | **Yes — MODEL_FACING_ACTION** |
| `ChoosePostStageConversation` | Return control to the user without inventing next-stage authorization. | Wait, discuss next stage, accept a changed direction, or pause. | Achieved result, remaining gaps, prior direction, explicit current message. | Conversation/session identity and admission. | Bounded summary/question; no unauthorized canonical mutation. | User-visible response. | S1 DP13. | P14 conversation. | **Yes — MODEL_FACING_ACTION** |
| `ChooseLocalResolution` | Prefer solving a local problem within the current responsibility. | Continue locally, subdivide locally, communicate, or ask Parent. | Responsibility, boundary, objective, attempts, tools, blocker. | Workspace/execution binding, authority ceiling, available capabilities. | Local tool/action, recursive formation, or communication action. | Tool result, child settlement, or request. | S3 DP21. | P3 ResponsibilityBound; P4/P6/P7. | **Yes — MODEL_FACING_ACTION** |
| `ChooseCommunicationIntent` | Select the cognitive communication meaning instead of treating all messages alike. | Query, Reply, Report, DecisionRequest, or a P7 Deliver intent. | Missing fact/result/ruling, recipient relation, correlation, deliverable need, parent chain. | Sender, project, parent route, correlation/causation allocation, authority. | Sends a typed message or handover request. | MessageSent, Inbox admission, wake, or correlation update. | S3 DP22, DP25–DP29; S1 DP11; S4 DP42. | P6 Message kinds; P7 Deliver; no universal message envelope. | **Yes — MODEL_FACING_ACTION** |
| `DeclareDependency` | Represent an unmet result requirement for the current Work. | Producer binding and expected deliverable kind/artifact roles. | Missing result, producer candidates, expected deliverable, consumer context. | Consumer Work/current revision when uniquely bound, dependency ID/revision, authority, project. | Emits `DependencyDeclared`; does not implicitly yield or satisfy. | Dependency record and coordinator re-check/wake signal. | S3 DP22–DP24. | P7 `DeclareDependency`. | **Yes — COMMAND_REQUEST** |
| `ProduceDeliverable` | Publish a formal result fact that can satisfy a dependency. | Deliverable kind and artifact roles associated with a source Work result. | Verified/available artifacts, source Work, result semantics, artifact roles. | Deliverable/source Work IDs, source revision, authority, command/idempotency IDs. | Emits immutable `DeliverableProduced`. | Deliverable fact and coordinator re-check. | S1 DP10–DP11; S3 DP11–DP14 and dependency flow. | P7 `ProduceDeliverable`; distinct from Report and Deliver. | **Yes — COMMAND_REQUEST** |
| `ContinueIndependentWork` | Avoid stopping an entire responsibility because one dependency is pending. | Which work is independent and safe to advance. | Work graph/frontier, pending dependency, completion requirements, known alternatives. | Canonical dependency state, wait registration, current Work bindings. | Selects another work action or yields only when nothing eligible remains. | New action or durable wait condition. | S3 DP24. | P7 runnability and wait graph; P5 Work execution. | **Yes — MODEL_FACING_ACTION** |
| `WaitOnCanonicalCondition` | Declare a real wait condition instead of polling or vague delay. | Reason and condition(s) required to re-enter. | Pending dependency/decision/event/time condition and observed values. | Execution/Work binding, canonical wait mode, durable registration, wake ownership. | Settles current slice and registers `WorkWait`; no model calls until wake. | Durable wait and later wake/re-evaluation. | S3 DP24; S4 DP37. | P5 `Yield`; P7 wait/wake. | **Yes — MIXED** |
| `RequestParentRuling` | Ask the nearest capable Parent for a specific decision/resource. | Whether local attempts are exhausted and exactly what ruling is needed. | Task, blocker, attempts, uncertainty, responsibility boundary, needed resource. | Parent route, sender, correlation, authority, message IDs. | Sends a bounded `DecisionRequest`; escalation preserves ownership. | Parent Inbox admission, response, or upward escalation. | S3 DP25–DP29; S4 DP42. | P6 `DecisionRequest`; P7 escalation boundary. | **Yes — COMMAND_REQUEST** |
| `RecoverAfterDenial` | Preserve the goal after a permission/capability denial. | Allowed alternative, concrete approval request, Parent escalation, or blocked branch. | Denial reason, authority/resource boundary, goal, alternatives, approval requirement. | Denial fact, capability profile, authority and approval state. | New permitted tool/action, request, or explicit blocked outcome. | Typed denial handling and next observation. | S3 DP30–DP31. | P4/P12 authority resolver and ToolRuntime; P6 governance if needed. | **Yes — MODEL_FACING_ACTION** |
| `RecoverAfterExecutionFault` | Choose a safe response to a transient or terminal execution fault. | Retry, change method, escalate, or reconcile before replay. | Failure class, attempts, effect identity, idempotency, alternatives, remaining authority. | Retry bounds, ProviderTurn/Invocation identity, reconciliation gate, safety policy. | Bounded retry/new method/request; no fabricated success. | Retry outcome, typed failure, or `OutcomeUnknown`. | S3 DP32; S4 DP40–DP42. | P3 repair/retry; P4/P9 recovery hardening. | **Yes — MODEL_FACING_ACTION** |
| `ReconcileUnknownExternalEffect` | Establish real-world state after an uncertain side effect. | Which read/reconciliation evidence can settle complete/not-complete/unknown. | Last action/parameters, effect ID, transport result, current external observations. | Effect identity, idempotency class, no-replay fence, reconciliation source. | Read/reconcile request or bounded escalation; no blind duplicate action. | Confirmed state, `OutcomeUnknown`, or missing-evidence request. | S3 DP33; S4 DP40, DP42. | P4/P9 outcome-unknown and recovery contracts. | **Yes — MODEL_FACING_ACTION** |
| `RestoreContinuationContext` | Recover the minimum sufficient work spine on re-entry. | Which prior responsibility, decisions, results, failed paths, and frontier are needed now. | Responsibility/revision, open/completed Work, checkpoint, verified outcomes, re-entry event, relevant history. | Durable Session/Work/Checkpoint retrieval, retention class, token budget, manifest. | Produces a grounded resumed plan or a request for a missing artifact. | Continuation context and next action. | S4 DP38, DP46–DP47. | P3 `planContext`, P5 continuity, P9 recovery. | **Yes — MODEL_FACING_ACTION** |
| `AssessStalenessAndDrift` | Connect changed facts to the current outcome. | Reuse, recheck, ignore, or mark Unknown for changed historical/environment facts. | Old/current revisions, changed requirements/dependencies, environment drift, active objective. | Revision invalidation, ControlBasis freshness, environment revision facts. | Targeted re-check or plan adjustment. | Change assessment with source/provenance. | S4 DP39, DP45, DP48. | P11 drift/staleness/impact; P3 context. | **Yes — MODEL_FACING_ACTION** |
| `ChooseReentryPath` | Return from recovery to normal work without reopening unrelated work. | Re-enter S1 progress, S3 collaboration/recovery, or remain blocked. | Restored frontier, dependencies, external state, changed requirements, tools. | Re-admitted Work/Execution and wait conditions. | Concrete work, communication, or bounded wait/ruling request. | Normal provider/tool turn or wait. | S4 DP44. | P5/P7/P9 recovery loop. | **Yes — MODEL_FACING_ACTION** |
| `DistinguishContinuationOrNewResponsibility` | Preserve long-lived ownership while recognizing a genuinely new outcome boundary. | Continue current responsibility or propose a new governed responsibility. | Stable responsibility, history, new request/bug, owner, changed outcome boundary. | Durable Workspace lineage, formation authority, generated identities. | Continue existing Work or create a governed proposal. | Continuation action or proposal. | S4 DP49. | P6 formation; P11 ownership wiring. | **Yes — MODEL_FACING_ACTION** |

## Mixed and Runtime-only action inventory

These actions are deliberately visible in the inventory because they are often
mistaken for model actions. The model may supply an input to a mixed boundary,
but the invariant or state transition must remain mechanical.

| Action | Purpose | Model Decision | Model Inputs | Runtime Bindings | Effect | Observation | Source Scenario | Downstream Contract | Should Be Model-facing? |
|---|---|---|---|---|---|---|---|---|---|
| `ClassifyCriticalStop` | Decide whether ordinary language implies an immediate high-risk stop when no explicit Critical Steer command exists. | Risk/urgency classification only; never grant the stop effect. | Exact user text, active action, side-effect boundary, stated stop intent. | Authenticated Critical Steer command, quiescence gate, stop authority. | If explicitly admitted, Runtime blocks new provider/tool/state-changing work. | Stop/quiescence event and reconciliation status. | S2 DP17–DP18. | P6 Human Steer; P12 Runtime Safety; P9 reconciliation. | **Yes — MIXED** |
| `ReconcileAfterCriticalStop` | Decide what to do with effects already in flight after a stop. | Identify completed, cancelled, or still-unknown effects and choose safe reconciliation. | Cancellation result, effect identity, idempotency, external observations. | No-new-action fence, cancellation policy, OutcomeUnknown handling. | Preserves completed effects; blocks unsafe replay; requests reconciliation. | Quiescent or reconciliation-required state. | S2 DP18; S4 DP40–DP41. | P9/P12 safety and outcome-unknown. | **Yes — MIXED** |
| `IntegrateIncomingResult` | Decide how an arriving child/Parent result changes the current responsibility. | Wake/reason now, queue for a safe boundary, or integrate upward. | Result/evidence summary, active work, wait condition, affected objective/dependency. | Inbox admission, deduplication, wake eligibility, parent relation. | Model produces integration/report; Runtime routes and wakes. | Inbox/wake transition plus bounded next action. | S3 DP36; S1 DP11. | P6 Inbox; P7 wake; P5 Work. | **Yes — MIXED** |
| `RecordHumanFormationDecision` | Apply the human gate to a first-layer formation proposal. | None; the decision is a human choice, not an Agent choice. | Exact proposal and requested human outcome. | Proposal ID/revision, authenticated principal, exact binding, governance state. | Approves, modifies, or rejects a proposal; only approval enables the consumer. | `DecisionRecorded`, proposal state, and Observation. | S1 DP03; S2 DP20. | P6 `RecordDecision`; P1 CreateChildWorkspace consumer. | **No — RUNTIME / HUMAN CONTROL** |
| `StartVerification` | Start the verifier after a valid completion claim. | None at dispatch; claim readiness is `ClaimCompletion`. | Completion claim and current Work state. | Work/revision, mission snapshot, one-open-verification invariant, authority. | Creates a Verification and verifier execution. | `VerificationStarted` and verifier admission. | S1 DP07; S3 DP34. | P8 `StartVerification`. | **No — RUNTIME_ONLY** |
| `AcceptWorkOutcome` | Record Parent acceptance after a Pass verification. | Parent semantic sufficiency is `IntegrateVerifiedResult`; this row is the command transition. | Accepted Work/result chosen by the Parent action. | Exact Work/revision/verification triple, Parent authority, acceptance ID. | Emits `WorkOutcomeAccepted`; does not itself complete Work. | Acceptance fact/receipt. | S1 DP10; S3 DP36. | P8 `AcceptWorkOutcome`. | **No — COMMAND GATE / RUNTIME** |
| `CompleteWork` | Complete a Work only after current-revision Pass and Acceptance. | None; no model may bypass the quality chain. | Canonical acceptance and verification facts. | Work revision, Pass verdict, matching acceptance, command authority. | Emits `WorkCompleted` and clears current Work when applicable. | Completion event/settlement. | S1 DP07, DP10–DP12. | P8 `CompleteWork`; P5 Work lifecycle. | **No — RUNTIME_ONLY** |
| `RouteResultAndWake` | Route specialist/result arrivals and wake only eligible waiting work. | None for routing/wake; model may later interpret the result. | Durable result/settlement and current wait state. | Inbox key, parent relation, wait condition, dedup fingerprint, wake signal. | Inbox admission and idempotent wake/re-evaluation. | Inbox projection and wake observation. | S3 DP23, DP36; S4 DP37. | P6 specialist settlement; P7 wake. | **No — RUNTIME_ONLY** |
| `EvaluateDependencySatisfaction` | Determine whether a Deliverable structurally satisfies a Dependency. | None; the matcher is canonical and structural. | Dependency contract and Deliverable view. | Dependency/deliverable IDs, project boundary, current revisions, matcher. | Emits `DependencySatisfied` or a typed rejection. | State transition and wake signal. | S3 DP23–DP24. | P7 structural matcher / `SatisfyDependency`. | **No — RUNTIME_ONLY** |
| `PersistIdleAndWait` | Preserve long-lived responsibility without polling when no eligible work exists. | None for durability or event matching. | Canonical state and wait condition. | Workspace/Session/Work durability, scheduler, timer/event wake. | Settles/parks execution and keeps responsibility/history. | Durable idle state and zero model calls until wake. | S4 DP37. | P5/P7/P9 continuity and wait. | **No — RUNTIME_ONLY** |
| `EnforceNoBlindReplay` | Prevent duplicate external side effects when outcome is uncertain. | None; the model may request reconciliation but cannot override the fence. | Effect identity, invocation record, idempotency class, reconciliation result. | Recovery source, idempotency/replay policy, safety gate. | Blocks replay or permits only an explicitly safe route. | Blocked replay, reconciliation result, or safe retry receipt. | S3 DP33; S4 DP40–DP43. | P4/P9/P12 runtime safety. | **No — RUNTIME_ONLY** |
| `AuthorizeAndAdmit` | Check whether a requested operation is permitted and within capability. | None; the model may choose a different action after denial. | Exact command/tool and arguments supplied by the model action. | Principal, capability, resource boundary, approval, project, Work/Execution binding. | Authorizes or rejects before effect. | Authorized invocation or typed `AuthorityDenied`/precondition. | S3 DP30; all effectful actions. | P4 ToolRuntime; P6/P12 authority resolver. | **No — RUNTIME_ONLY** |

## Coverage and relation to `AgentDirective v1`

This inventory covers every S1–S4 decision point. Several decision points are
intentionally represented by more than one row because the scenario separates
model judgment from a later mechanical transition. For example:

- DP05 / DP34 become `SelectNextWorkAction` and `ClaimCompletion`; the latter
  is not the same decision as P8 verification dispatch.
- DP08 / DP35 become `JudgeVerification`; `StartVerification` and
  `CompleteWork` remain Runtime transitions.
- DP22 and DP25–DP29 become `ChooseCommunicationIntent`,
  `RequestParentRuling`, and `SummarizeForParent`; one generic “Communicate”
  action hides these distinct meanings.
- DP23 becomes `EvaluateDependencySatisfaction`, which is a canonical matcher,
  not a prompt decision. `DeclareDependency` and `ProduceDeliverable` are
  separate model-facing command requests.
- DP37, DP41, and DP43 remain Runtime-only invariants. Prompt text must not be
  used to create durable continuity, wake conditions, localized recovery, or
  no-blind-replay safety.

The current ten branches therefore do not form a complete action vocabulary:

| Current `agent-directive-v1` branch | Inventory interpretation |
|---|---|
| `InvokeTool` | A valid narrow executable/tool request; keep separate from semantic planning. |
| `Communicate` | Too broad: it currently covers Query, Reply, Report, DecisionRequest, authored content, and the unresolved durable-body transformation. It should not be treated as one atomic model action. |
| `DeclareDependency` | Real model-facing command request, but current `{}` payload loses producer binding and expected deliverable semantics. |
| `RequestGovernance` | Mixed family: FormationApproval and DecisionRequest are different actions with different downstream contracts. |
| `SpawnSpecialist` | Real formation action with typed mission/constraints/skills; distinct from long-lived child Workspace formation. |
| `ProposeChildWorkspace` | Real long-lived responsibility proposal; distinct from specialist spawning and from the human decision that approves it. |
| `LoadSkill` | Capability/context request, not a general work action; Runtime/SkillRegistry owns availability and provenance. |
| `ChangeMode` | Execution profile/control action; must not bypass authority or safety. |
| `CompletionClaim` | Valid model-facing claim action, bounded to current Work/revision. |
| `Yield` | Valid wait request, but its condition selection is semantic while registration/wake is Runtime-owned. |

The following actions are absent or not atomically represented by v1:

- `ClarifyDirection`, `SelectNextWorkAction`, `AbsorbCorrection`,
  `ResumeAutonomy`, and `ChoosePostStageConversation`;
- `JudgeVerification`, `RepairOrGatherEvidence`, and
  `IntegrateVerifiedResult`;
- `ChooseCommunicationIntent`, `RequestParentRuling`, and
  `SummarizeForParent` as distinct message meanings;
- `ProduceDeliverable`, `ContinueIndependentWork`, and
  `ReconcileUnknownExternalEffect`;
- `RestoreContinuationContext`, `AssessStalenessAndDrift`,
  `ChooseReentryPath`, and `DistinguishContinuationOrNewResponsibility`;
- the Runtime-only boundaries `StartVerification`, `AcceptWorkOutcome`,
  `CompleteWork`, `EvaluateDependencySatisfaction`, `RouteResultAndWake`,
  `PersistIdleAndWait`, and `EnforceNoBlindReplay`.

This does not authorize an `agent-directive-v2` implementation. It establishes
that a future canonical action vocabulary should be derived from semantic
actions first, then compiled into provider/model-facing representations. The
canonical action vocabulary and the executable ToolRuntime catalog should be
separate contracts:

```text
semantic action vocabulary
  ≠
executable tool catalog
  ≠
Runtime command / safety transition
```

## Governance conclusions

1. **Model-facing actions should be atomic and purpose-specific.** A tool or
   directive should answer one question and expose only the fields the model
   must supply. `Communicate` and `RequestGovernance` currently cross this
   boundary.
2. **Executable tools remain capabilities, not organizational decisions.**
   `read`, `list`, `patch`, `shell`, and ready project tools should be exposed
   only when the purpose, boundary, and executor readiness permit them.
3. **Canonical action identity may be supplied by a concrete representation,
   but it cannot supply missing business semantics.** A model-facing tool name
   may identify `JudgeVerification` or `DeclareDependency`; it may not invent a
   missing target, revision, recipient, or deliverable.
4. **Runtime invariants stay mechanical.** Authorization, human gates,
   verification dispatch, dependency matching, wake, durability, localized
   recovery, and no-blind-replay cannot be delegated to Prompt or model
   compliance.
5. **The next contract question is canonical action closure, not tool schema
   tuning.** Before a representation compiler is implemented, each
   model-facing action needs a lossless canonical payload and a deterministic
   command/observation mapping. This is especially important for the existing
   five drifted v1 branches and for the additional P7 Deliverable/Deliver
   vocabulary.

## Final counts

The inventory contains **43 action rows**:

- **26** direct `MODEL_FACING_ACTION` rows;
- **3** `COMMAND_REQUEST` rows (`DeclareDependency`, `ProduceDeliverable`,
  and `RequestParentRuling`);
- **1** `EXECUTABLE_TOOL_CALL` row (`InvokeExecutableTool`);
- **4** `MIXED` rows;
- **9** Runtime-only or human-control rows.

The categories overlap by design where an action is both a semantic choice and
a command/tool boundary. The stable conclusion is not the raw row count; it is
the ownership split: S1–S4 require substantially more semantic actions than the
ten current decoder tags, while several current tags combine multiple meanings
that should not share one model-facing surface.
