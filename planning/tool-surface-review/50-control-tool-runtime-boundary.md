# Control Tool and Runtime Boundary

**Date:** 2026-09-27
**Status:** Architecture proposal; no registry or tool schema implemented

## Two tool classes

| Class | Examples | Semantic owner | Execution route |
|---|---|---|---|
| **Executable Tool** | `read`, `list`, `patch`, `shell`, registered project tools | P4 ToolDefinition / ToolRuntime contracts | Model call → generic tool invocation → validated `ToolIntent` + trusted context → `ToolRuntimePort.invoke` → bounded observation/settlement |
| **Control Tool** | future `claim_completion`, `send_message`, `declare_dependency`, `propose_child_workspace`, verifier and other governed actions | Agent Runtime ControlToolRegistry, then Application/Domain for effects | Model call → generic tool invocation → control codec → `AgentAction` → shared Agent Runtime policy → control handler → Application Command or Execution settlement |

Both classes may appear in the model request, but they have distinct executor
paths. A Control Tool must never be submitted to the ordinary executable
`ToolRuntime` merely because both are represented as provider tool calls.

`visibility != authorization` remains unchanged:

- Model Context decides which eligible definitions appear in a turn.
- The control registry's exposure rule is not authority.
- Runtime binds the authenticated execution context.
- ToolRuntime rechecks executable tool authorization and resource admission.
- Application `CommandGateway` / authority rules enforce control-command
  authority, idempotency, and state transition preconditions.

## Ownership of the ControlToolRegistry

**Recommended owner: `packages/agent-runtime`.** Evolve its existing
`DirectiveHandler` registration and driver dispatch rather than adding a
parallel semantic registry.

The authoritative registry entry needs these responsibilities:

```text
model-facing identity / profile aliases
→ input codec
→ internal AgentAction constructor
→ exposure eligibility
→ declared required capability / activity class
→ action freshness / policy metadata
→ typed control handler
```

The registry may expose a **data-only schema projection** for compilation.
`ModelContext` receives that projection as ordinary tool definition data and
does not import Agent Runtime types or know the action semantics.

The current `ToolCatalogPort` / `ToolDefinitionStore` remain the source for
P4 executable tools. Do not store control handlers in `ToolDefinitionStore`,
and do not route a control action through `ToolRuntime`. The application
composition root joins:

1. visible executable definitions resolved through `ToolCatalogPort`; and
2. control definitions projected from the Agent Runtime registry for the
   current turn.

The current `PrepareTurnInput`/ModelContext tool-assembly seam can accept the
second collection as data; this keeps the allowed dependency direction
`agent-runtime → model-context` and avoids `model-context → agent-runtime`.
This is a module-boundary proposal, not an API/schema specification.

Model-specific names or flattened schemas are representation aliases. The
registry codec deterministically maps them to the same internal action and
must preserve all required semantic information. It may not fill missing
business intent.

## `decodeTurn` after supersession

`decodeTurn` is still useful, but its responsibility narrows:

- collect text, finish reason, and normalized provider events;
- produce or preserve generic `ToolInvocation { callRef, toolName,
  argumentsJson }` values;
- reject malformed provider event framing / incomplete tool-call assembly;
- preserve turn/manifest correlation.

It no longer parses `arbor_directive`, consults a list of action tags, casts a
JSON object into a universal action union, or performs semantic control-tool
construction. Those tasks move to:

1. the provider adapter for provider-wire framing and call reconstruction;
2. the Agent Runtime ControlToolRegistry for control schema decoding and
   `AgentAction` construction;
3. ToolRuntime/P4 validation for executable invocations.

`PortableModelRequest.outputContractRef` may remain for independent structured
outputs such as compaction or bounded response protocols. It must not be used
as a universal list of all control actions.

## Shared control middleware

The Agent Runtime should route each valid internal action through one common
pipeline:

```text
validated AgentAction
  → bind current execution/control basis
  → safety/activity admission
  → freshness requirement for this action
  → policy/authority resolver as required
  → exactly one typed handler
  → CommandGateway / settlement
  → normalized Observation or settlement
```

This registry and middleware are the reason to retain an internal ADT. The
Action carries semantic identity; the registry carries executable policy
metadata; the authenticated context carries trusted facts. These roles must
not collapse into one object.

Executable tool calls share appropriate Runtime admission/audit correlation
but skip the control ADT and control-command handler:

```text
generic ToolInvocation
  → executable registry/catalog match
  → ToolIntent + ToolExecutionContext
  → ToolRuntimePort
  → CanonicalToolObservation
```

An invocation matching neither class fails closed as an unknown/unregistered
tool. If a name matches both classes, composition validation fails before a
ProviderTurn is exposed.

## Audit adequacy

The requested audit trail is **not present in full** in the clean-HEAD
Session/Manifest/CommandReceipt path.

| Audit datum | Present today? | Evidence / limitation |
|---|---|---|
| `providerTurnId` | **Partly yes** | ProviderTurn and ModelOutput metadata persist it. |
| `toolCallId` | **No durable call-level record found** | `CanonicalProviderEvent.ToolCallProposed.callRef` exists in process, but the ModelOutput session entry does not persist it. |
| Model-facing tool identity and definition version/hash | **Only exposed catalog refs, not selected call** | ModelContext manifest has the `toolRefs` set; it does not record which specific tool was invoked. |
| Decoded semantic arguments | **No** | Session stores only directive kinds; provider raw call arguments are not stored as a call audit record. |
| Runtime bindings | **Partly, not linked to call** | Manifest contains execution/session/control basis; principal and per-call runtime bindings are not linked to a tool call record. |
| Resulting Application Command | **Partly** | Command receipt/fingerprint and commands are durable, but no generic link to the originating provider turn and call ID is established. |
| Resulting event/state transition | **Yes at effect boundary, incomplete end-to-end correlation** | Domain journal / runtime records keep effects and command causation, but the provider call correlation is missing. |

The future audit requirement is a correlation record or joined audit projection
containing at least:

```text
providerTurnId
toolCallId
model-facing tool identity + selected definition/profile hash
decoded semantic arguments (bounded/redacted according to data policy)
trusted Runtime binding references
resulting commandId / settlement reference
resulting event or durable effect reference
outcome / rejection / observation reference
```

This is an **audit/effect link**, not persistence of an `AgentAction` wire
object. `SessionRepository`, `ModelContextManifest`, `ProviderTurnRecord`, and
CommandReceipt as currently shaped are not sufficient by themselves. The
durable storage owner and retention policy remain for a later scoped audit
design; this review does not add a table or Session entry schema.

Evidence: `packages/agent-runtime/src/driver.ts` ModelOutput append;
`packages/model-context/src/compiler.ts` manifest; `packages/ports/src/provider.ts`
`ProviderTurnRecord` / `CanonicalProviderEvent`; `packages/application/src/gateway.ts`
receipt creation; `adapters/persistence-sqlite/src/provider-turns.ts`.
