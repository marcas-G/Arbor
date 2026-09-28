# Schema Complexity Review

## Builtin input schemas

| Tool | Complexity | Exact concern | Evidence |
|---|---|---|---|
| `read` | medium | `path` is a two-branch `oneOf`; branch discriminator is `_tag` + path | `catalog.ts:10-31` |
| `list` | medium | same `path` union; bounded depth | `catalog.ts:74-98` |
| `patch` | shallow but weak | `path` requires `_tag`/`path` but has no branch `const`, explicit properties, or `additionalProperties: false` | `catalog.ts:34-48` |
| `shell` | shallow but weak | `cwd` is an unconstrained object beyond required `_tag`/`path` | `catalog.ts:50-72` |
| project tools | unknown per definition | registry accepts arbitrary committed schemas | `project-tool-registry.ts`, `tests/p12-toolcatalog.test.ts` |

## Canonical `agent-directive-v1`

The provider-visible schema is the same JSON object used by decoder validation (`packages/model-context/src/decode.ts:230-251`). It is a top-level object with a ten-branch `oneOf`. The deepest branch is `Yield.waitSpec.conditions[].oneOf` with seven condition shapes. Several branches are nominally required but semantically unconstrained because their payload schemas are `{}`:

- `DeclareDependency.spec`
- `RequestGovernance.request`
- `SpawnSpecialist.spec`
- `ProposeChildWorkspace.spec`

Concrete branches use `additionalProperties: false`; nested `Yield` conditions use explicit required fields. `InvokeTool` nests a stringified `argumentsJson`, creating a second JSON layer.

## Representation evidence

The accepted replication artifacts are:

- `/tmp/agentdirective-provider-replication/gate.json`
- `/tmp/agentdirective-provider-replication/summary.json`
- `/tmp/agentdirective-provider-replication/mt-invariant-audit.json`

They show:

```text
L1 _tag enum: 3/3 valid
L2 _tag + required payload: 3/3 failure classification
L5 current ten-branch union: 3/3 empty/invalid arguments
MT concrete tools: 3/3 valid arguments, deterministic reconstruction, canonical validation pass
```

This is a model/provider representation finding, not evidence that the canonical contract is semantically wrong.

## Complexity boundary

The current evidence supports the following audit boundary:

1. Canonical validation remains authoritative.
2. A model-facing representation may be shallower or split into multiple tools only if decoding is deterministic and lossless.
3. No flattening may invent missing semantic values, widen the canonical validator, or silently discard required fields.
4. Schema complexity must be evaluated independently from tool protocol. The same Chat Completions route can behave differently for different representations.
5. Any future compiler must record the canonical contract hash and concrete model-visible definitions.

## Findings

### F-TS-04 — monolithic directive representation is a compatibility boundary

- **Severity:** HIGH.
- **Category:** `MODEL_FACING_DIRECTIVE_REPRESENTATION_GAP`.
- **Evidence:** L1/L2/L5/MT replication artifacts above; `compileTurn` currently emits the monolithic schema.
- **Status:** `DESIGNED canonical union yes / IMPLEMENTED single representation yes / TESTED replication yes / BEHAVIORALLY VERIFIED limited to controlled real-model probe`.
- **Implication:** S01 implementation should remain paused until a representation compiler/decoder path is separately authorized.

### F-TS-05 — several canonical branches are schema placeholders

- **Severity:** MEDIUM.
- **Category:** schema semantic under-specification.
- **Evidence:** `{}` payload schemas in `decode.ts:153-167`.
- **Status:** `DESIGNED branch names yes / IMPLEMENTED placeholder schemas yes / TESTED shape acceptance only / BEHAVIORALLY VERIFIED no`.
- **Implication:** tool representation cannot infer the missing business fields; governance must define them before any model-facing flattening.

### F-TS-06 — builtin schemas are inconsistent in strictness

- **Severity:** MEDIUM.
- **Category:** input-schema quality.
- **Evidence:** `read`/`list` use explicit branch constants; `patch`/`shell` use weak object schemas (`catalog.ts:34-72`).
- **Status:** `IMPLEMENTED yes / TESTED static schema projection yes / BEHAVIORALLY VERIFIED no`.
- **Implication:** model-facing schema quality is uneven even before project tools are introduced.
