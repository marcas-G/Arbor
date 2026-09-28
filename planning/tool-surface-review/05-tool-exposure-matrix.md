# Tool Exposure Matrix

## Production selection path

The only production `prepareTurn` call found is `packages/agent-runtime/src/driver.ts:656-702`. It always passes `GENERIC_COGNITION_PROGRAM`. Tool selection is:

```text
human conversation → includeTools: false → catalog tools omitted
other execution → includeTools omitted/true → all catalog refs resolved
compileTurn → arbor_directive appended in both cases
```

There is no execution-purpose-specific filter for Formation, Bootstrap, Human Steer, Verification, Query, Child execution, or Continuation.

## Matrix

| Execution purpose/binding | Program path actually found | Catalogued executable tools | `arbor_directive` | Distinct exposure policy | Evidence status |
|---|---|---|---|---|---|
| Generic Work | `GENERIC_COGNITION_PROGRAM` | `read`, `patch`, `shell`, `list` plus committed project definitions | Yes | No | `IMPLEMENTED yes / TESTED p5 + p12 / BEHAVIORALLY VERIFIED partial` |
| Root Conversation / coordination conversation | Same generic program; conversation messages/history added | Hidden by `includeTools:false` | Yes | Only executable tools hidden | `IMPLEMENTED yes / TESTED source + conversation tests / BEHAVIORALLY VERIFIED partial` |
| Formation | No distinct production activation found | If routed as non-conversation execution, inherits generic catalog | Yes if turn compiles | No formation filter found | `DESIGNED contract mentions formation / IMPLEMENTED distinct path not found / TESTED no dedicated exposure test / BEHAVIORALLY VERIFIED no` |
| Bootstrap | No distinct production activation found | Unknown; likely generic if ordinary execution path | Yes if turn compiles | No bootstrap filter found | `UNRESOLVED` |
| Human Steer continuation | Steer enters runtime command/next execution; no separate prepare path found | Inherits next generic execution surface | Yes | No steer-specific filter found | `IMPLEMENTED external command path / TESTED partial / BEHAVIORALLY VERIFIED no` |
| Verification | No verifier-specific `prepareTurn` or filter found | Could inherit mutation-capable generic catalog | Yes | No read-only verifier surface found | `HIGH gap; no dedicated test` |
| Query / Inspection | Human conversation hides executable tools; non-conversation query surface not found | If ordinary execution, generic catalog is possible | Yes | No query-specific read-only surface found | `HIGH gap; G2 read-only boundary remains deferred` |
| Child execution | No distinct tool filter found | Inherits generic catalog | Yes | No child-specific surface | `IMPLEMENTED inheritance only / TESTED no dedicated matrix` |
| Continuation / recovery | Driver re-prepares; no distinct tool filter found | Inherits generic catalog | Yes | No continuation-specific surface | `IMPLEMENTED reprepare only / TESTED partial` |

## Exposure findings

### F-TS-07 — generic catalog overexposure

- **Severity:** HIGH.
- **Category:** `OVEREXPOSED_TOOL_SURFACE` / `WRONG_EXECUTION_EXPOSURE`.
- **Evidence:** `prepare-turn.ts:159-164` exposes every `visibleRefs`; driver only special-cases conversation with `includeTools:false`; `p5-slice-acceptance.test.ts:650-666` confirms all four builtins in the live Work request.
- **Call path:** `driver → ModelContext.prepareTurn → ToolCatalogPort.visibleRefs → resolveForModel → compileTurn`.
- **Status:** `DESIGNED distinct purposes in surrounding contracts / IMPLEMENTED generic surface / TESTED generic surface only / BEHAVIORALLY VERIFIED no purpose comparison`.
- **Risk:** Query/Verification/formation-like turns may see mutation-capable or irrelevant tools.

### F-TS-08 — directive tool remains visible when executable tools are hidden

- **Severity:** MEDIUM.
- **Category:** output-surface coupling.
- **Evidence:** `includeTools:false` empties `plan.tools`, but `compileTurn` unconditionally appends `arbor_directive` (`compiler.ts:132-144`).
- **Status:** `IMPLEMENTED yes / TESTED compiler and conversation path / BEHAVIORALLY VERIFIED partial`.
- **Risk:** a “no executable tools” conversation can still emit any branch admitted by `agent-directive-v1`, including organizational actions, unless another layer constrains the output contract/driver context.

### F-TS-09 — no dedicated query/verifier read-only surface

- **Severity:** HIGH.
- **Category:** capability/exposure boundary.
- **Evidence:** no execution-purpose filtering call path found; `ToolRuntime` itself enforces authority but catalog exposure is generic.
- **Status:** `DESIGNED read-only semantics exist / IMPLEMENTED distinct surface not found / TESTED no dedicated test / BEHAVIORALLY VERIFIED no`.
- **Risk:** runtime may reject an action after the model has already been offered the capability; this is weaker than purpose-appropriate exposure.
