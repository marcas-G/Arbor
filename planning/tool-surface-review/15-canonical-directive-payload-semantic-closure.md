# Canonical Directive Payload Semantic Closure

**Date:** 2026-09-27  
**Status:** `STOPPED — NOT_REPRESENTABLE`  
**Scope:** semantic and governance review only

This record reviews the ten branches admitted by the current
`agent-directive-v1` output contract and defines the ownership boundary for a
future model-facing representation. It does not modify production code,
Prompt text, the frozen Output Contract, Runtime behavior, or tests.

The repository already had unrelated uncommitted implementation changes when
this review started. This record is the only file added for this closure.

## 1. Current ten-branch inventory

The current implementation is in
`packages/model-context/src/decode.ts:9-43` and
`packages/model-context/src/decode.ts:131-215`.

| Canonical tag | Current TypeScript payload | Current schema payload | Owning semantic source | Result |
|---|---|---|---|---|
| `InvokeTool` | `intent.callRef`, `toolName`, `argumentsJson` | typed nested object | `P3/03`; `packages/ports/src/tool.ts` | representable |
| `Communicate` | `message.text` only | `message: { text }` | `P3/03`; frozen `P6/02` `OutboundMessage` | **`NOT_REPRESENTABLE`** |
| `DeclareDependency` | `spec: unknown` | `{}` placeholder | `P7/01` §2; `packages/domain/src/dependency.ts:298-302` | `CANONICAL_PAYLOAD_GAP` |
| `RequestGovernance` | `request: unknown` | `{}` placeholder | `P6/02` §6; `packages/domain/src/formation.ts:169-179` | `CANONICAL_PAYLOAD_GAP` |
| `SpawnSpecialist` | `spec: unknown` | `{}` placeholder | `P6/01` §3; `packages/domain/src/formation.ts:31-35` | `CANONICAL_PAYLOAD_GAP` |
| `ProposeChildWorkspace` | `spec: unknown` | `{}` placeholder | `P6/01` §2; `packages/domain/src/formation.ts:13-26` | `CANONICAL_PAYLOAD_GAP` |
| `LoadSkill` | `skillId`, `tier` | typed `skillId` + `Summary/Body` | `P3` progressive skill loading | representable |
| `ChangeMode` | `mode: string` | typed string | `P3` execution state | representable subject to capability validation |
| `CompletionClaim` | `claimRef`, `workRevision` | typed nested object | `P3/03`; `P8/03` settlement chain | representable for a uniquely bound current Work |
| `Yield` | `reason`, `waitSpec` | typed wait-condition union | DID §8.16; `packages/domain/src/scheduler.ts:18-65` | representable |

The four `{}` entries are not semantically parameterless. In the current
decoder they are unconstrained placeholders (`spec: unknown` or
`request: unknown`); the frozen owning documents define the missing semantic
fields. They therefore cannot be treated as an empty model-facing object.

## 2. The four current `{}` payloads

### `DeclareDependency`

This branch is **not** `SEMANTICALLY_PARAMETERLESS`. P7 freezes a dependency
request with:

- `consumerWorkId`;
- `producerBinding`;
- `expectedDeliverable`.

The command-level payload also contains runtime/caller facts such as
`dependencyId`, the consumer Work revision, and the initial dependency
revision (`docs/design/implementation/P7/01-dependency-deliverable-commands.md:23-34`).
The directive-level type in `packages/domain/src/dependency.ts:298-302` contains
the three semantic fields only. The current execution focus can bind
`consumerWorkId` when the directive is admitted from a uniquely focused Work;
the producer target and expected deliverable remain model decisions. IDs and
revisions are runtime command facts.

Classification: **`CANONICAL_PAYLOAD_GAP`**, not parameterless.

### `RequestGovernance`

This branch is **not** `SEMANTICALLY_PARAMETERLESS`. P6 freezes two request
forms:

- `FormationApproval`: exact `proposalId` and `proposalRevision`;
- `DecisionRequest`: model-authored `question`, with optional correlation.

The source is `docs/design/implementation/P6/02-communication-protocol.md:116-129`
and `packages/domain/src/formation.ts:167-179`. Issuer, principal, project,
current execution, and routing authority are runtime-bound. A proposal
revision must be exact; the model may not invent or guess a revision. A
formation proposal may be runtime-bound only when the current execution has a
unique proposal binding. Without that binding, an explicit existing proposal
target is required.

Classification: **`CANONICAL_PAYLOAD_GAP`**, not parameterless.

### `SpawnSpecialist`

This branch is **not** `SEMANTICALLY_PARAMETERLESS`. P6 freezes:

- `mission`;
- `constraints`;
- `skillIds`.

The source is `docs/design/implementation/P6/01-formation-semantics.md:39-51`
and `packages/domain/src/formation.ts:29-35`. `executionId`, `sessionId`,
`parentExecutionId`, command IDs, project, workspace, and principal are
runtime-bound by the admission path.

Classification: **`CANONICAL_PAYLOAD_GAP`**, not parameterless.

### `ProposeChildWorkspace`

This branch is **not** `SEMANTICALLY_PARAMETERLESS`. P6 freezes:

- `name`;
- `responsibilityDraft`;
- `resourceBoundaryDraft`;
- `rationale`;
- optional `initialWork`;
- optional informational `formationDepthHint`.

The source is `docs/design/implementation/P6/01-formation-semantics.md:18-37`
and `packages/domain/src/formation.ts:11-26`. Proposal ID, parent workspace,
child workspace/session/work IDs, command IDs, project, principal, and
formation path are runtime-bound or deterministically derived. The resource
ceiling is runtime-validated and cannot be self-authorized by the model.

Classification: **`CANONICAL_PAYLOAD_GAP`**, not parameterless.

## 3. The blocking branch: `Communicate`

The current canonical branch is:

```ts
{ _tag: "Communicate"; message: { text: string } }
```

(`packages/model-context/src/decode.ts:18-21`, schema at lines 146-151).

The frozen P6 semantic value is instead `OutboundMessage`:

```ts
{
  kind,
  recipientWorkspaceId,
  bodyRef,
  correlationId?,
  causationId?,
  urgency: "Normal"
}
```

(`docs/design/implementation/P6/02-communication-protocol.md:22-36`).
The current domain type also includes the later P7 `Deliver` kind
(`packages/domain/src/communication.ts:5-14`), while the P6 frozen message
subset names `Query`, `Reply`, `Report`, and `DecisionRequest`.

There is no frozen, deterministic rule that maps:

- `message.text` to a durable `bodyRef`;
- missing `kind` to one of the allowed message kinds;
- missing `recipientWorkspaceId` to a unique recipient;
- missing correlation/causation semantics to runtime facts.

The current directive handler only journals `directive.message.text`
(`apps/single-workspace/src/directives.ts:383-390`), while the P6 frozen
execution path requires `Communicate(OutboundMessage)` to become a durable
`SendMessage` command (`docs/design/implementation/P6/02-communication-protocol.md:98-114`).
Choosing a kind, recipient, or body reference would add semantic information
that is absent from the canonical branch; converting text to a body reference
would be an invented protocol rule.

Result: **`Communicate` is `NOT_REPRESENTABLE` under the current canonical
branch.**

This satisfies the requested stop condition. No representation implementation
or semantic repair is authorized by this review.

## 4. Final ownership matrix

The permitted ownership classes are:

- `REPRESENTATION_IDENTITY`: supplied by a concrete model-facing tool identity;
- `MODEL_SUPPLIED`: semantic intent or content selected by the model;
- `RUNTIME_BOUND`: uniquely known from the admitted execution, current state,
  authenticated principal, or authoritative store;
- `DESIGN_UNRESOLVED`: no lossless rule is currently frozen.

| Branch | Canonical semantic field | Ownership | Notes |
|---|---|---|---|
| `InvokeTool` | `_tag` | `REPRESENTATION_IDENTITY` | Concrete directive tool identity determines the branch. |
|  | `toolName`, `argumentsJson` | `MODEL_SUPPLIED` | Tool choice and exact arguments are model intent; Tool Runtime validates them. |
|  | `callRef` | `RUNTIME_BOUND` | Provider tool-call correlation, preserved from `CanonicalProviderEvent` or deterministically bound by Runtime. |
| `Communicate` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity is deterministic. |
|  | `kind`, `recipientWorkspaceId`, `bodyRef`, message content | `DESIGN_UNRESOLVED` | Current canonical `text` cannot losslessly supply frozen P6 message semantics. |
|  | sender, project, principal, execution, authority | `RUNTIME_BOUND` | These are command and authority facts, but do not fill the missing message semantics. |
| `DeclareDependency` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `producerBinding`, `expectedDeliverable` | `MODEL_SUPPLIED` | Semantic dependency target and structural expectation. |
|  | current `consumerWorkId` | `RUNTIME_BOUND` | Bind only when the execution focus uniquely identifies the consumer Work. |
|  | dependency ID and revisions | `RUNTIME_BOUND` | Caller allocation, current Work revision, and dependency revision. |
| `RequestGovernance` | `_tag` | `REPRESENTATION_IDENTITY` | Split representation may use separate formation/decision tool identities. |
|  | decision question | `MODEL_SUPPLIED` | Required for `DecisionRequest`. |
|  | exact proposal target/revision | `MODEL_SUPPLIED` or `RUNTIME_BOUND` only with an existing unique proposal binding | No guessed ID/revision is allowed; absent a unique binding the representation is not admissible. |
|  | issuer, principal, routing, project, execution | `RUNTIME_BOUND` | Authority and route are not model choices. |
| `SpawnSpecialist` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `mission`, `constraints`, `skillIds` | `MODEL_SUPPLIED` | Frozen specialist semantics. |
|  | execution/session/parent IDs, project, workspace, principal | `RUNTIME_BOUND` | Admission and authority facts. |
| `ProposeChildWorkspace` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | name, responsibility draft, resource draft, rationale, initial work, depth hint | `MODEL_SUPPLIED` | Proposal semantics; resource ceiling remains runtime-validated. |
|  | proposal and command IDs, parent/child bindings, project, principal | `RUNTIME_BOUND` | Allocated or derived by formation Runtime. |
| `LoadSkill` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `skillId`, `tier` | `MODEL_SUPPLIED` | Registry and capability profile validate availability. |
|  | skill revision/content provenance | `RUNTIME_BOUND` | Registry source of truth. |
| `ChangeMode` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `mode` | `MODEL_SUPPLIED` | Runtime validates against the resolved capability/profile; arbitrary strings are not automatically valid. |
|  | execution identity/current state | `RUNTIME_BOUND` | State transition context. |
| `CompletionClaim` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `claimRef` | `MODEL_SUPPLIED` | Claim reference/content supplied by the model. |
|  | `workRevision` | `RUNTIME_BOUND` | Omit from a work-bound representation only when the current Work/revision is unique; restore and validate the exact canonical value. |
| `Yield` | `_tag` | `REPRESENTATION_IDENTITY` | Branch identity. |
|  | `reason`, condition kind, semantic target, requested time | `MODEL_SUPPLIED` | The model chooses why and what it is waiting for. |
|  | observed revision/sequence | `MODEL_SUPPLIED` then runtime-validated | It is an observation claim, not a default. |
|  | current workspace/execution binding and constant `mode: "Any"` | `RUNTIME_BOUND` | Omit only where the current binding uniquely supplies it; `Any` is a frozen canonical constant. |

The `RequestGovernance` proposal target row is deliberately conditional. It
does not authorize a representation that silently chooses a proposal or
revision.

## 5. Model-facing representation specs (design only)

These are the narrow representations that would be valid **if and only if**
the canonical payload gaps were closed and the turn's binding preconditions
were satisfied. They are not implemented.

| Canonical tag | Proposed model-facing tool | Model-visible fields | Runtime-bound fields | Representation identity | Reverse mapping |
|---|---|---|---|---|---|
| `InvokeTool` | `arbor_directive__invoke_tool` | `toolName`, validated tool arguments | `callRef`, current execution/authority | tool identity → `InvokeTool` | identity + tool name + exact arguments + provider callRef → canonical `InvokeTool` → existing validator |
| `Communicate` | `arbor_directive__communicate` | **No complete schema can be specified** | sender/authority facts only | identity → `Communicate` | **`NOT_REPRESENTABLE`: missing kind, recipient, and body reference cannot be recovered from `message.text`.** |
| `DeclareDependency` | `arbor_directive__declare_dependency` | `producerBinding`, `expectedDeliverable` | uniquely focused `consumerWorkId` where available | identity → `DeclareDependency` | identity + semantic fields + current Work binding → canonical `DeclareDependency` → P7 validator |
| `RequestGovernance` | `arbor_directive__request_formation_approval` / `arbor_directive__request_decision` | exact proposal target when not runtime-bound; or `question` | issuer, route, and any uniquely bound proposal/revision | identity → governance variant | identity + explicit semantic fields + validated bindings → canonical `RequestGovernance` |
| `SpawnSpecialist` | `arbor_directive__spawn_specialist` | `mission`, `constraints`, `skillIds` | execution/session/parent IDs and authority | identity → `SpawnSpecialist` | identity + fields + admission bindings → canonical `SpawnSpecialist` |
| `ProposeChildWorkspace` | `arbor_directive__propose_child_workspace` | name, responsibility draft, resource draft, rationale, optional initial work/depth hint | proposal/parent/project/principal IDs and formation path | identity → `ProposeChildWorkspace` | identity + proposal fields + runtime IDs → canonical `ProposeChildWorkspace` |
| `LoadSkill` | `arbor_directive__load_skill` | `skillId`, `tier` | registry revision/provenance | identity → `LoadSkill` | identity + fields → canonical `LoadSkill` |
| `ChangeMode` | `arbor_directive__change_mode` | capability-profile-valid `mode` | execution/current state | identity → `ChangeMode` | identity + mode → canonical `ChangeMode` |
| `CompletionClaim` | `arbor_directive__completion_claim` | `claimRef` | uniquely bound current Work revision | identity → `CompletionClaim` | identity + claimRef + exact bound revision → canonical `CompletionClaim` → existing validator |
| `Yield` | `arbor_directive__yield` | reason and explicit wait conditions/targets/observations | current binding and canonical `mode: "Any"` | identity → `Yield` | identity + supplied wait semantics + bound facts → canonical `Yield` → existing validator |

For a confirmed parameterless branch, the model-facing schema would be an
object with no properties and `additionalProperties: false`. None of the four
current `{}` branches meet that condition.

## 6. Closure decision

The canonical/model-facing boundary remains valid:

```text
canonical AgentDirective
  → model-family representation
  → deterministic representation decoder
  → canonical AgentDirective
  → existing canonical validator
```

However, semantic closure is **not complete**:

1. `DeclareDependency`, `RequestGovernance`, `SpawnSpecialist`, and
   `ProposeChildWorkspace` have typed frozen owning semantics but remain
   `unknown`/`{}` in the current canonical decoder surface.
2. `Communicate` cannot be reversibly represented because the current
   canonical branch contains only `text`, while frozen P6 requires message
   kind, recipient, body reference, and communication bindings.
3. The current handler journals only text and therefore does not establish a
   deterministic text-to-`OutboundMessage` conversion.

**Stop condition reached:** `Communicate = NOT_REPRESENTABLE`.

No canonical field is added, no default is selected, no body reference is
invented, no proposal/revision is guessed, and no production implementation is
started.

`S01` remains **`NOT AUTHORIZED`**. The next governance action must decide the
canonical `Communicate` payload boundary and promote the four placeholder
payloads to explicit semantic contract shapes before any representation
compiler/decoder implementation is authorized.
