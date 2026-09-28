# Tool Definition Cards

Each card records the model-facing definition, runtime binding, and evidence. The input schema shown here is summarized; the authoritative JSON is the `inputSchemaJson` constant in `packages/tool-runtime/src/catalog.ts`.

## Card: `read`

- **Type / owner:** executable, builtin, Tool Runtime.
- **Source:** `packages/tool-runtime/src/catalog.ts:120-130`; executor `packages/tool-runtime/src/tools/read.ts`.
- **Purpose:** bounded read from an admitted file/resource region.
- **Description shown to model:** “Read a bounded slice of a file inside the admitted resource regions.”
- **Schema:** object; required `path`; `path` is a `oneOf` of `FileTree` and `GitWorktree` objects; optional non-negative integer `offset` and `limit`.
- **Model-supplied fields:** resource selector and slice bounds.
- **Runtime-bound fields:** project/workspace/execution/session, authenticated principal, authority, admitted regions, sandbox root, invocation identity, tool version, timestamps.
- **Runtime path:** `ToolCallProposed → decodeTurn → InvokeTool handler → ToolRuntimePort.invoke → definition lookup → input validation → environment.resolve → authority → admission → sandbox → readExecutor`.
- **Output:** bounded JSON observation with `text`, `truncated`, and `byteSize`; `resultRef` is currently null.
- **Status:** `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Risk:** schema uses `oneOf`, and tool choice is not filtered by execution purpose.

## Card: `patch`

- **Type / owner:** executable, builtin, Tool Runtime.
- **Source:** `packages/tool-runtime/src/catalog.ts:133-143`; executor `packages/tool-runtime/src/tools/patch.ts`.
- **Purpose:** apply a unified diff within admitted resource regions.
- **Description:** “Apply a unified diff to a file inside the admitted resource regions.”
- **Schema:** required `path` and `unifiedDiff`; `path` is an object requiring `_tag` and `path`, but the schema does not constrain properties or set `additionalProperties: false`.
- **Model-supplied fields:** resource selector and diff.
- **Runtime-bound fields:** all invocation/control/authority/admission/sandbox fields listed above.
- **Runtime path:** same executable path; `patchExecutor.write = true`, side-effect semantics `Idempotent`.
- **Output:** bounded `{ applied, hunks }`; no result artifact ref.
- **Status:** `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Risk:** weak path schema is less explicit than `read`/`list`; mutation-capable tool is exposed on generic non-conversation turns without purpose-specific filtering.

## Card: `shell`

- **Type / owner:** executable, builtin, Tool Runtime.
- **Source:** `packages/tool-runtime/src/catalog.ts:146-156`; executor `packages/tool-runtime/src/tools/shell.ts`.
- **Purpose:** run a policy-checked shell command inside the sandbox.
- **Description:** “Run a policy-checked shell command inside the sandbox.”
- **Schema:** required `command` and `cwd`; optional positive `timeoutMs`; `cwd` is a weak object requiring `_tag` and `path` only.
- **Model-supplied fields:** command, cwd, timeout.
- **Runtime-bound fields:** authority, project/workspace/execution/session, approvals, admitted regions, sandbox, invocation id, environment.
- **Runtime path:** same executable path; `shellPolicy` classifies deny/approval/allow, then executor runs `sh -c`.
- **Output:** schema advertises `stdoutRef`/`stderrRef`, but the current executor writes empty strings and discards captured stdout/stderr; `resultRef` is null.
- **Status:** `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Risk:** model-visible result contract and actual observation content diverge; generic exposure can be inappropriate for read-only/query/verifier contexts.

## Card: `list`

- **Type / owner:** executable, builtin, Tool Runtime.
- **Source:** `packages/tool-runtime/src/catalog.ts:160-171`; executor `packages/tool-runtime/src/tools/list.ts`.
- **Purpose:** bounded listing of files/directories in an admitted region.
- **Description:** “List files and directories inside an admitted resource region, bounded by depth.”
- **Schema:** required `path` with the same two-branch `oneOf`; optional non-negative `depth`.
- **Model-supplied fields:** resource selector and depth.
- **Runtime-bound fields:** execution, workspace, project, authority, admission, sandbox, invocation metadata.
- **Runtime path:** same executable path; executor caps output at 500 entries.
- **Output:** bounded `{ entries, truncated }`; no result artifact ref.
- **Status:** `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Risk:** read-only but still visible wherever generic tools are enabled; no query-specific exposure contract.

## Card: committed project tool definition

- **Type / owner:** project-scoped executable definition.
- **Source:** `packages/ports/src/project-tool-registry.ts`; registration command `packages/application/src/commands/register-project-tool.ts`; projection `packages/tool-runtime/src/catalog.ts:223-270`.
- **Purpose:** allow committed project/plugin tool metadata to be projected to the model.
- **Model-visible fields:** name, description, input schema, version/hash, capability metadata, side-effect semantics.
- **Runtime binding:** no corresponding executor or runtime definition-store union is added by `RegisterProjectTool`; current composition supplies builtin definitions/executors only.
- **Status:** `DESIGNED yes / IMPLEMENTED catalog registration and projection yes / TESTED yes for registration and projection / BEHAVIORALLY VERIFIED no`.
- **Finding:** visible-but-unexecutable capability; see `10-findings-and-open-questions.md` F-TS-01.

## Card: `arbor_directive`

- **Type / owner:** directive representation, Model Context / Output Contract.
- **Source:** `packages/model-context/src/compiler.ts:138-143`; schema `packages/model-context/src/decode.ts:131-251`.
- **Purpose:** carry one structured organizational directive under the selected output contract.
- **Description:** “Emit one structured Arbor directive that satisfies this turn's output contract.”
- **Schema:** current canonical `oneOf` union; ten branches for `agent-directive-v1`, with nested `Yield` condition union.
- **Model-supplied fields:** branch `_tag` and branch payload as represented by the canonical schema.
- **Runtime-bound fields:** decision-basis manifest, control-basis freshness, execution/session/workspace identity, handlers, authority, and any command/runtime ids generated by handlers.
- **Runtime path:** provider tool call → `decodeTurn` special case → canonical schema validation → `AgentDirective` → driver routing/handler.
- **Status:** `DESIGNED yes / IMPLEMENTED yes / TESTED yes / BEHAVIORALLY VERIFIED partial`.
- **Compatibility evidence:** L1 passes, L2/L5 fail, and a multi-tool representation passes in `/tmp/agentdirective-provider-replication/`.
- **Risk:** model-facing representation is a provider/model compatibility boundary; the canonical semantic contract remains valid but the current single-union representation is not reliably consumable by the tested Qwen/llama.cpp combination.

## Card: cognitive/meta tools and skills

- **Type:** none as independent model-facing tools.
- **Source:** `packages/model-context/src/skills.ts`; `apps/single-workspace/src/composition.ts:295-307`; canonical branches in `packages/model-context/src/decode.ts`.
- **Status:** `DESIGNED directive/skill abstractions yes / IMPLEMENTED separate tool no / TESTED limited / BEHAVIORALLY VERIFIED no`.
- **Risk:** terminology can make `LoadSkill`/`ChangeMode` look like tool capabilities even though they are directive branches with different routing and authority.
