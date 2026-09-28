# Agent Action Language Gap Review

**Date:** 2026-09-27
**Status:** Design analysis only; no implementation authorization

This review tests the candidate language in
[25-agent-action-language-candidate.md](./25-agent-action-language-candidate.md)
against minimality, orthogonality, and S1–S4 coverage. It does not define
`agent-directive-v2`, JSON schemas, or model-facing tool schemas.

## Minimality check

The candidate has **15 explicit Agent actions** across seven active families,
plus one non-Agent Human/Governance boundary family.
Each one passes the deletion test:

> If this action is removed, a legal S1–S4 intent cannot be expressed with the
> same effect, authority, lifecycle, and observation through another candidate
> action.

| Candidate action | Deletion result | Reason |
|---|---|---|
| `RespondToHuman` | `REQUIRED_ACTION` | No other action produces the P14 user-visible response episode. |
| `InvokeTool` | `REQUIRED_ACTION` | No other action invokes a capability or carries ToolRuntime reconciliation semantics. |
| `AssignWork` | `REQUIRED_ACTION` | No other action creates an Open Work on an existing Workspace with its own assignment authority and revision binding. |
| `Wait` | `REQUIRED_ACTION` | No other action registers canonical WorkWait and suppresses polling. |
| `ClaimCompletion` | `REQUIRED_ACTION` | No other action creates the producer-to-verifier lifecycle boundary. |
| `AcceptWorkOutcome` | `REQUIRED_ACTION` | No other action records Parent sufficiency with exact verification binding. |
| `RecordVerificationEvidence` | `REQUIRED_ACTION` | Evidence append is distinct from concluding a Verification. |
| `ConcludeVerification` | `REQUIRED_ACTION` | Terminal Pass/Fail/Unknown is distinct from evidence append and acceptance. |
| `SendMessage` | `REQUIRED_ACTION` | No other action creates typed durable P6 communication and Inbox admission. |
| `DeclareDependency` | `REQUIRED_ACTION` | No other action creates an unmet result contract. |
| `ProduceDeliverable` | `REQUIRED_ACTION` | No other action creates an immutable, revision-bound Deliverable fact. |
| `RequestDependencySatisfaction` | `REQUIRED_ACTION` | P7 G6 preserves a consumer-execution request route with its own authority source; the shared matcher remains authoritative. |
| `Deliver` | `REQUIRED_ACTION` | No other action performs formal Deliverable handover and `ChildDelivered` wake. |
| `ProposeChildWorkspace` | `REQUIRED_ACTION` | No other action creates a durable child responsibility/proposal. |
| `SpawnSpecialist` | `REQUIRED_ACTION` | No other action admits a temporary ExecutionBound specialist. |

## Disposition of the original 26 model-facing candidates

The old 26 names do not survive one-to-one. **17 names cease to be separate
action identities**; their semantic work becomes reasoning, or (for the two
handoff rows) remains an unresolved intent:

```text
SelectNextWorkAction
TriageIncomingInput
ClassifySteerScope
AbsorbCorrection
ResumeAutonomy
ProposeResponsibilityHandoff
RepairOrGatherEvidence
IntegrateVerifiedResult
ChooseLocalResolution
ContinueIndependentWork
RecoverAfterDenial
RecoverAfterExecutionFault
ReconcileUnknownExternalEffect
RestoreContinuationContext
AssessStalenessAndDrift
ChooseReentryPath
DistinguishContinuationOrNewResponsibility
```

The remaining semantics consolidate into **nine action identities**:

```text
RespondToHuman
AssignWork
ProposeChildWorkspace
SpawnSpecialist
ClaimCompletion
RecordVerificationEvidence
ConcludeVerification
SendMessage
Deliver
```

Six more actions come from explicit/command rows outside the original 26:
`InvokeTool`, `Wait`, `AcceptWorkOutcome`, `DeclareDependency`,
`ProduceDeliverable`, and P7 G6's `RequestDependencySatisfaction`. This gives
15 candidate actions total. The 17 retired names are not lost behaviors:
except for the responsibility handoff gap, they are decision criteria or
content choices that lead to one of the explicit action boundaries.

No candidate is marked `REDUNDANT_ACTION`. Several former names are redundant
only because they are reasoning labels or aliases for a candidate action:

- `RequestParentRuling` → `SendMessage(kind=DecisionRequest)`;
- `RequestGovernance` → formation-derived human gate or
  `SendMessage(kind=DecisionRequest)`;
- `PersistIdleAndWait` → `Wait` plus Runtime parking;
- coordinator-side `SatisfyDependency` → Runtime automation; its
  ConsumerExecution submission remains `RequestDependencySatisfaction`;
- `ClarifyDirection` / stage summary / post-stage handoff →
  `RespondToHuman`.

## Orthogonality check

| Check | Result | Explanation |
|---|---|---|
| `SendMessage` vs `Deliver` | `ORTHOGONAL` | Deliver references an existing Deliverable, derives the direct Parent, emits `ChildDelivered`, and never satisfies a Dependency. |
| `AssignWork` vs `ProposeChildWorkspace(initialWork?)` | `ORTHOGONAL BY TARGET STATE` | AssignWork targets an existing Workspace; optional initialWork belongs to the P6/P1 creation path for a new child. |
| `RequestDependencySatisfaction` vs coordinator `SatisfyDependency` | `SAME_COMMAND / DISTINCT AUTHORITY SOURCE` | Both use the same matcher/handler, but P7 G6 preserves consumer-execution and coordinator sources. Keep the explicit Agent request and automatic route distinct. |
| `ProduceDeliverable` vs `ClaimCompletion` | `ORTHOGONAL` | A Deliverable is an immutable result fact and may be produced before or independently of verification; a CompletionClaim starts quality checking. |
| `ClaimCompletion` vs `ConcludeVerification` | `ORTHOGONAL` | Producer readiness and independent quality judgment have different actors, authority, and lifecycle. |
| `ConcludeVerification` vs `AcceptWorkOutcome` | `ORTHOGONAL` | Pass means the result meets its mission; acceptance means it is sufficient for the Parent outcome. |
| `ProposeChildWorkspace` vs `SpawnSpecialist` | `ORTHOGONAL` | Durable Workspace responsibility and temporary ExecutionBound execution differ in lifetime, identity, return path, and authority. |
| `DeclareDependency` vs `Wait` | `ORTHOGONAL` | Declaring a contract does not imply waiting; waiting registers a condition only when no eligible work remains. |
| `SendMessage(Query)` vs `InvokeTool(read)` | `ORTHOGONAL` | One requests another Workspace's authorized observation; the other invokes an admitted capability in the current execution. |
| `RecordVerificationEvidence` vs `InvokeTool` | `ORTHOGONAL` | Tool observation may be an input; evidence recording is a verifier-authorized durable fact. |
| `AcceptWorkOutcome` vs `CompleteWork` | `ORTHOGONAL` | Acceptance is an Agent/Human governance action; completion is a deterministic consumer after Pass + Acceptance. |

## Remaining ambiguity findings

### `SendMessage` kind representation

The canonical action should remain one `SendMessage` identity with a closed
semantic `kind` set for `Query`, `Reply`, `Report`, and `DecisionRequest`.
This is not a “universal communicate” action:

- each kind has a distinct purpose;
- target/correlation rules are kind-specific;
- Runtime validates direction and authority;
- the durable command and base lifecycle are shared.

Provider-facing representations may later split these into separate concrete
tools if a model needs stronger affordance separation. That does not require
separate canonical actions.

`Deliver` remains a separate canonical action because its target is derived from
the Deliverable's source Workspace, its payload references an existing
Deliverable, and its wake semantics differ.

### `AcceptWorkOutcome` actor

The action can be issued by a Parent Agent or an authorized Human depending on
the Work/root milestone. The action vocabulary therefore records an explicit
governance effect without claiming that every execution may expose it to its
model. Visibility remains an execution-purpose/capability decision.

### `RespondToHuman` and ordinary assistant text

The action is semantic rather than a new ToolRuntime capability. It is kept
because P14 guarantees a durable, exactly-once user-visible response episode.
Its representation may remain ordinary model text in a Coordination turn; the
action language does not require a directive branch for it.

## Missing actions

### `MISSING_ACTION: ResponsibilityHandoff`

S2 DP20 and S4 DP49 require a formal way to transfer long-lived responsibility
when “what to do” changes into “who owns it”. The current frozen P6 material
explicitly covers child formation, specialist admission, and ownership
constraints, but does not freeze a complete successor/retire/handoff command
and event chain.

This is a **contract gap**, not permission to add a new action now. Until the
governance contract is frozen, the candidate can express:

- ordinary objective/constraint change through existing Work/steer flow;
- a proposal to change organization through the existing formation surfaces;
- a parent ruling request through `SendMessage(DecisionRequest)`.

It cannot losslessly express a completed durable handoff.

`AssignWork` was absent from the original 43-row inventory but is already a
frozen P1 command. The candidate adds it as `A-WORK-04`; this closes the
“ready to begin / supplementary Work” effect-boundary omission without adding
new product semantics.

`AssignWork` was absent from the original 43-row inventory but is already a
frozen P1 command. The candidate adds it as `A-WORK-04`; this closes the
“ready to begin / supplementary Work” effect-boundary omission without adding
new product semantics.

### No separate `RequestPermission` action

S3 says that a concrete operation may require approval or a Parent ruling, but
the current contracts do not define a standalone Agent permission-grant
command. P4 freezes exact-intent approval matching, while permission resolution
and approval production are explicitly deferred. The candidate therefore uses:

- `InvokeTool`/command request, followed by typed Runtime denial;
- `SendMessage(DecisionRequest)` for a specific ruling/resource request;
- existing human governance where a concrete approval contract exists.

This is recorded as `DEFERRED_GOVERNANCE_CONTRACT`, not as a second
`MISSING_ACTION`: adding a `RequestPermission` action would invent the
permission-resolution semantics that the current contracts defer. A
DecisionRequest must not be treated as a grant; any eventual grant still needs
to bind the exact action digest and resources.

## P7 three-operation review

| Operation | Final classification | Model-facing status | Reason |
|---|---|---|---|
| `ProduceDeliverable` | Explicit Agent action | Candidate `A-COORD-03` | Model selects result kind/artifact roles; Runtime binds source Work/revision and creates immutable fact. |
| `Deliver` | Explicit Agent action | Candidate `A-DELIV-01` | Model chooses formal handover and summary; Runtime derives direct Parent and emits delivery wake. |
| `SatisfyDependency` | Explicit consumer request plus Runtime automation | Candidate `A-COORD-04` on `ConsumerExecution`; coordinator path is Runtime-only | P7 G6 preserves two authorized submission sources for the same command; the structural matcher remains authoritative in both paths. |

P7's G5/G6 governance inputs are frozen, while the detailed P7 command
documents remain marked DRAFT. This classification preserves the frozen
explicit ConsumerExecution route and does not claim every implementation
detail is closed.

`SatisfyDependency` is neither a Completion result shape nor a model-facing
“mark satisfied” decision. The explicit consumer action is a request to run the
shared matcher; only that matcher and the command handler can make the
deterministic dependency state transition.

## Overlap and naming findings

| Finding | Status | Disposition |
|---|---|---|
| `OVERLAPPING_ACTION` — `Communicate` versus Query/Reply/Report/DecisionRequest | Closed at language level | Use `SendMessage` with kind semantics; do not keep a generic Communicate action. |
| `OVERLAPPING_ACTION` — `RequestGovernance` versus DecisionRequest | Closed | Remove generic RequestGovernance; use `SendMessage` or formation-derived gate. |
| `SAME_EFFECT_DIFFERENT_NAME` — `RequestParentRuling` and DecisionRequest | Closed | One `SendMessage` action. |
| `SAME_EFFECT_DIFFERENT_NAME` — `PersistIdleAndWait` and Wait | Closed | One `Wait` action; parking is Runtime. |
| `SAME_NAME_DIFFERENT_EFFECT` — `Communicate` Report vs Deliver | Closed | `SendMessage(Report)` and `Deliver` are separate semantics. |
| `SAME_NAME_DIFFERENT_EFFECT` — `RequestGovernance` approval vs escalation vs permission | Closed | No common canonical action. |
| `AMBIGUOUS_ACTION_SELECTION` — `ClaimCompletion` vs `ProduceDeliverable` | Resolved | Claim is quality-chain entry; ProduceDeliverable is a result fact. They may occur in either order where contracts permit. |
| `AMBIGUOUS_ACTION_SELECTION` — `SendMessage(Report)` vs `Deliver` | Resolved | Report carries cognitive exposure; Deliver references a formal Deliverable and emits a distinct wake. |
| `AMBIGUOUS_ACTION_SELECTION` — `Wait` vs “do nothing” | Resolved | Waiting requires an explicit canonical condition; idle with no condition is Runtime parking, not an Agent action. |
| `SAME_COMMAND / DISTINCT AUTHORITY SOURCE` — Agent/coordinator `SatisfyDependency` | Resolved | Preserve the P7 G6 consumer request and deterministic coordinator path; both use the same matcher. |

## Design readiness

The action language is sufficiently consolidated to serve as the semantic
source for a future contract review. It is **not yet sufficient to design
`agent-directive-v2`** because:

1. the current five v1 branch payloads remain drifted;
2. P6 `Communicate` content-to-`bodyRef` and non-unique Reply targeting remain
   unresolved;
3. `ResponsibilityHandoff` lacks a frozen downstream contract;
4. P7 command documents still contain draft-owned evolution around the
   directive vocabulary;
5. canonical action payload ownership has not been reconciled for the new
   candidate actions.

Therefore:

```ini
action_language_consolidation = READY_FOR_GOVERNANCE_REVIEW
agent_directive_v2_design = NOT_READY
implementation = NOT_AUTHORIZED
```
