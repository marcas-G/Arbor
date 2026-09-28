# Tool Surface Governance & Design Closure

**Date:** 2026-09-27

This record closes the governance questions raised by the Tool Surface Audit. It is a design decision record only. It does not modify production code, Prompt text, `agent-directive-v1`, Runtime implementation, or tests.

## G-T1 — Directive representation compiler

### Frozen boundary

```text
Canonical AgentDirective
  → Model-family Compiler
  → model-facing directive tools
  → Representation Decoder
  → Canonical AgentDirective
  → existing canonical validator
  → AgentRuntime / CommandGateway / ToolRuntime
```

The canonical contract remains `agent-directive-v1`. A model-facing representation is an adaptation selected for a model capability profile; it is not a second semantic contract.

### Ownership

- **Model-family Compiler:** owned by the Model Context control plane, adjacent to `compileTurn` (`packages/model-context/src/compiler.ts`). It owns conversion from the canonical output-contract schema to provider-facing directive tool definitions.
- **Representation Decoder:** owned by Model Context, adjacent to `decodeTurn` (`packages/model-context/src/decode.ts`). Provider adapters continue to normalize wire events into `CanonicalProviderEvent`; they do not decide Arbor directive semantics.
- **Provider adapter:** transport/protocol normalization only. It must preserve tool name, call reference, and accumulated arguments; it must not map a provider tool name to an Arbor directive branch.
- **Runtime:** consumes only canonical `AgentDirective` values after representation decoding and canonical validation.

This follows the existing architecture statement that Model Context performs semantic compilation while ProviderRuntime performs transport and protocol normalization (`docs/design/03-detailed-implementation-design.md:8.2, 7.5`).

### Representation identity

Every representation profile has three stable identities:

```text
representationProfileId
representationProfileRevision
representationProfileHash
```

A profile is selected by the resolved model/provider capability profile, not by the string `"/v1/chat/completions"` alone. The profile records the canonical output-contract reference/hash it compiles.

The current Qwen profile may use multiple shallow, single-purpose directive tools because L1/L2/L5/MT replication established that this representation works for the tested model/build. That is a profile decision, not a universal representation rule.

### Namespace and routing

- **Executable tools:** ordinary catalog names (`read`, `patch`, `shell`, `list`, or a ready project tool). They are resolved through `ToolCatalogPort` and, after decoding, routed to `ToolRuntimePort.invoke`.
- **Directive representation tools:** reserved names beginning with `arbor_directive__`. The suffix identifies one canonical branch or an explicitly versioned branch profile. They are never inserted into `ToolCatalogPort`, never passed to `ToolRuntimePort`, and are routed only to the Representation Decoder.
- **Legacy monolithic `arbor_directive`:** remains a compatibility representation for profiles that support the canonical union. It is a directive representation, never an executable capability.

The name prefix is a routing discriminator, not authority. Authority and control-basis checks remain unchanged after canonical decoding.

### Required invariants

1. One model-facing directive tool maps to at most one canonical branch.
2. Every branch admitted by the selected output contract has a representation.
3. Reverse mapping is deterministic and lossless; no semantic field is guessed or defaulted.
4. The decoded value passes the existing `agent-directive-v1` validator.
5. Representation adaptation cannot change authority, execution purpose, or canonical meaning.
6. Directive representation tools cannot enter the executable ToolRuntime path.
7. The manifest can reconstruct the canonical contract and actual representation seen by the model.

## G-T2 — Directive payload ownership

The complete field decision is in [12-directive-field-ownership-matrix.md](./12-directive-field-ownership-matrix.md). The governing rule is:

> The model chooses semantic intent and content. Runtime supplies facts it uniquely knows from the admitted execution, authenticated principal, control basis, resource boundary, and current state. A representation identity may supply a discriminant such as `_tag`, but it may not supply missing business meaning.

## G-T3 — Tool exposure policy

The responsibility model is frozen as:

```text
Execution Purpose
  + Authority
  + Resource Boundary
  + Capability Profile
  → Model-visible Tool Surface
```

Visibility and authorization are separate:

- **Visibility** prevents irrelevant or unsafe affordances from entering the model's choice set.
- **Authorization** remains the Runtime boundary: definition lookup, input validation, resource resolution, authority, approval, admission, sandbox, executor, and settlement.

The minimum exposure contract for current purposes is in [13-execution-tool-exposure-contract.md](./13-execution-tool-exposure-contract.md). Query remains DEFERRED under `FCR-G2-DG-01`.

## G-T4 — Project tool lifecycle

A project tool is an executable capability unless explicitly classified as a non-executable representation artifact. Therefore:

```text
MODEL_VISIBLE(tool)
  ⇒ READY_INVOCATION_PATH(tool, execution)
```

`READY_INVOCATION_PATH` requires:

- the same `(name, version, hash)` definition is present in the runtime definition store;
- an executor is registered for the exact definition identity;
- capability metadata, side-effect semantics, input validation, authority, admission, approval, sandbox, and settlement paths are available;
- project and execution scope are compatible;
- provenance is durable and inspectable.

Project Tool Registry owns committed definition/provenance. Tool Runtime and the Composition Root own executor registration and invocation binding. Model Context may expose only definitions whose readiness predicate is true. If no executor or definition-store binding exists, the tool must be removed from the model-visible surface; it must not be exposed and allowed to fail as `unknown tool`.

No executor is implemented by this closure.

## G-T5 — Tool observation contract

The Shell result mismatch is classified as **IMPLEMENTATION_GAP**, not a new semantic design gap. The existing ToolDefinition contract already distinguishes input schema and result schema (`packages/tool-runtime/src/catalog.ts:50-72`), while `shellExecutor` does not populate the advertised references.

The following traceability principle is adopted:

```text
Tool input schema
+ execution semantics
+ tool observation/result schema
```

must each be versioned or deterministically traceable to the same tool definition identity. The model manifest must eventually identify the concrete definition/profile hashes; this closure does not change the current `ToolDefinition` type.

## Model-facing Tool Definition Principles

The following principles are accepted as governance constraints for future implementation:

- **P1 Single purpose:** one model-facing tool represents one clear affordance.
- **P2 Action choice in identity:** mutually exclusive actions should use separate tool identities rather than a universal action with a large tagged union.
- **P3 Shallow and explicit:** prefer flat schemas, explicit required fields, few optional fields, and minimal `oneOf`/`anyOf` complexity.
- **P4 Runtime bindings are not model decisions:** execution identity, principal, authority, workspace/session binding, and current revisions are not redundant model inputs.
- **P5 Representation is not canonical semantics:** a profile may change names and shape without changing canonical meaning.
- **P6 Runtime remains authority boundary:** visibility guides model choice; security and authority are mechanically enforced.
- **P7 Observable and versioned:** the manifest must reconstruct visible tools, representation profile, schema hashes, and executable/directive classification.

## S01 reauthorization decision

| Gate | Status | Reason |
|---|---|---|
| Compiler/decoder ownership | **FROZEN** | Model Context owns semantic compilation and representation decoding. |
| All ten branches losslessly representable | **NOT CLOSED** | Four payloads remain `{}` and therefore do not define the semantic fields to represent. |
| Canonical field ownership unambiguous | **NOT CLOSED** | Completion revision, wait-condition observations, governance/dependency payloads, and child/specialist payload fields still need semantic ownership decisions. |
| Directive/executable routing mechanically distinct | **FROZEN DESIGN** | Reserved directive namespace and separate decoder/ToolRuntime routing. |
| Generic Work exposure | **FROZEN MINIMUM** | Builtins are explicit; mutation tools require capability profile and runtime authority; directive branch details remain contract-bounded. |
| Project-tool mismatch impact | **BLOCKS UNCONDITIONAL PRODUCTION EXPOSURE** | S01 may not expose a project tool lacking a ready invocation path. |

**S01 remains `NOT AUTHORIZED`.** The remaining blockers are semantic payload ownership/shape and the project-tool readiness invariant. No S01 implementation or Wave 2 work starts from this record.

## Design-gap disposition

- Existing accepted gap: `MODEL_FACING_DIRECTIVE_REPRESENTATION_GAP`.
- Remaining governance/design gap: canonical payload schemas and field ownership for the under-specified branches.
- Existing deferred gap: `FCR-G2-DG-01` Query read-only capability boundary.
- Implementation gaps, deliberately not fixed here: representation compiler/decoder, project executor binding/filtering, shell observation fidelity, and manifest enrichment.
