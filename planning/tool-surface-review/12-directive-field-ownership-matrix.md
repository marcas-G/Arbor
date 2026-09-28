# Canonical Directive Field Ownership Matrix

**Status:** governance decision input; no schema or implementation change.

## Ownership labels

- **MODEL_SUPPLIED:** the model selects or produces semantic content. A representation may flatten or rename it, but may not invent it.
- **RUNTIME_BOUND:** the admitted execution, authenticated context, current control basis, or authoritative store uniquely supplies it.
- **DERIVED_FROM_REPRESENTATION_IDENTITY:** the representation tool name/profile supplies a discriminant or routing identity. This is deterministic mapping, not semantic defaulting.
- **MIXED / BOUND-THEN-VALIDATED:** the model may select a target or intent, while Runtime binds the current identity/revision and validates the relationship. It is not safe to omit the semantic target unless the current binding uniquely identifies it.

## Global fields

| Field | Decision | Model discretion? | Runtime fact? | May representation omit? | Rule/evidence |
|---|---|---:|---:|---:|---|
| `_tag` | `DERIVED_FROM_REPRESENTATION_IDENTITY` for split tools; model-supplied only in legacy monolith | No in split profile | Decoder knows branch | Yes in split profile | `decode.ts:420-428`; branch tool identity is deterministic |
| `projectId` | `RUNTIME_BOUND` | No for current execution | Yes | Yes | `ToolExecutionContext`, gateway command envelopes |
| `workspaceId` | `RUNTIME_BOUND` when current execution target; `MODEL_SUPPLIED` only as a semantic target in a future explicitly typed cross-workspace request | Usually no | Yes for current execution | Yes only when current binding is unique | execution binding and handler code |
| `executionId` | `RUNTIME_BOUND` | No | Yes | Yes | `ToolExecutionContext`, driver input |
| `sessionId` | `RUNTIME_BOUND` | No | Yes | Yes | `ToolExecutionContext`, formation/spawn handlers |
| `workId` | `MIXED / BOUND-THEN-VALIDATED` | Model may select a target work only when the branch semantics allow targeting another work | Current focused Work is known | Only when current focus uniquely determines it | driver focus selection; `AcceptWorkOutcome` triple binding |
| `workRevision` / observed revision | `RUNTIME_BOUND` for current focused Work revision; model may choose an observed target only where canonical semantics explicitly make it a comparison target | No for current claim | Yes | Yes when current control basis uniquely binds it | Completion claims are revision-sensitive; runtime must reject stale values |
| `authenticatedPrincipal` / issuer / actor | `RUNTIME_BOUND` | No | Yes | Yes | `CommandSubmissionContext`, handler context |
| authority / capability ceiling | `RUNTIME_BOUND` | No | Yes | Yes | `InvocationAuthority`, gateway authority facts |
| resource boundary | `MIXED` | Model may propose a draft boundary; Runtime validates it is within parent ceiling | Parent/current boundary is authoritative | Only proposal drafts may be represented | `ChildWorkspaceProposal`, `validateCapabilityCeiling` |
| verification binding | `MIXED / BOUND-THEN-VALIDATED` | Model may choose a verification target only if the branch semantics expose that choice | Runtime knows open verification, work/revision, acceptance and owner bindings | Only if one unique verification is already bound | `StartVerification` and `AcceptWorkOutcome` enforce exact binding |
| message correlation / causation / inbound binding | `RUNTIME_BOUND` | No | Message/execution trigger knows it | Yes | P14 conversation trigger and command context |
| provider `callRef` / invocation identity | `DERIVED_FROM_REPRESENTATION_IDENTITY` plus provider event identity | No semantic discretion | Provider/runtime owns correlation | Yes from model-facing schema | `CanonicalProviderEvent.callRef`; handler derives invocation id |

## Branch matrix

### `InvokeTool`

| Canonical field | Ownership | Decision |
|---|---|---|
| `intent.callRef` | Derived/provider-bound | Do not ask the model to invent a globally meaningful id. Preserve provider call correlation or derive a runtime invocation reference. |
| `intent.toolName` | Model-supplied or representation-derived | For a generic invoke representation, model selects the executable tool; for a concrete directive tool, identity may derive the name. Runtime still resolves the catalog definition. |
| `intent.argumentsJson` | Model-supplied | Exact arguments are semantic tool intent. No defaulting or repair by omission. |

### `Communicate`

| Canonical field | Ownership | Decision |
|---|---|---|
| `message.text` | Model-supplied | Content is the model's semantic output. Runtime binds sender, workspace, execution, correlation, and delivery authority. |

### `DeclareDependency`

| Canonical field | Ownership | Decision |
|---|---|---|
| `spec` semantic dependency target, kind, and satisfaction criteria | Model-supplied | These fields are not currently specified by the `{}` schema; governance must define them before a lossless model-facing representation can be frozen. |
| origin/project/workspace/execution/correlation | Runtime-bound | Not repeated in model-facing representation. |

### `RequestGovernance`

| Canonical field | Ownership | Decision |
|---|---|---|
| `request` semantic request kind, target, reason, and requested decision | Model-supplied | The model chooses what governance action/request is needed; it cannot choose issuer authority. |
| issuer/principal/project/workspace/execution/correlation | Runtime-bound | Bound from the authenticated execution and gateway context. |
| exact proposal/decision revision, when selecting an existing record | Mixed / bound-then-validated | A target id/revision may be model-supplied when choosing among records; Runtime must bind/check the durable revision. No guessed proposal id or revision. |

### `SpawnSpecialist`

| Canonical field | Ownership | Decision |
|---|---|---|
| `spec.mission` | Model-supplied | Required semantic purpose; handler already validates non-empty mission (`directives.ts:230-240`). |
| `spec.constraints` | Model-supplied | Semantic mission constraints if present in the final typed payload. |
| `spec.skillIds` | Model-supplied | Requested skills only; registry decides availability and authority. |
| `executionId`, `sessionId`, `commandId`, `parentExecutionId` | Runtime-bound/derived | Handler currently generates ids and binds parent execution (`directives.ts:246-266`). |
| `workspaceId`, `projectId`, principal, authority | Runtime-bound | Derived from current execution/context. |

### `ProposeChildWorkspace`

| Canonical field | Ownership | Decision |
|---|---|---|
| `spec.name` | Model-supplied | Proposed child name. |
| `spec.responsibilityDraft` | Model-supplied | Proposed responsibility semantics; Runtime validates parent/child ceiling. |
| `spec.resourceBoundaryDraft` | Model-supplied | Proposed narrower boundary; Runtime validates subset. |
| `spec.rationale` | Model-supplied | Semantic explanation for proposal. |
| `spec.initialWork` | Model-supplied | Optional proposed initial objective/why/constraints/completion expectation. |
| `spec.formationDepthHint` | Model-supplied | Hint only; Runtime chooses the legal formation path. |
| `proposalId`, `parentWorkspaceId`, child workspace/session/work ids, command ids, revisions, project/principal/actor | Runtime-bound/derived | Handler and `formation-plan.ts` allocate/bind these. |
| capability ceiling outcome | Runtime-bound | Runtime validates; model cannot self-authorize expansion. |

### `LoadSkill`

| Canonical field | Ownership | Decision |
|---|---|---|
| `skillId` | Model-supplied | Requested skill identity; must resolve through the registry. |
| `tier` | Model-supplied | `Summary` or `Body`, subject to progressive-load policy. |
| skill revision/content provenance | Runtime-bound | Registry supplies the committed revision/content. |

### `ChangeMode`

| Canonical field | Ownership | Decision |
|---|---|---|
| `mode` | Model-supplied | Model proposes a mode; Runtime checks the binding/profile supports it and persists it. |
| execution identity/current state | Runtime-bound | `ChangeMode` handler reads and updates the current execution state. |

### `CompletionClaim`

| Canonical field | Ownership | Decision |
|---|---|---|
| `claim.claimRef` | Model-supplied | Semantic claim correlation/content reference; no invented default. |
| `claim.workRevision` | Runtime-bound for current Work claim | Representation may omit it when the current Work/control basis uniquely binds the revision; Runtime restores/checks exact revision and rejects stale claims. |
| verification/acceptance binding after claim | Runtime-bound | Downstream verification dispatch and acceptance use exact work/revision/verification facts. |

### `Yield`

| Canonical field | Ownership | Decision |
|---|---|---|
| `reason` | Model-supplied | Semantic reason for yielding. |
| `waitSpec.mode` | Derived/validated | Current canonical contract fixes `Any`; model need not repeat a constant in a split representation. |
| condition kind (`DependencyChanged`, `DecisionChanged`, `VerificationChanged`, `InboxAdvanced`, `EnvironmentChanged`, `TimeReached`, `Manual`) | Model-supplied | Model chooses what fact it is waiting for. |
| dependency/decision/work/environment target ids | Mixed | Model chooses a target when the wait is semantically about another known object; current execution/workspace may be bound when uniquely implied. |
| observed revision/sequence | Runtime-bound or model-observed value, then validated | Runtime must compare against canonical current state; representation cannot invent a revision. |
| `workspaceId` in `InboxAdvanced` | Runtime-bound when current workspace | Omit only when current execution uniquely identifies it. |
| `instant` in `TimeReached` | Model-supplied | Requested future time is semantic wait intent. |

## Non-negotiable rules

1. A representation identity may derive `_tag`, a tool branch, or a provider correlation id; it may not derive mission, reason, message text, target choice, or missing required business data.
2. Runtime-bound ids and principals must not be exposed as redundant model decisions.
3. Any mixed field must retain exact binding and stale/revision validation.
4. The four existing `{}` payloads (`DeclareDependency`, `RequestGovernance`, `SpawnSpecialist`, `ProposeChildWorkspace`) are not losslessly representable until their canonical semantic fields are typed and frozen.
5. This matrix does not authorize deleting fields from the canonical contract. It defines what a future representation may omit only when a frozen binding uniquely restores it.
