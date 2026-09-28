# Canonical AgentDirective Contract Reconciliation

**Date:** 2026-09-27  
**Status:** Design/governance reconciliation; implementation not authorized  
**Related:** [15-canonical-directive-payload-semantic-closure.md](./15-canonical-directive-payload-semantic-closure.md)

## Decision summary

The current `agent-directive-v1` implementation does not faithfully express all
downstream directive semantics. The five identified branches have these
reconciliation results:

| Branch | Reconciliation |
|---|---|
| `DeclareDependency` | The model intent is a dependency target and expected deliverable contract. Consumer Work and optimistic revision are bound to the Work execution and its control basis. The current `unknown`/`{}` payload drops the model-selected dependency semantics. |
| `RequestGovernance` | The model intent selects a governance request kind and, for `DecisionRequest`, supplies the question. Proposal identity/revision, issuer, recipient, correlation, and authority are bound from an exact proposal/message/execution relationship; no IDs or revisions may be guessed. The current `unknown`/`{}` payload loses the request variant and question. |
| `SpawnSpecialist` | The model intent is `mission`, `constraints`, and requested `skillIds`. Runtime supplies the specialist execution/session/parent binding and generated identities. The current `unknown`/`{}` payload loses the mission. |
| `ProposeChildWorkspace` | The model intent is the frozen proposal draft: name, responsibility/resource drafts, rationale, and optional initial Work/depth hint. Runtime determines parent, proposal identity, route, authority, and command identities. The current `unknown`/`{}` payload loses the proposal. |
| `Communicate` | The model selects communication intent and content; Runtime binds durable identity, authorization, and eligible routing facts. P6 does not freeze the content-to-`bodyRef` write transformation or a general reply-target selection rule, so an exact canonical payload cannot yet be closed. |

The P6 and P7 command payloads are not to be copied wholesale into
`AgentDirective`. The directive expresses the Agent's semantic decision;
Application constructs the command envelope and adds only fields whose
Runtime ownership is established by frozen contracts.

## Source authority and evidence

- P3 `03` defines the ten-branch `AgentDirective` vocabulary and the
  `decodeTurn → directive → owning boundary` path
  (`docs/design/implementation/P3/03-agent-loop-driver.md`, §§2–4).
- P3 `02` makes execution, Work/mission, policy, capability, and current
  binding inputs to deterministic `prepareTurn`; the manifest carries
  `workId?/workRevision?` in its ControlBasis
  (`docs/design/implementation/P3/02-model-context-contracts.md`, §§1–2, 6).
- P6 `01` is `FROZEN`; it owns child formation, specialist mission payload,
  first-layer human gate, and the distinction between a durable Workspace and
  an ExecutionBound specialist.
- P6 `02` is `FROZEN`; it owns the four cognitive Message kinds, durable
  `OutboundMessage` and `SendMessage`, correlation/causation, and governance
  routing.
- P7 `01` and `02` identify frozen v1.10 governance inputs, but those phase
  documents label their implementation text `DRAFT`. Their directive/domain
  signatures are used here as the current downstream shape; any unresolved
  disagreement with DID must be adjudicated before declaring full closure.
- The decoder's current `AgentDirective` uses `unknown` for four branches and
  `message.text` for `Communicate`
  (`packages/model-context/src/decode.ts:9-43`); the schema repeats four
  unconstrained `{}` payload schemas (`:153-168`).

## Canonical intent and command boundary

The canonical reconciliation target is:

```text
model-selected intent
  → canonical AgentDirective
  → deterministic Application transformation
  → CommandGateway / owning Runtime boundary
  → command/event and observation or settlement
```

The command may add authenticated principal, actor, project/workspace/session/
execution identity, revisions, generated IDs, idempotency data, provenance,
and authority facts only where the frozen contract assigns those values to
Application or Runtime. A command's existence does not make every command
field an Agent decision.

The field-owner labels used in the mapping are:

- `MODEL_DECISION`: a choice or content required from the Agent's reasoning.
- `RUNTIME_BINDING`: a unique authoritative fact already fixed by the admitted
  execution, current canonical state, authenticated context, or a durable
  correlation.
- `REPRESENTATION_IDENTITY`: branch identity only; it cannot supply business
  meaning.
- `NOT_REQUIRED_AT_DIRECTIVE_LAYER`: a frozen deterministic transformation
  supplies the field, or the downstream operation does not consume it.
- `DESIGN_GAP`: frozen sources do not define a unique, lossless ownership or
  transformation rule.

## Branch reconciliations

### `DeclareDependency`

P7's directive-level `DeclareDependencySpec` names
`consumerWorkId`, `producerBinding`, and `expectedDeliverable`
(`docs/design/implementation/P7/01-dependency-deliverable-commands.md:297-302`;
`packages/domain/src/dependency.ts:298-302`). The command additionally needs a
new `dependencyId`, the observed consumer Work revision, and initial
dependency revision 0 (`P7/01`, §2). The `DependencyDeclared` event records
the dependency and its semantic contract; declaring a dependency does not
implicitly yield or register a WorkWait.

Ownership:

- `producerBinding` and `expectedDeliverable`: `MODEL_DECISION`.
- `consumerWorkId`: `RUNTIME_BINDING` only when the execution is Work-bound
  and its current Work is the dependency consumer; otherwise the directive
  must explicitly identify the consumer Work and Runtime must verify it is
  within the executing Workspace's authority. No unrelated Work may be
  substituted.
- `expectedConsumerWorkRevision`: `RUNTIME_BINDING` from the exact Work
  snapshot/control basis on which the directive was decided, then checked by
  the handler. A newer revision causes a stale/revision rejection and
  re-preparation.
- `dependencyId`, initial dependency revision 0, command/idempotency fields:
  `NOT_REQUIRED_AT_DIRECTIVE_LAYER`; P7/domain allocation and command
  construction own them.
- “Why”/rationale: `NOT_REQUIRED_AT_DIRECTIVE_LAYER`. The frozen P7
  directive-level spec and `DependencyDeclared` semantics contain no
  rationale field; adding one would invent semantics.

Required canonical semantics must preserve the exact producer-binding
alternative (`AnyProducer`, `WorkspaceBound`, or `WorkBound`) and the expected
deliverable kind plus required artifact roles. The current `{}` cannot do so.

### `RequestGovernance`

P6 freezes two request variants (`packages/domain/src/formation.ts:167-179`;
`docs/design/implementation/P6/02-communication-protocol.md:116-129`):

- `FormationApproval` refers to one exact pending proposal revision.
- `DecisionRequest` carries a non-empty question and may carry a correlation.

Ownership:

- request variant: `MODEL_DECISION` when the Agent explicitly emits this
  directive. The first-layer formation gate itself is selected
  deterministically from Workspace depth by P6 `01` §4; the model cannot
  bypass or choose that gate.
- `DecisionRequest.question`: `MODEL_DECISION`.
- `FormationApproval.proposalId` and exact revision: `RUNTIME_BINDING` when
  the directive is tied to the proposal just admitted by
  `ProposeChildWorkspace`; P6 fixes the new proposal's initial revision as 1.
  If there is no unique current proposal binding, an explicit target must be
  selected from known proposals and checked exactly; Runtime must not guess.
- DecisionRequest destination (parent Workspace), sender, issuer, project,
  principal, execution, message ID, and authority fact: `RUNTIME_BINDING`
  according to P6 routing and the current execution.
- correlation: `RUNTIME_BINDING`; P6 says Communication Runtime allocates or
  validates correlation/causation and does not let the model self-assert it.

The transformation is either an exact proposal-to-governance inbox admission
or a parent-directed `DecisionRequest` Message. Neither request itself makes
the governance decision; `RecordDecision` remains the human decision boundary.

### `SpawnSpecialist`

P6 `01` §3 and `packages/domain/src/formation.ts:29-35` freeze three
Agent-level semantic inputs:

- `mission`: `MODEL_DECISION`;
- `constraints`: `MODEL_DECISION`;
- requested `skillIds`: `MODEL_DECISION`; Runtime/SkillRegistry validates
  availability and loading.

The current Workspace, parent Execution, project, authenticated principal,
authority, specialist `executionId`, `sessionId`, and command identity are
`RUNTIME_BINDING` or generated by the P2/P6 admission path. They must not be
copied into the Agent's semantic choice set. Runtime enforces quiescence and
safety admission. The deterministic transformation is
`SpecialistSpec → AdmitExecution(ExecutionBound)`; settlement returns through
the P6 Inbox observation path.

### `ProposeChildWorkspace`

P6 `01` §2 and `packages/domain/src/formation.ts:13-26` freeze the proposal
intent:

- name, responsibility draft, resource-boundary draft, rationale, optional
  initial Work objective/why/constraints/completion expectation, and optional
  informational depth hint: `MODEL_DECISION`.
- parent Workspace, Project, actor/principal, proposal ID, child Workspace/
  Session IDs, command IDs, and proposal revision: `RUNTIME_BINDING` or
  deterministic Application generation.
- whether the child is on the first layer, whether human approval is
  mandatory, and whether the proposal becomes a direct create path:
  `NOT_REQUIRED_AT_DIRECTIVE_LAYER`; P6 determines this from the canonical
  Workspace tree depth. `formationDepthHint` is explicitly informational and
  cannot override the Runtime result.
- resource-boundary validity and ceiling: Runtime validation, not Agent
  authority.

Transformation preserves the model's complete frozen proposal draft into a
`FormationProposal` or `CreateChildWorkspace` path. If `initialWork` exists,
P6 routes its frozen fields into `AssignWork`; P6 explicitly excludes
`verificationMission` and uses the P1 minimal placeholder until P8 owns that
semantics. The AgentDirective must not contain the full Create/Assign command
DTO.

### `Communicate`

P6 `02` §§1–5 freezes four Message meanings and a durable record:
`kind`, `recipientWorkspaceId`, `bodyRef`, optional correlation/causation,
and fixed `urgency: "Normal"`. P7 `02` adds `Deliver` as a fifth Message kind
and defines a `DeliverDirectiveSpec`; it must not be silently conflated with
ordinary cognitive communication.

Ownership review:

| Semantic | Owner | Frozen basis / unresolved point |
|---|---|---|
| `kind` (`Query`, `Reply`, `Report`, `DecisionRequest`) | `MODEL_DECISION` | These kinds have distinct cognitive intent in P6 §1. Runtime must validate the permitted direction and channel. |
| Query recipient | `MODEL_DECISION` | The model chooses among the P6-authorized query targets; Runtime checks same-Project and the frozen query set. |
| Report / DecisionRequest recipient | `RUNTIME_BINDING` | P6 defines child-to-parent semantics, and the executing Workspace has a unique direct parent. |
| Reply recipient / target query | `RUNTIME_BINDING` only if an exact active Query correlation is uniquely bound | P6 requires Query/Reply correlation and says Runtime allocates/validates IDs, but does not specify how an Agent chooses among multiple open Queries. Non-unique reply target is a `DESIGN_GAP`. |
| Authored body/content | `MODEL_DECISION` | Message content is cognitive communication, not authority or metadata. The current `text` field does not by itself define durable-body semantics. |
| Durable `bodyRef` | `DESIGN_GAP` | P6 says body is stored as Artifact/Blob and the message carries a ContentRef, but does not freeze the `Communicate` transformation that persists model-authored content and returns the reference. A model cannot invent an opaque durable reference. |
| Query correlation allocation; Reply correlation validation/closure | `RUNTIME_BINDING` | P6 §2/§4 assigns allocation and validation to Communication Runtime. A Reply must bind the exact Query it answers. |
| causation | `RUNTIME_BINDING` when a causal event/message is present; otherwise absent | P6 assigns allocation/validation to Runtime. |
| urgency | `NOT_REQUIRED_AT_DIRECTIVE_LAYER` | P6 freezes the only value as `"Normal"`. |
| sender, project, execution, principal, message/command IDs, authority | `RUNTIME_BINDING` / generated | P6 SendMessage payload and authority rules. |

The model-intent and durable-message boundary can therefore be stated only
partially from current frozen sources:

```text
Agent chooses kind + content + any non-unique semantic destination/target
  → Runtime checks the kind-specific relation and authority
  → Runtime persists content and binds durable bodyRef
  → SendMessage(bodyRef, destination, correlation/causation, Normal)
```

The first line's kind-specific recipient rule is frozen, but the persistence
operation in the third line is not. The Reply rule is also incomplete for
multiple outstanding correlations. `message.text` is not a lossless
substitute for `OutboundMessage`; it may represent authored content but does
not represent kind, destination, durable reference, or exact reply relation.

`Deliver` is separately specified by P7 as a handover that names an existing
`deliverableId`, uses a bounded summary, and derives the direct-parent
recipient. It is not fully representable by the current `Communicate` payload
or by P6's four-kind subset.

## Additional vocabulary drift beyond the ten current tags

The ten-tag inventory is the current `agent-directive-v1` decoder allowlist.
P7's directive vocabulary references `ProduceDeliverable` and
`SatisfyDependency` (P7 `01`, §9) and defines a `Deliver` directive spec (P7
`02`, §8). These are not among the current ten tags in
`packages/model-context/src/decode.ts:55-70`. P7's implementation documents
are marked DRAFT, so this is recorded as a vocabulary reconciliation item
against frozen v1.10 governance inputs, not silently folded into one of the
ten branches.

The current contract therefore has both payload drift and a potential
directive-vocabulary omission. These must be resolved at the canonical
contract boundary before any model-facing work begins.

## Reconciliation disposition

The five branch differences are semantic contract drift, not provider
representation or Runtime binding issues. Runtime-bound fields are identified
only where P2/P3/P6/P7 sources establish a unique binding. All other fields
remain model decisions or explicit design gaps; there is no defaulting class.

`Communicate` content persistence and non-unique Reply targeting remain open
Design/Governance questions. The full ten-branch contract is not yet closed.
