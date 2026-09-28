# Tool Surface & Definition Audit — Scope and Method

## Scope

This is a read-only architecture audit of every model-facing tool surface currently reachable from Arbor production assembly. It covers:

- builtin executable tool definitions;
- committed project tool definitions;
- the `arbor_directive` structured-output representation;
- canonical directive branches that are not executable tools;
- tool catalog and model-context projection;
- provider request assembly and stream decoding;
- runtime binding, authority, admission, approval, sandbox, and observation paths;
- skill and cognitive-tool claims;
- tests and live evidence that establish what is implemented.

This audit does **not** modify production code, Prompt text, `agent-directive-v1`, frozen contracts, provider configuration, or runtime behavior. Only files under `planning/tool-surface-review/` are added.

## Method

1. Start at the production composition root and identify the concrete `ToolCatalogPort`, `ToolRuntimePort`, `SkillRegistry`, `ModelContext`, and execution driver layers.
2. Trace the request path backwards and forwards:

   ```text
   catalog → ModelContext.prepareTurn → compileTurn
   → PortableModelRequest.toolDefinitions → ProviderPort
   → CanonicalProviderEvent → decodeTurn → directive handlers / ToolRuntime
   ```

3. Compare model-visible definitions with runtime executors and canonical output-contract branches.
4. Inspect exposure predicates (`includeTools`, execution purpose, binding, project scope) rather than inferring exposure from type names.
5. Record static and scripted tests separately from behavioral evidence. No test is called behavioral unless an actual model scenario and outcome are present.
6. For every conclusion, record `DESIGNED`, `IMPLEMENTED`, `TESTED`, and `BEHAVIORALLY VERIFIED` status.
7. Mark gaps as audit findings only; do not repair them in this phase.

## Evidence conventions

- **CONFIRMED**: directly established by current source or a named test/live artifact.
- **PARTIAL**: one side of the boundary is implemented, but the end-to-end property is not established.
- **UNRESOLVED**: current source/tests cannot answer the question.
- **DESIGNED** means a type, comment, contract, or schema expresses the intent.
- **IMPLEMENTED** means a production call path exists.
- **TESTED** means a static or scripted test asserts it.
- **BEHAVIORALLY VERIFIED** means a real-model scenario demonstrates the property.

## Baseline

The audit is based on the current working tree of `/data/students/gaolei/Arbor` at the audit start. The tree contains unrelated pre-existing worktree changes; this audit does not reset, clean, stash, or edit them.

Primary source locations:

- `packages/tool-runtime/src/catalog.ts`
- `packages/tool-runtime/src/runtime.ts`
- `packages/tool-runtime/src/tools/*.ts`
- `packages/model-context/src/prepare-turn.ts`
- `packages/model-context/src/compiler.ts`
- `packages/model-context/src/decode.ts`
- `packages/agent-runtime/src/driver.ts`
- `apps/single-workspace/src/composition.ts`
- `apps/single-workspace/src/directives.ts`
- `packages/ports/src/provider.ts`
- `packages/ports/src/tool.ts`

Primary test/evidence locations:

- `tests/p12-toolcatalog.test.ts`
- `apps/single-workspace/test/p5-slice-acceptance.test.ts`
- `packages/tool-runtime/test/p4-catalog.test.ts`
- `packages/tool-runtime/test/p4-pipeline.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `adapters/provider-openai/test/provider-client.test.ts`
- `planning/results/wave1-live-call-evidence.json`
- `/tmp/agentdirective-provider-replication/gate.json`

## Audit boundary

The documents answer what the current implementation exposes and enforces. They do not decide whether the frozen semantics should change, whether multi-tool directive representation should be implemented, or whether a project tool executor should be added. Those are implementation or governance decisions recorded as open questions.
