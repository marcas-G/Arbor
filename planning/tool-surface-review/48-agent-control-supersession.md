# Agent Control Architecture Supersession

**Date:** 2026-09-27
**Status:** ACCEPTED / IMPLEMENTED — historical proposal reconciled through DID
v1.18 AgentAction adoption and v1.26 field-source closure
**Accepted direction:** `REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`
**Production implementation:** AUTHORIZED / COMPLETE

## Supersession statement

This review adopts the following direction for future architecture design:

```ini
AgentDirective as versioned canonical wire/output contract = SUPERSEDED
Internal AgentAction ADT = RETAINED
```

The superseded boundary is specifically the requirement that model output
decode into one formal, versioned `AgentDirective` JSON union. It does **not**
supersede model-facing typed tools, trusted Runtime context, Application
commands, Domain lifecycle rules, or durable effects.

`AgentDirective v2` schema design is stopped. Its field-source gaps are no
longer a v2-schema gate; the four items are reclassified in §6. Earlier v1/v2
documents remain available as design history and evidence. Nothing is deleted.

This is a supersession proposal for the frozen source of truth. The frozen DID
and phase contracts still contain the older wording because this task does not
edit `docs/design/**`. Their governing owners must record the formal source
change before implementation begins.

## New core boundary

```text
Model-facing Tool Representation
!=
Internal AgentAction
!=
Application Command
```

| Layer | Owns | Does not own |
|---|---|---|
| **Model-facing Tool** | Model-readable affordance, input schema, model/provider-compatible shape, provider call decoding into a generic typed tool invocation. | Domain transitions, trusted authority, durable business identity. |
| **Internal AgentAction** | In-process semantic action identity; common Runtime routing, freshness/admission classification, policy dispatch, and action-class audit classification. | Provider JSON shape, durable wire/version contract, authentication truth, command DTOs, persistence of the whole action object. |
| **Application Command** | Runtime-bound IDs/revisions/principal/authority facts, durable refs, transactions, canonical state transitions and events. | Guessing model intent or accepting model-supplied Runtime identity as authority. |

The word “authority” on the `AgentAction` side means **dispatching to the
appropriate authority check**, not supplying or deciding the trusted authority
fact. Visibility remains distinct from authorization.

## Contract and marker supersession proposal

| Existing frozen/planning statement | Proposed new status | Source that needs an owned supersession edit |
|---|---|---|
| DID §8.15: each turn emits the structured `AgentDirective` vocabulary. | Supersede the universal union/output claim. Define the model-tool → internal-action distinction and the limited internal action scope. | `docs/design/03-detailed-implementation-design.md` §8.15; related change-history markers at DID v1.10/v1.14. |
| DID §8.19: every effectful AgentDirective carries `decisionBasisManifestId`. | Preserve freshness binding, but carry the control basis in trusted turn/invocation context around an internal action; it is not a model-authored payload field. | DID §8.19; P3 `02-model-context-contracts.md` §6 / P3 `06-provider-failure-repair.md` §4. |
| DID §10.6: `ModelContext.decodeTurn()` produces and dispatches AgentDirective. | Keep provider-neutral event decoding in Model Context; move semantic control-tool codec and AgentAction construction to Agent Runtime's control registry. | DID §10.6; P3 `00-contract-index.md`, `01-provider-contracts.md`, `02-model-context-contracts.md`, `03-agent-loop-driver.md`. |
| DID §7.6 says organizational commands continue through AgentDirective while executable tools use ToolRuntime. | Preserve ToolRuntime for executable tools; add a distinct Control Tool route through Agent Runtime and Application. | DID §7.6; P4 `00-contract-index.md` and `01-tool-contracts.md`. |
| P3 Output Contract admits directive kinds, and P5 has `DirectiveUnsupported`. | Replace directive-kind allowlisting with per-tool schema/codec validation and a registry completeness rule. Exposed control tools must have a handler; unknown/unregistered calls fail closed. | P3 `03-agent-loop-driver.md` §§3–5; P5 `03-directive-handling.md`, `05-slice-acceptance.md`. |
| P4 `ToolIntent.callRef` is described as coming from `AgentDirective.InvokeTool`. | Preserve `ToolIntent` for executable tools, but source its call identity from the generic normalized provider tool-call event. | P4 `00-contract-index.md`, `01-tool-contracts.md` §3. |
| P6 `Communicate` and P7 directive references are the model-to-application bridge. | Preserve P6/P7 semantics and commands, but route typed control tools through internal actions rather than a universal output union. | P6 `00-contract-index.md`, `01-formation-semantics.md`, `02-communication-protocol.md`; P7 `01-dependency-deliverable-commands.md`, `02-deliver-primitive.md`. |
| `agent-directive-v1` / `completion-claim-v1` and planning `AgentDirective v2` are candidate output-contract identities. | Stop generating the v1/v2 union as the universal control contract. Keep old metadata readable and keep the planning documents as historical research. | Runtime output-contract registry and P3 contract references; planning docs `35–43` and `44–47` are archived evidence, not frozen design authority. |

P3 `CanonicalProviderEvent` remaining distinct from semantic action is
**retained**. Its invariant should be restated as “provider events are
transport vocabulary and do not themselves assert an authorized AgentAction.”

The listed P1/P3/P4/P5/P6/P7/P8 command, Domain, authority, transaction, and
recovery contracts remain authoritative unless their specific text states the
superseded model-action bridge. This proposal does not weaken them.

## Historical materials to retain

Retain, without deleting or silently rewriting:

- `agent-directive-v1` definitions, manifests, session `directiveKinds`, and
  tests as historical version evidence;
- `planning/tool-surface-review/00–47` as action inventory, field-source,
  representation experiment, decision-boundary, and v1/v2 design history;
- the v2 field-source findings and the prior summary-ref assessment as evidence
  for the separate gaps below;
- old ProviderTurn and Session rows containing output-contract refs.

No full AgentDirective payload is persisted in the inspected clean-HEAD path,
so no historical directive JSON replay or conversion is proposed. Readers of
old metadata may still need to render its contract ref and tag summary.

## Reclassification of the four former v2 blockers

These remain open design questions where noted, but they are not blockers to
choosing the AgentAction architecture:

| Former gap | New classification | Current disposition |
|---|---|---|
| `AssignWork.Provenance` | **Application command mapping / P1 semantic-source gap.** `predecessorWorkId` and `reason` have no generally frozen source or transform. They are not automatically AgentAction fields or Runtime bindings. | `DESIGN_UNRESOLVED`; do not infer from current Work, `why`, or convenience metadata. See `40-v2-field-source-closure.md`. |
| ToolObservation source identity | **Control-tool semantic selection + P4/P8 evidence-reference gap.** The verifier must select an exact evidence source, but no frozen stable handle links the selected bounded observation to a durable EvidenceRecord. | `DESIGN_GAP`; do not equate `ToolInvocationId`, `resultRef`, or Session `ref` without a governed rule. See `41-verification-reference-semantics.md`. |
| `ConcludeVerification.summaryRef` | **Split ownership:** the prior G-V2-3 assessment recommends model-authored summary content, with Runtime persistence producing the ref; the remaining **P8 command/domain persistence gap** is the missing durable Verification-to-ref association. Neither is an AgentAction-schema field-source gate. | Summary-content ownership is a governance candidate, not a frozen ruling; durable P8 association remains `DESIGN_UNRESOLVED`. See `44-g-v2-3-conclusion-summary-closure.md`. |
| `initialWork → VerificationMission` | **P6/P1/P8 formation-to-Work lifecycle gap.** P6 omits the mission; P1 requires it; P8 invalidates the placeholder for verification; no lifecycle rule supplies the missing mission. | `DESIGN_GAP`; do not synthesize criteria or assume later refinement. See `42-initial-work-verification-mission-decision.md`. |

The Architecture can be superseded while these data/command/Domain issues remain
separately visible. The G-V2-3 review narrows the candidate boundary to
model-authored summary content → Runtime-created content reference; its
unresolved P8 association still prevents durable semantic preservation. Actions
that depend on an unresolved source cannot be implemented by adding defaults
to the internal ADT.

## Clean-HEAD findings under the new architecture

Baseline is `master@063d40d236ef73aa2f007d057f9f6d045512fc21`. The workspace is
dirty; current uncommitted code is not production baseline evidence.

| Clean-HEAD finding | New classification | Required future interpretation |
|---|---|---|
| `compileTurn` only compiles definitions supplied by `ModelContextPlan.tools`; it does not inject `arbor_directive`. | **Control-tool exposure integration gap.** | Supply concrete control-tool definitions from the control registry through Model Context. Do not restore a universal `arbor_directive` schema. |
| `Communicate` handler returns a Runtime Observation instead of taking the frozen P6 `SendMessage` durable path. | **P6 control-handler routing gap.** | Route a typed SendMessage action through the control registry to existing Application command semantics. Do not patch the old directive handler in this review. |
| P8 `RecordVerificationEvidence` / `ConcludeVerification` commands exist, but clean HEAD has no model-facing verifier action or registered handler. | **P8 control-tool exposure/handler gap**, plus the independent observation-source and summary-association design gaps above. | Keep P8 authority and persistence rules; do not add a v2 branch or invent references here. |

The dirty working-tree `compiler.ts` change that injects `arbor_directive` is
not included in the clean-HEAD findings and is inconsistent with the proposed
target. This review leaves it untouched.

## Governance result

```ini
architecture_direction = REDUCE_TO_INTERNAL_AGENT_ACTION_ADT
AgentDirective_v1_as_universal_output_contract = SUPERSEDED
AgentDirective_v2_schema_design = STOPPED
internal_AgentAction_ADT = RETAINED
frozen_DID_edit = NOT_PERFORMED
implementation = NOT_AUTHORIZED
S01 = REDEFINE_AFTER_DESIGN_BOUNDARY
Wave_2 = NOT_STARTED
```

The package-level map, internal action scope, tool routes, audit adequacy, and
dependency sequence are expanded in `49–52`.
