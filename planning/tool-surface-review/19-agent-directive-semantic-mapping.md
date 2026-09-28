# AgentDirective Semantic Mapping Matrix

**Date:** 2026-09-27  
**Status:** governance mapping; no implementation authorization

This matrix maps each current `agent-directive-v1` branch from Agent intent to
the downstream command/event or deterministic Runtime effect. It deliberately
does not define a model-facing tool schema.

`MODEL_DECISION`, `RUNTIME_BINDING`, `REPRESENTATION_IDENTITY`,
`NOT_REQUIRED_AT_DIRECTIVE_LAYER`, and `DESIGN_GAP` are the only ownership
labels used.

| Canonical tag | Purpose | Model-decided semantics | Runtime-bound semantics | Downstream command/event | Deterministic transformation | Required canonical payload | Validation rules | Existing v1 status | Required change |
|---|---|---|---|---|---|---|---|---|---|
| `InvokeTool` | Request one executable ToolRuntime invocation | `toolName`; exact tool input arguments | provider call correlation; execution/session/project/principal; authority, approval, invocation identity | `ToolRuntimePort.invoke` → `CanonicalToolObservation` → Session Observation | `ToolIntent` + execution context; tool catalog and authorization validate the invocation | branch identity + tool intent (`toolName`, `argumentsJson`); `callRef` is retained provider/runtime correlation | catalog identity, argument schema, authority, safety admission, side-effect/reconciliation rules | **CLOSED** | preserve v1 shape; future representation may derive branch identity and callRef |
| `Communicate` | Send a cognitive work-plane message or formal handover | kind; authored content; Query destination; explicit reply/target choice when not uniquely bound | sender/project/principal/execution; Report/DecisionRequest parent route; durable message ID; correlation/causation allocation and validation; urgency `Normal` | `SendMessage` → `MessageSent` + Inbox admission + kind-specific promotion/wake | build/persist durable content, bind `bodyRef`, validate target/correlation, then construct `OutboundMessage` | `kind`, semantic destination/target, authored content or an already valid ContentRef, and any explicit target needed to select a Reply; runtime-only message metadata is excluded | kind-specific direction, same-Project target, active recipient, body quota/reference, exact correlation, authority; Report ≠ Deliverable; Deliver requires deliverable reference | **DRIFT / NOT CLOSED** (`message.text` only) | close body persistence and reply-target contract; replace text-only branch in v2 |
| `DeclareDependency` | State an unmet result requirement for the consumer Work | `producerBinding` and `expectedDeliverable` (kind + required artifact roles); explicit consumer Work only when current focus is not unique | consumer Work/current revision when uniquely Work-bound; dependency ID, initial dependency revision, command ID, authority, project | `DeclareDependency` → `DependencyDeclared` | create command payload from semantic spec + exact Work control basis; no implicit Yield/WorkWait | `producerBinding`, `expectedDeliverable`, and a consumer Work reference when not uniquely bound | Open Work, exact observed Work revision, same Project, valid producer target, authority; no verification/completion precondition | **DRIFT / NOT CLOSED** (`spec: unknown`, `{}`) | add typed v2 payload; keep command-only IDs/revisions out of directive |
| `RequestGovernance` | Ask for a human or parent governance route | variant (`FormationApproval` or `DecisionRequest`); non-empty question for DecisionRequest; explicit existing proposal target if no unique binding | proposal revision when bound to the just-admitted proposal; parent route; sender/issuer/project/principal; message/correlation IDs; authority | FormationApproval → Governance Inbox admission; DecisionRequest → `SendMessage` (`DecisionRequest`) → `MessageSent`/parent Inbox | route exact request through governance/application boundary; never decide or mutate governance directly | discriminated request variant; `proposalId` + exact revision or a frozen current-proposal binding; `question` for DecisionRequest; optional semantic reply correlation only if contract permits | exact proposal existence/state/revision; non-empty question; parent route; authority; RecordDecision remains separate | **DRIFT / NOT CLOSED** (`request: unknown`, `{}`) | add typed v2 discriminated payload and exact-target rule |
| `SpawnSpecialist` | Request a one-shot ExecutionBound specialist | `mission`, `constraints`, requested `skillIds` | current Workspace/project/principal/authority; parent execution; generated specialist execution/session/command IDs; quiescence and safety | `AdmitExecution(ExecutionBound)` → execution admission/settlement observation | transform `SpecialistSpec` into generic P2 admission; settlement returns only through parent Inbox | `mission`, `constraints`, `skillIds` | non-empty mission; skills resolved by Registry; parent binding/authority; stop/quiescence and safety gates | **DRIFT / NOT CLOSED** (`spec: unknown`, `{}`) | add typed v2 payload; do not expose generated identities to the model |
| `ProposeChildWorkspace` | Propose a long-lived child responsibility | name; responsibility draft; resource boundary draft; rationale; optional initial Work; informational depth hint | parent/project/principal; proposal and command IDs; revision; formation depth path; authority and capability ceiling | first layer → FormationProposal + human Inbox; deep layer → `CreateChildWorkspace` → optional `AssignWork` → Workspace/Work events | preserve proposal draft; deterministically choose human-gate vs deep path from Workspace tree; construct P1 commands | complete `ChildWorkspaceProposal` from P6; no verification mission field | non-empty/typed proposal; resource boundary subset; parent authority; depth hint cannot override structural depth; initial Work fields map only to P1 frozen fields | **DRIFT / NOT CLOSED** (`spec: unknown`, `{}`) | add typed v2 payload; keep P1 generated IDs and authority facts out |
| `LoadSkill` | Request progressive Skill disclosure | `skillId`, `tier` (`Summary`/`Body`) | registry revision/content/provenance; capability availability; execution identity | `SkillRegistry.load` → bounded Skill Observation | resolve requested Skill through Registry; append observation | `skillId`, `tier` | Registry existence, allowed tier/progressive-load policy, A0–A3 authority precedence | **CLOSED** | retain v1 shape |
| `ChangeMode` | Select a cognitive mode for later turns | named mode | execution identity/current state; available mode/profile and authorization | AgentExecutionState update → mode Observation | validate and persist `currentMode`; next `prepareTurn` selects the corresponding program/profile | mode name | mode must be supported by resolved capability/profile; no safety/governance bypass | **CLOSED WITH PROFILE VALIDATION** | preserve shape; tighten capability validation outside payload |
| `CompletionClaim` | Claim that the current Work outcome is ready for verification | `claimRef` / claim reference semantics | exact current Work binding and revision; execution settlement identity/fence; downstream verification binding | `SettleExecution(Completed(CompletionClaimed))` → `ExecutionSettled` → P8 `StartVerification` consumer | persist claim and exact target revision; never CompleteWork directly | `claimRef` plus exact Work/revision binding (payload may carry revision when not uniquely bound) | active execution, current Work, exact revision/freshness, non-empty claim reference; Work remains Open | **CLOSED FOR WORK-BOUND EXECUTION** | preserve semantics; clarify v2 binding form if generic coordination is admitted |
| `Yield` | Declare a wait condition and settle the current slice | non-empty reason; wait condition kind/target/observed value; requested time for `TimeReached` | execution/work binding; canonical `mode: "Any"`; durable WorkWait registration; timer/wake ownership | `SettleExecution(Completed(Yielded))` → `ExecutionSettled` + WorkWait → wake/reevaluate | validate wait spec, atomically settle/register WorkWait, re-read observations, and wake if already changed | reason + non-empty `WaitSpec.conditions`; condition fields exactly as frozen | allowed condition union; non-empty conditions; observed revisions/sequences; no suggested next Work; lost-wake protection | **CLOSED** | retain v1 shape |

## Branch proofs

### Soundness

Each branch has one owning downstream interpretation after branch identity is
known. `InvokeTool`, `LoadSkill`, `ChangeMode`, `CompletionClaim`, and `Yield`
already have typed v1 paths. The five drift branches require typed payloads
before the same claim can be made. No Runtime binding may create missing model
meaning.

### Completeness

The matrix preserves every downstream-required semantic field for all ten
current branches. It explicitly records the missing `Communicate` body
persistence and reply-target rules instead of pretending that `message.text`
contains them.

P7's `ProduceDeliverable`, `SatisfyDependency`, and `Deliver` vocabulary is
listed separately in [18](./18-canonical-agent-directive-reconciliation.md)
because those tags are not in the current ten-tag decoder allowlist. They
cannot be silently counted as closed current branches.

### Semantic preservation

For the five drift branches, preservation is conditional on a new typed
canonical contract:

- `DeclareDependency`: producer binding and expected deliverable are retained
  exactly; command IDs/revisions are generated or bound by Runtime.
- `RequestGovernance`: request variant, question, and exact proposal target are
  retained; routing and decision remain downstream concerns.
- `SpawnSpecialist`: mission/constraints/skills are retained; admission
  identity is generated by P2/P6.
- `ProposeChildWorkspace`: the complete P6 proposal draft is retained; depth
  and capability checks remain deterministic.
- `Communicate`: not yet proven because P6 does not freeze the
  model-authored-content → durable `bodyRef` transformation or a general
  multi-open-Query Reply target.

## Status

The ten mapping rows are complete as an audit artifact. Canonical contract
readiness is not complete: five branches are drifted in v1, and
`Communicate` retains two unresolved semantic transformations. This matrix
does not authorize a representation compiler or Runtime implementation.
