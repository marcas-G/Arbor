# Execution Tool Exposure Contract

**Status:** governance contract for future implementation; no production filtering is added here.

## Responsibility model

```text
Execution Purpose
+ Authority
+ Resource Boundary
+ Capability Profile
→ Model-visible Tool Surface
```

`ToolCatalogPort` provides catalogued definitions. A future exposure resolver selects the visible subset for one prepared turn. `ToolRuntimePort` remains the final authorization boundary.

```text
Catalogued ≠ Visible ≠ Authorized
```

A visible tool must be relevant to the purpose and have a ready invocation path. Authorization is still rechecked after the model proposes a call.

## Executable tool classes

| Class | Members | Default semantic role |
|---|---|---|
| Read-only filesystem | `read`, `list` | inspect admitted resources |
| Mutation/external | `patch`, `shell` | change files or execute commands, subject to authority/approval/policy |
| Project executable | committed project definitions | only when executor readiness invariant holds |
| Directive representation | `arbor_directive` or reserved `arbor_directive__*` | canonical organizational output; never ToolRuntime |

## Minimum exposure matrix

`D` means the directive representation is present only for branches admitted by the purpose's output contract/profile. `—` means no executable tool by default.

| Execution purpose | `read` | `list` | `patch` | `shell` | project executable tools | directive representation | Contract note |
|---|---:|---:|---:|---:|---:|---|---|
| Generic Work | Yes, if resource boundary includes read | Yes, if boundary includes read | Yes only with write capability and matching boundary | Yes only with shell capability/policy | Only Ready tools for this execution | `D: Work-allowed branches` | This is the minimum production Work surface; no default exposure of unready project tools. |
| Root Human Conversation | No | No | No | No | No | `D: conversation-allowed representation` | Conversation must not receive executable affordances. Organizational/mutation branches require a separate explicit output contract; plain text remains the normal response. |
| Formation | Optional `read`/`list` when the formation mission explicitly needs inspection | Optional under same condition | No by default | No by default | No by default | `D: formation proposal/specialist branches only` | Formation proposals are directives/commands, not generic filesystem actions. |
| Bootstrap | No by default | No by default | No | No | No | `D: bootstrap handoff branches only` | Bootstrap identity and resource creation are Runtime/Application-owned; no blanket tool catalog. |
| Human Steer / continuation | Inherit parent purpose surface | Inherit parent purpose surface | Cannot escalate beyond parent | Cannot escalate beyond parent | Cannot add new project tools | `D: continuation-allowed branches` | Continuation preserves the existing surface; Steer does not grant capabilities. |
| Verification | Yes, read-only and within verification binding | Yes, read-only and within verification binding | No | No | No unless separately classified read-only and ready | `D: verifier-result branches only` | No mutation or shell affordance. Exact verifier output branch remains bounded by its frozen contract. |
| Query / Inspection | **DEFERRED** | **DEFERRED** | **DEFERRED** | **DEFERRED** | **DEFERRED** | **DEFERRED** | `FCR-G2-DG-01` must define and mechanically enforce the read-only ceiling first. |

## Directive branch exposure rule

The matrix above does not widen `agent-directive-v1`. A purpose may expose only branches explicitly admitted by its output contract and capability profile. In particular:

- `arbor_directive__*` is never an executable capability;
- `CompletionClaim` is only meaningful for a Work execution with a bound current Work revision;
- formation branches require formation authority and purpose;
- verification cannot use formation or mutation branches;
- conversation cannot silently inherit Work/formation branches merely because `arbor_directive` is present.

The exact branch schemas for four `{}` payloads remain a blocking semantic gap; this contract therefore freezes the exposure responsibility, not a fabricated payload schema.

## Visibility versus authorization

Visibility is a model-context decision. Authorization is mechanical and remains in:

```text
ToolRuntime:
definition → schema validation → resource resolution → authority
→ approval → admission → sandbox → executor → settlement
```

A visible `patch` or `shell` call may still be denied; a hidden tool cannot be selected by the model. Neither layer replaces the other.

## Evidence and ownership

- Current broad exposure: `packages/model-context/src/prepare-turn.ts:159-164`.
- Conversation suppression: `packages/agent-runtime/src/driver.ts:670-687`.
- Unconditional directive append: `packages/model-context/src/compiler.ts:132-144`.
- Runtime enforcement: `packages/tool-runtime/src/runtime.ts:101-257`.
- Query deferral: `planning/gaps/FCR-G2-DG-01-query-read-only-capability-boundary.md`.

**Status:** `DESIGNED frozen in this closure / IMPLEMENTED no purpose resolver / TESTED no dedicated matrix / BEHAVIORALLY VERIFIED no`.
