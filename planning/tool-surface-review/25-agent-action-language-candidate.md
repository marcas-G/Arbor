# Candidate Agent Action Language

**Date:** 2026-09-27
**Status:** Candidate semantic vocabulary only; no schema, representation, or implementation authorization

This document is the post-consolidation candidate. It is intentionally smaller
than the 43 scenario rows and is not a proposal to make every action a
model-facing tool. A later model-family compiler may expose a different number
of concrete tools while preserving these semantic boundaries.

## Candidate families

The candidate uses seven active organizational families plus one explicit
non-Agent boundary family:

1. **Conversation** — user-visible response effect;
2. **Environment** — executable capability invocation;
3. **Work Lifecycle** — wait, completion claim, and Parent acceptance;
4. **Coordination** — messages, dependencies, and deliverable facts;
5. **Delivery** — formal handover of an existing Deliverable;
6. **Delegation** — temporary specialist versus durable child responsibility;
7. **Verification** — evidence and verdict lifecycle;
8. **Human/Governance Boundary** — reserved for human controls and Runtime
   gates; it has no model-facing Agent action in this candidate.

The first seven families contain **15 candidate explicit Agent actions**. The
eighth is retained to make the non-Agent boundary visible.

## Action cards

### A-CONV-01 — `RespondToHuman`

- **Family:** Conversation
- **Purpose:** Clarify direction, summarize a stage, answer, or hand the next
  decision back to the user.
- **Trigger condition:** A Coordination execution has a user-visible response
  episode to produce.
- **Model-decided semantics:** Response content, whether clarification is
  needed, and whether to propose a next stage without inventing authorization.
- **Runtime-bound semantics:** Root Workspace/session, accepted HumanMessage,
  one-active-main execution, bounded response persistence, exact-once
  writeback.
- **Target:** Authenticated human conversation.
- **Effect:** User-visible assistant turn and transcript response episode.
- **Authority boundary:** P14 Coordination execution; no Work mutation or
  implicit steer semantics.
- **Durable state change:** P14 answered response/writeback and transcript
  projection.
- **Observation/result:** Bounded assistant response associated with the
  human message and execution.
- **Downstream command/event:** `SubmitHumanMessage` input,
  `SettleExecution(Completed(...))`, P14 response writeback/projection.
- **Source scenarios / decision points:** S1 DP01, DP12–DP13; S2 DP15–DP16.
- **Why explicit rather than reasoning-only:** Another Human must receive it,
  it is durably correlated/audited, and P14 guarantees one response episode.

### A-ENV-01 — `InvokeTool`

- **Family:** Environment
- **Purpose:** Perform one admitted capability operation.
- **Trigger condition:** The selected next step requires an available
  read/list/patch/shell or ready project tool.
- **Model-decided semantics:** Tool identity and exact arguments.
- **Runtime-bound semantics:** Tool version, execution/session/project/principal,
  resource regions, capability ceiling, approval, control basis, invocation
  identity.
- **Target:** One ToolRuntime definition and its resolved resources.
- **Effect:** Read observation or external/file side effect.
- **Authority boundary:** P4 ToolRuntime and P12 authority/resource checks.
- **Durable state change:** Invocation, attempt, and settlement records;
  side-effect state only if the tool performs one.
- **Observation/result:** Bounded tool result, denial, failure, or
  `OutcomeUnknown`.
- **Downstream command/event:** `ToolRuntimePort.invoke` and canonical tool
  observation/settlement.
- **Source scenarios / decision points:** S1 DP05; S3 DP21, DP30–DP33; S4 DP40.
- **Why explicit rather than reasoning-only:** It crosses capability/authority,
  can change the external world, and must be reconciled and replay-audited.

### A-WORK-01 — `Wait`

- **Family:** Work Lifecycle
- **Purpose:** Stop the current slice until a real canonical condition changes.
- **Trigger condition:** No eligible independent Work remains, or a dependency,
  decision, event, or time condition is genuinely required.
- **Model-decided semantics:** Reason and non-empty wait condition(s).
- **Runtime-bound semantics:** Current Work/Execution, observed revisions or
  sequence values, wait mode, durable registration, wake ownership.
- **Target:** Canonical dependency, decision, event, or time condition.
- **Effect:** Current execution settles/yields and a durable WorkWait is
  registered.
- **Authority boundary:** Current execution may register only conditions within
  its Work and responsibility binding.
- **Durable state change:** Execution settlement and WorkWait record.
- **Observation/result:** Wait registration, immediate re-evaluation, or wake.
- **Downstream command/event:** `Yield` / `WorkWait` and P7 wake integration.
- **Source scenarios / decision points:** S3 DP24; S4 DP37.
- **Why explicit rather than reasoning-only:** It changes durable scheduler state
  and is required to guarantee zero polling while idle.

### A-WORK-04 — `AssignWork`

- **Family:** Work Lifecycle
- **Purpose:** Create a bounded Work record when an agreed goal becomes an
  assigned responsibility.
- **Trigger condition:** A Workspace is ready to begin a new objective, or a
  Parent has identified supplementary Work needed by its own outcome.
- **Model-decided semantics:** Objective, why, constraints, completion
  expectation, and verification mission where the owning contract requires it.
- **Runtime-bound semantics:** Work ID, target Workspace/project, observed
  Workspace revision, provenance, authority, command/idempotency identity.
- **Target:** One active Workspace.
- **Effect:** Adds an Open Work and makes it eligible for scheduling.
- **Authority boundary:** Workspace governance authority; Runtime validates
  lifecycle, revision, and authorization.
- **Durable state change:** Work record and Work-assignment event/receipt.
- **Observation/result:** Assigned Work or typed rejection.
- **Downstream command/event:** P1 `AssignWork`.
- **Source scenarios / decision points:** S1 DP01–DP04, DP10–DP12; S3 result
  insufficient / supplementary Work path.
- **Why explicit rather than reasoning-only:** It changes durable Work
  lifecycle and is the missing effect boundary between “ready to start” and
  actual scheduled work.

### A-WORK-02 — `ClaimCompletion`

- **Family:** Work Lifecycle
- **Purpose:** State that a Work result is ready for independent verification.
- **Trigger condition:** The completion expectation appears supported by the
  current result and evidence.
- **Model-decided semantics:** Claim reference and semantic readiness judgment.
- **Runtime-bound semantics:** Current Work/revision, execution settlement,
  verification mission binding, idempotency and freshness.
- **Target:** Current Work revision.
- **Effect:** Settles the execution as a completion claim and starts the P8
  verification consumer.
- **Authority boundary:** Work-bound producer execution; it cannot complete the
  Work or bypass verification.
- **Durable state change:** Completion claim settlement/event and verification
  start consumer record.
- **Observation/result:** `CompletionClaimed` and `VerificationStarted`.
- **Downstream command/event:** `SettleExecution(CompletionClaimed)` →
  `StartVerification`.
- **Source scenarios / decision points:** S1 DP05, DP07; S3 DP34.
- **Why explicit rather than reasoning-only:** It changes Work/Verification
  lifecycle and is the auditable handoff between producer and verifier.

### A-WORK-03 — `AcceptWorkOutcome`

- **Family:** Work Lifecycle
- **Purpose:** Parent accepts a verified child result as sufficient for the
  Parent's own outcome.
- **Trigger condition:** Current-revision verification is Pass and Parent
  sufficiency reasoning says no supplementary Work is required.
- **Model-decided semantics:** Sufficiency of the child result for the Parent.
- **Runtime-bound semantics:** Work/revision/verification triple, Parent
  authority chain, acceptance ID, idempotency.
- **Target:** One Work revision and its matching Verification.
- **Effect:** Records an immutable WorkOutcomeAccepted fact; it does not itself
  complete Work.
- **Authority boundary:** Parent Workspace governance chain; Root milestone
  may require explicit human authority.
- **Durable state change:** Acceptance record/event.
- **Observation/result:** Acceptance receipt or typed rejection.
- **Downstream command/event:** P8 `AcceptWorkOutcome` →
  deterministic `CompleteWork` consumer.
- **Source scenarios / decision points:** S1 DP10; S3 DP36.
- **Why explicit rather than reasoning-only:** It changes lifecycle state,
  carries exact revision authority, and is independently auditable.

### A-VER-01 — `RecordVerificationEvidence`

- **Family:** Verification
- **Purpose:** Append an evidence record for a verification criterion.
- **Trigger condition:** Verifier has a bounded observation/artifact relevant to
  an open Verification.
- **Model-decided semantics:** Evidence description, criterion relation, and
  source/reference selection.
- **Runtime-bound semantics:** Verification ID, verifier execution authority,
  evidence ID, target revision, artifact/environment provenance.
- **Target:** Open Verification and one or more criteria.
- **Effect:** Append-only evidence becomes available to verdict aggregation.
- **Authority boundary:** Exact verifier execution for that Verification.
- **Durable state change:** Evidence record.
- **Observation/result:** Accepted evidence reference or typed rejection.
- **Downstream command/event:** P8 `RecordVerificationEvidence`.
- **Source scenarios / decision points:** S1 DP08; S3 DP35.
- **Why explicit rather than reasoning-only:** Evidence is durable, auditable,
  and separately bound from the terminal verdict.

### A-VER-02 — `ConcludeVerification`

- **Family:** Verification
- **Purpose:** Conclude an open Verification as Pass, Fail, or Unknown.
- **Trigger condition:** Required criteria have sufficient evidence or the
  verifier has established that reliable judgment is impossible.
- **Model-decided semantics:** Criterion verdicts, aggregate conclusion basis,
  and Unknown reason where applicable.
- **Runtime-bound semantics:** Verification/Work/revision identity, evidence
  bindings, allowed verdict aggregation, verifier authority.
- **Target:** One open Verification.
- **Effect:** Immutable verification conclusion; Fail/Unknown returns the Work
  to repair/evidence flow.
- **Authority boundary:** Exact verifier execution, with only the frozen
  orphaned governance path as an exception.
- **Durable state change:** `VerificationConcluded` record/event and wake.
- **Observation/result:** Pass, Fail, or Unknown conclusion and criterion results.
- **Downstream command/event:** P8 `ConcludeVerification`.
- **Source scenarios / decision points:** S1 DP08–DP09; S3 DP35.
- **Why explicit rather than reasoning-only:** It closes a lifecycle, drives
  deterministic consumers, and must be independently replay/audit safe.

### A-COORD-01 — `SendMessage`

- **Family:** Coordination
- **Purpose:** Send one typed cognitive work-plane message.
- **Trigger condition:** Another Workspace needs an observation, reply, report,
  or ruling request.
- **Model-decided semantics:** Message `kind` (`Query`, `Reply`, `Report`, or
  `DecisionRequest`), authored content, Query target, and any non-unique reply
  target required by the closed contract.
- **Runtime-bound semantics:** Sender/project/principal/execution, parent route
  for Report/DecisionRequest, body persistence/bodyRef, correlation/causation
  allocation and validation, urgency `Normal`.
- **Target:** Kind-specific authorized Workspace/correlation.
- **Effect:** Durable `MessageSent`, Inbox admission, and kind-specific
  promotion/wake.
- **Authority boundary:** P6 communication authority, same-Project and
  kind-direction rules; no message-level hard preemption.
- **Durable state change:** Message record, body artifact/reference, Inbox
  projection, and correlation state where applicable.
- **Observation/result:** Message delivery/admission summary or typed rejection.
- **Downstream command/event:** P6 `SendMessage` → `MessageSent`.
- **Source scenarios / decision points:** S1 DP11; S3 DP22, DP25–DP29, DP36;
  S4 DP42.
- **Why explicit rather than reasoning-only:** It crosses Workspace boundaries,
  creates durable communication, and requires recipient/correlation
  validation.

### A-COORD-02 — `DeclareDependency`

- **Family:** Coordination
- **Purpose:** Create an unmet result contract for a consumer Work.
- **Trigger condition:** Progress requires a producer/result contract that is
  not yet satisfied.
- **Model-decided semantics:** `producerBinding` and `expectedDeliverable`
  (kind and required artifact roles).
- **Runtime-bound semantics:** Consumer Work/current revision when uniquely
  bound, dependency ID/revision, authority, project, command/idempotency.
- **Target:** Consumer Work and producer binding.
- **Effect:** `DependencyDeclared`; no implicit wait or satisfaction.
- **Authority boundary:** Consumer-side Workspace authority and exact Work
  revision.
- **Durable state change:** Dependency record/event.
- **Observation/result:** Dependency created or typed rejection.
- **Downstream command/event:** P7 `DeclareDependency` →
  `DependencyDeclared`.
- **Source scenarios / decision points:** S3 DP22–DP24.
- **Why explicit rather than reasoning-only:** It creates a durable contract that
  other Work and the coordinator can observe.

### A-COORD-03 — `ProduceDeliverable`

- **Family:** Coordination
- **Purpose:** Publish an immutable formal result fact tied to a source Work.
- **Trigger condition:** The producer has a concrete result/artifact set that
  can be referenced by dependency matching or delivery.
- **Model-decided semantics:** Deliverable kind and artifact roles/reference
  selection.
- **Runtime-bound semantics:** Source Work/revision, deliverable ID, project,
  authority, command/idempotency.
- **Target:** Source Work revision and artifacts.
- **Effect:** `DeliverableProduced`; may trigger P7 structural re-check.
- **Authority boundary:** Workspace owning the source Work.
- **Durable state change:** Immutable Deliverable and artifact-role records.
- **Observation/result:** Produced Deliverable reference or typed rejection.
- **Downstream command/event:** P7 `ProduceDeliverable` →
  `DeliverableProduced`.
- **Source scenarios / decision points:** S1 DP10–DP11; S3 result/dependency
  flow and DP34–DP36.
- **Why explicit rather than reasoning-only:** It creates a durable fact with
  revision provenance and is independently consumed by dependency/delivery
  paths.

### A-COORD-04 — `RequestDependencySatisfaction`

- **Family:** Coordination
- **Purpose:** Ask the shared P7 handler to evaluate one exact Dependency and
  Deliverable pair from the consumer side.
- **Trigger condition:** A consumer execution submits a specific candidate
  pair through the P7 G6 explicit route.
- **Model-decided semantics:** Dependency ID and Deliverable ID to request.
- **Runtime-bound semantics:** Consumer Work/Workspace, exact execution
  authority, project, current Dependency revision, command identity.
- **Target:** One existing Dependency and one existing Deliverable.
- **Effect:** Submits the same `SatisfyDependency` command used by the P7
  coordinator; the structural matcher alone determines whether state changes.
- **Authority boundary:** ConsumerExecution exact-bound to the Workspace owning
  the consumer Work; producer-side execution cannot submit on its behalf.
- **Durable state change:** Dependency changes only when the canonical matcher
  succeeds; otherwise it remains unchanged with a typed rejection.
- **Observation/result:** `DependencySatisfied` or a typed mismatch, stale, or
  authority rejection.
- **Downstream command/event:** P7 `SatisfyDependency` →
  `DependencySatisfied` when the matcher accepts.
- **Source scenarios / decision points:** S3 DP22–DP24; P7 G6 explicit
  ConsumerExecution path.
- **Why explicit rather than reasoning-only:** P7 freezes a distinct,
  consumer-authorized, auditable submission path. The request is explicit;
  satisfaction remains Runtime/matcher-owned.

### A-DELIV-01 — `Deliver`

- **Family:** Delivery
- **Purpose:** Formally hand an existing Deliverable from Child to direct Parent.
- **Trigger condition:** A Deliverable exists and the Parent needs a formal
  handover rather than a cognitive Report.
- **Model-decided semantics:** Existing `deliverableId` and bounded handover
  summary/body.
- **Runtime-bound semantics:** Source ownership, direct-parent recipient,
  message/command IDs, project, authority, correlation/causation.
- **Target:** Existing Deliverable and its direct Parent Workspace.
- **Effect:** `MessageSent(kind=Deliver)` and `ChildDelivered` wake; never
  satisfies a Dependency.
- **Authority boundary:** Deliverable source Workspace and direct-parent rule.
- **Durable state change:** Delivery message/Inbox admission and wake signal.
- **Observation/result:** `MessageDelivered` or typed delivery rejection.
- **Downstream command/event:** P7 `Deliver` via P6 `SendMessage`.
- **Source scenarios / decision points:** S1 DP10–DP11; S3 DP11–DP14 and
  dependency-result flow.
- **Why explicit rather than reasoning-only:** It creates a distinct formal
  handover effect and wake reason, separate from Report and satisfaction.

### A-DEL-01 — `ProposeChildWorkspace`

- **Family:** Delegation
- **Purpose:** Propose a durable child responsibility.
- **Trigger condition:** Work has an isolable responsibility with sufficient
  independence/parallel value for a long-lived Workspace.
- **Model-decided semantics:** Name, responsibility draft, resource boundary
  draft, rationale, optional initial Work, informational depth hint.
- **Runtime-bound semantics:** Parent/project/principal, proposal ID/revision,
  structural depth, authority, generated Workspace/Session/command IDs.
- **Target:** Parent Workspace and proposed child responsibility.
- **Effect:** First-layer FormationProposal/human gate, or deep-layer
  `CreateChildWorkspace` plus optional `AssignWork`.
- **Authority boundary:** Parent formation authority; capability ceiling and
  first-layer gate are deterministic.
- **Durable state change:** Proposal or child Workspace/Work records.
- **Observation/result:** Proposal admitted, approved/rejected/modified, or
  Workspace created.
- **Downstream command/event:** P6 FormationProposal / P1
  `CreateChildWorkspace` / `AssignWork`.
- **Source scenarios / decision points:** S1 DP02, DP04; S2 DP20.
- **Why explicit rather than reasoning-only:** It changes durable organization
  and creates a governed responsibility boundary.

### A-DEL-02 — `SpawnSpecialist`

- **Family:** Delegation
- **Purpose:** Request one temporary ExecutionBound specialist.
- **Trigger condition:** A bounded sub-mission benefits from a one-shot
  specialist without creating durable responsibility.
- **Model-decided semantics:** Mission, constraints, requested skill IDs.
- **Runtime-bound semantics:** Current Workspace/project/principal, parent
  execution, generated specialist execution/session IDs, safety/quiescence.
- **Target:** One ExecutionBound specialist admission.
- **Effect:** `AdmitExecution(ExecutionBound)` and later settlement to Parent
  Inbox.
- **Authority boundary:** Current Workspace execution and capability ceiling.
- **Durable state change:** Specialist Execution/Session and settlement record.
- **Observation/result:** Admission, specialist settlement, or typed denial.
- **Downstream command/event:** P2 `AdmitExecution` through P6 specialist
  formation/settlement.
- **Source scenarios / decision points:** S1 DP02, DP04; S3 DP21.
- **Why explicit rather than reasoning-only:** It creates a separate execution
  identity and has a distinct lifetime, admission, and return path.

## Non-actions intentionally excluded

The following remain reasoning, Runtime automation, or human control rather
than additional candidate Agent actions:

- `RespondToHuman` subsumes clarification, stage completion, and post-stage
  handoff;
- `RequestParentRuling` is `SendMessage(kind=DecisionRequest)`;
- `RequestGovernance` is removed; first-layer approval is derived from
  `ProposeChildWorkspace`, while parent/design requests use `SendMessage`;
- P7 coordinator-side `SatisfyDependency` is Runtime automation; its
  ConsumerExecution request path is retained as
  `RequestDependencySatisfaction` and does not give the model authority over
  matcher results;
- `StartVerification`, `CompleteWork`, `RouteResultAndWake`,
  `AuthorizeAndAdmit`, `PersistIdleAndWait`, and `EnforceNoBlindReplay` remain
  Runtime-only;
- `LoadSkill` and `ChangeMode` remain existing execution/profile controls,
  but are not required by the S1–S4 minimal action language and are not counted
  in the 15 action candidates here.

## Candidate status

This is a semantic candidate language, not `agent-directive-v2`. It does not
define wire payloads, JSON schemas, provider tools, or representation
compilers. The candidate is intentionally allowed to map one canonical action
to multiple model-facing tools later if a model/provider capability profile
requires that representation.
