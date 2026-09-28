# Directive Representation Analysis

## Canonical vs model-facing boundary

The current implementation conflates the two at compile time by placing the canonical `agent-directive-v1` union directly in the `arbor_directive` tool schema. The accepted compatibility experiment establishes that this is not a safe assumption for the tested Qwen Q2_K + llama.cpp combination.

The semantic boundary that must be preserved is:

```text
canonical AgentDirective semantics
  → model-family/provider representation
  → model tool call
  → deterministic representation decoder
  → canonical AgentDirective
  → existing canonical validator
  → Runtime
```

This document records the boundary as an audit input; it does not implement it.

## Branch table

| Canonical branch | Current model-facing representation | Runtime route | Model/runtime split |
|---|---|---|---|
| `InvokeTool` | nested branch in `arbor_directive` | `InvokeTool` handler → ToolRuntime | model selects tool/args; runtime binds identity/authority |
| `Communicate` | nested branch | observation handler | model supplies text; runtime journals observation |
| `DeclareDependency` | `{}` payload placeholder | no slice handler found | semantic payload unresolved |
| `RequestGovernance` | `{}` payload placeholder | gateway/proposal handler | request semantics unresolved in schema |
| `SpawnSpecialist` | `{}` payload placeholder | gateway handler | mission vs runtime IDs unresolved |
| `ProposeChildWorkspace` | `{}` payload placeholder | gateway handler | proposal semantics unresolved |
| `LoadSkill` | `skillId`, `tier` | SkillRegistry handler | model requests; registry decides availability |
| `ChangeMode` | `mode` string | state update handler | model proposes; runtime persists current mode |
| `CompletionClaim` | nested claim | driver settles directly | model supplies claim; runtime must validate revision/freshness |
| `Yield` | reason + nested wait union | driver settles directly | model proposes wait semantics; runtime owns execution identity/admission |

## Representation invariants

Any future representation compiler/decoder must preserve:

1. **Soundness:** each model-facing tool maps to at most one canonical branch/value.
2. **Completeness:** every branch admitted for the turn has a representation.
3. **Semantic preservation:** decoding does not invent missing parameters, widen validation, or drop canonical required information.
4. **Authority preservation:** splitting a union into tools does not turn a directive branch into an executable ToolRuntime capability.
5. **Provenance:** the request manifest identifies canonical contract version/hash, compiler/profile identity, and concrete model-visible definitions/hash.

## Current status

- Canonical contract: `IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- Single monolithic model-facing tool: `IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED failed at L2/L5 replication`.
- Multi-tool representation: experiment-only, not production (`DESIGNED candidate / IMPLEMENTED no / TESTED controlled replication / BEHAVIORALLY VERIFIED limited`).
- Representation compiler ownership: no production abstraction currently found; `compileTurn` only serializes the canonical schema.

## Governance questions

- Should Model Context own a model-family representation compiler, or should this be a provider adapter concern?
- Which capability profile selects monolithic vs multi-tool representation?
- Which canonical branches are eligible in each execution purpose?
- Which branch fields are semantic model choices versus runtime-generated identity?
- What schema replaces the current `{}` payload placeholders?
