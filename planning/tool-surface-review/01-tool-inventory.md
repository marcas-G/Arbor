# Tool Inventory

## Inventory summary

| Surface | Current count | Scope | Model-visible? | Executable by current production composition? |
|---|---:|---|---|---|
| Builtin executable definitions | 4 | `read`, `patch`, `shell`, `list` | Yes when `includeTools !== false` | Yes |
| Committed project definitions | 0..N | Project registry union | Yes when a project id is configured and committed | No executor is wired in current composition |
| Canonical directive representation | 1 | `arbor_directive` | Always appended by `compileTurn` | No; decoded into canonical directives |
| Independent cognitive/meta tools | 0 | None found | No | No |
| Skill loading as a model-facing tool | 0 | `LoadSkill` is a directive branch, not a separate tool | No separate tool | Handler exists, registry is empty |

A normal non-conversation turn with no committed project tools therefore contains **five** model-facing tool definitions: `arbor_directive`, `read`, `patch`, `shell`, and `list`. A human conversation turn contains **one** model-facing definition (`arbor_directive`) because `includeTools: false` suppresses catalogued executable tools, while `compileTurn` still appends `arbor_directive`.

## Builtin executable tools

| Name | Source | Version/hash | Capability | Side effects | Input surface | Result/observation | Runtime reachability |
|---|---|---|---|---|---|---|---|
| `read` | `packages/tool-runtime/src/catalog.ts` (`READ_DEFINITION`) | `1` / `read-v1` | `fs:read` | `ReadOnly` | `path`, optional `offset`, `limit` | bounded text, truncation, byte size | `BUILTIN_EXECUTORS` → `readExecutor` |
| `patch` | same (`PATCH_DEFINITION`) | `1` / `patch-v1` | `fs:write` | `Idempotent` | `path`, `unifiedDiff` | applied flag, hunk count | `BUILTIN_EXECUTORS` → `patchExecutor` |
| `shell` | same (`SHELL_DEFINITION`) | `1` / `shell-v1` | `shell:exec` | `Reconcilable` | `command`, `cwd`, optional `timeoutMs` | exit code plus stdout/stderr refs in schema | `BUILTIN_EXECUTORS` → `shellExecutor` |
| `list` | same (`LIST_DEFINITION`) | `1` / `list-v1` | `fs:read` | `ReadOnly` | `path`, optional `depth` | bounded entries, truncation | `BUILTIN_EXECUTORS` → `listExecutor` |

## Project tool definitions

`ToolCatalogPortLive({ projectId })` returns `BUILTIN_TOOLS ∪ committed ProjectToolRegistry definitions`. The projection includes name, description, input schema, version/hash, capability metadata, and side-effect semantics. The registry path is tested in `tests/p12-toolcatalog.test.ts` and `tests/p12-acceptance.test.ts`.

The current production composition wires `ToolRuntimeLive(BUILTIN_EXECUTORS)` and `ToolDefinitionStoreLive` with builtin definitions only (`apps/single-workspace/src/composition.ts:359-368`; `packages/tool-runtime/src/catalog.ts:180-191`). Therefore a committed project definition can be visible to the model while `ToolRuntimePort.invoke` cannot resolve it in the runtime definition store and returns `Denied("unknown tool")` before executor lookup (`packages/tool-runtime/src/runtime.ts:101-116`). No project executor is wired either. This is a concrete visibility/capability mismatch, not proof that project tools are intended to be non-executable.

## Canonical directive representation

`compileTurn` appends a single definition named `arbor_directive` whose schema is the current output-contract schema (`packages/model-context/src/compiler.ts:132-144`). `agent-directive-v1` currently admits ten branches:

```text
InvokeTool, Communicate, DeclareDependency, RequestGovernance,
SpawnSpecialist, ProposeChildWorkspace, LoadSkill, ChangeMode,
CompletionClaim, Yield
```

`decodeTurn` treats `arbor_directive` specially, parses its arguments, checks the allowed `_tag`, validates the canonical schema, and returns an `AgentDirective` (`packages/model-context/src/decode.ts:405-441`). It is not looked up in `ToolRuntimePort`.

## Cognitive/meta surface

No independent model-facing cognitive tool was found. `ChangeMode` and `LoadSkill` are canonical directive branches. `LoadSkill` has a handler, but the production `SkillRegistry` layer returns `available: []` and fails loads (`apps/single-workspace/src/composition.ts:295-307`). The skill abstraction can create A5 `SkillGuidance` fragments (`packages/model-context/src/skills.ts:41-62`), but no active production skill body is exposed by the current composition.

## Status labels

- Builtins: `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- Project definitions: `DESIGNED yes / IMPLEMENTED catalog visibility yes / TESTED catalog yes / BEHAVIORALLY VERIFIED no`; executable path is not complete.
- `arbor_directive`: `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`; current Qwen replication shows the monolithic representation is not compatible at all schema levels.
- Cognitive tools: `DESIGNED as directive branches / IMPLEMENTED no separate tool / TESTED only through directive tests / BEHAVIORALLY VERIFIED no`.
