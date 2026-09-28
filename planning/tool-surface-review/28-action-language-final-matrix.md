# Final Action Language Matrix

**Date:** 2026-09-27
**Status:** Governance result; no schema or implementation

The table records the final semantic boundary. “Canonical Agent Action?” means
the action belongs to the semantic language; it does not mean that every
execution exposes it or that its downstream command is itself model-facing.

| Action | Canonical Agent Action? | Model decision | Runtime bindings | Effect | Authority | Downstream command/event | Durable? | Current release status |
|---|---|---|---|---|---|---|---|---|
| `RespondToHuman` | Yes | Authored bounded answer, clarification, summary, or next-stage handback | Root conversation, accepted HumanMessage, execution/session, response correlation | User-visible Assistant turn | P14 Coordination execution | `SettleExecution(QueryCompleted)` → Answered response / `AssistantConversationTurn` | Yes | `ACTIVE` |
| `InvokeTool` | Yes | Tool identity and exact arguments | Tool version, principal, project, resources, authority, control basis, invocation identity | Read observation or external effect | P4/P12 ToolRuntime | `ToolRuntimePort.invoke` → canonical observation/settlement | Invocation durable; effect-dependent | `ACTIVE` |
| `AssignWork` | Yes | Objective, why, constraints, completion expectation, mission where required | Target Workspace, Work ID, revision, provenance, authority, idempotency | Open Work assignment | Workspace governance authority | P1 `AssignWork` → Work assignment event/receipt | Yes | `ACTIVE` |
| `Wait` | Yes | Non-empty reason and canonical condition set | Current Work/Execution, observed revisions, wake ownership, registration identity | Yield current slice and register WorkWait | Current Work authority | `Yield` / `WorkWait` → wake/re-evaluation | Yes | `ACTIVE` |
| `ClaimCompletion` | Yes | Whether current result supports completion expectation and claim meaning | Current Work/revision, execution settlement, verification binding | Completion claim; verification consumer starts | Producer Work execution | `CompletionClaimed` → `StartVerification` | Yes | `ACTIVE` |
| `AcceptWorkOutcome` | Yes | Whether a Pass result is sufficient for Parent outcome | Work/revision/verification triple, Parent authority, acceptance identity | Immutable acceptance fact | Parent Agent or authorized Human governance chain | P8 `AcceptWorkOutcome` → `WorkOutcomeAccepted` | Yes | `ACTIVE` |
| `RecordVerificationEvidence` | Yes | Which observation/artifact supports which criterion and how it is described | Verification/execution authority, evidence identity, target revision, provenance | Append evidence record | Exact verifier execution | P8 `RecordVerificationEvidence` | Yes, append-only | `ACTIVE` |
| `ConcludeVerification` | Yes | Criterion verdicts and aggregate Pass/Fail/Unknown judgment | Verification/revision identity, evidence refs, verifier authority | Immutable verification conclusion and wake | Exact verifier execution | P8 `ConcludeVerification` → `VerificationConcluded` | Yes | `ACTIVE` |
| `SendMessage` | Yes | Kind, authored content, semantic target where not structurally fixed, reply intent | Sender/project/principal, parent route, body persistence, correlation/causation, message ID | Durable cognitive message and Inbox admission | P6 communication authority | `SendMessage` → `MessageSent` → Inbox/promotion/wake | Yes | `ACTIVE` |
| `DeclareDependency` | Yes | Producer binding and expected deliverable contract | Consumer Work/revision when bound, dependency identity, project, authority | Durable unmet result contract | Consumer Workspace authority | `DeclareDependency` → `DependencyDeclared` | Yes | `ACTIVE` |
| `ProduceDeliverable` | Yes | Formal result kind and artifact-role selection | Source Work/revision, deliverable ID, project, authority, provenance | Immutable formal result fact | Source Workspace authority | `ProduceDeliverable` → `DeliverableProduced` | Yes | `ACTIVE` |
| `RequestDependencyMatch` | Yes | Exact Dependency/Deliverable pair to ask Runtime to evaluate | Consumer Execution, target pair, dependency revision, project, authority | Matcher request; no direct satisfaction claim | Exact `ConsumerExecution` authority | P7 `SatisfyDependency` command → matcher result | Request and result durable | `ACTIVE` |
| `Deliver` | Yes | Existing Deliverable and bounded handover meaning | Source ownership, direct Parent target, message/correlation IDs | Formal child-to-parent handover and wake | Source Workspace/direct-parent rule | `SendMessage(kind=Deliver)` → `ChildDelivered` | Yes | `ACTIVE` |
| `ProposeChildWorkspace` | Yes | Name, responsibility/resource drafts, rationale, optional initial Work | Parent/project/principal, proposal/revision/IDs, structural depth, capability checks | Formation proposal or durable child Workspace | Parent formation authority / human gate | FormationProposal or `CreateChildWorkspace` → optional `AssignWork` | Yes | `ACTIVE` |
| `SpawnSpecialist` | Yes | Mission, constraints, requested skill IDs | Current Workspace/execution, parent execution, generated specialist IDs, quiescence | Temporary ExecutionBound admission | Current Workspace execution authority | `AdmitExecution(ExecutionBound)` → specialist settlement | Yes | `ACTIVE` |

## Actions explicitly outside the language

| Item | Category | Reason |
|---|---|---|
| `StartVerification` | `RUNTIME_AUTOMATION` | Deterministic consumer after `ClaimCompletion`. |
| `CompleteWork` | `RUNTIME_AUTOMATION` | Requires Pass + exact Acceptance; no model judgment. |
| Coordinator `SatisfyDependency` | `RUNTIME_AUTOMATION` | Event-driven candidate lookup and matcher submission. |
| `RouteResultAndWake` / `PersistIdleAndWait` | `RUNTIME_AUTOMATION` | Inbox, wait, scheduler, and wake invariants. |
| `EnforceNoBlindReplay` / `AuthorizeAndAdmit` | `RUNTIME_AUTOMATION` | Hard safety and authority gates. |
| `RecordDecision` | `HUMAN_CONTROL` | Authenticated human formation/governance choice. |
| `SteerWork`, `CriticalSteer`, `StopExecution` | `HUMAN_CONTROL` | Human governance and quiescence controls. |
| `ResponsibilityHandoff` | `DEFERRED` | No frozen successor/retire/authority-transfer protocol. |

## Completeness and orthogonality

Rechecking all 49 Decision Points yields:

- every ACTIVE model decision with an observable effect maps to one explicit
  action;
- pure reasoning remains attached to the action it selects;
- no `UNEXPRESSIBLE_REQUIRED_INTENT` remains in the **ACTIVE release scope**;
- `ResponsibilityHandoff` is the only scenario intent explicitly deferred;
- no unresolved `OVERLAPPING_ACTION` remains;
- previous ambiguities are closed:
  - `SendMessage` versus `Deliver`;
  - `ClaimCompletion` versus `ProduceDeliverable`;
  - `ConcludeVerification` versus `AcceptWorkOutcome`;
  - `RequestDependencyMatch` versus coordinator automation;
  - `Wait` versus runtime idle parking.

The deferred capability still appears in S2 DP20 and S4 DP49, but it is not
silently represented by `ProposeChildWorkspace`, `SendMessage`, or
`AssignWork`.
