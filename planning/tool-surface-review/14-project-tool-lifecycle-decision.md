# Project Tool Lifecycle and Executor Ownership Decision

**Date:** 2026-09-27

## Decision

A committed project `ToolDefinition` is not automatically model-visible. It becomes visible only after the execution path proves a ready invocation binding.

```text
Registered definition
  → executor binding for exact identity
  → runtime definition-store binding
  → capability/authority/approval/admission readiness
  → eligible for model exposure
```

If any step is absent, the tool is **not model-visible** for that execution. It must not be exposed and allowed to fail as `unknown tool` after a model call.

## Invariant

```text
MODEL_VISIBLE(tool, execution)
  ⇒ READY_INVOCATION_PATH(tool, execution)
```

The only exception is a tool explicitly classified as a **non-executable representation category**, such as `arbor_directive` or `arbor_directive__*`. Such representations are routed to the Representation Decoder and are not project executable tools.

## Ownership

| Concern | Owner | Decision |
|---|---|---|
| Committed project definition, source, version/hash, provenance | ProjectToolRegistry / Application registration | Registration owns durable definition identity, not execution readiness. |
| Executor registration and lifecycle | Tool Runtime + Composition Root | The runtime binding must register an executor for the exact `(name, version, hash)` identity and expose its side-effect/capability semantics. |
| Exposure eligibility | Model Context exposure resolver | It may project only definitions with a ready invocation path for the current execution/purpose. |
| Input validation, resource resolution, authority, approval, admission, sandbox, settlement | Tool Runtime | Runtime remains final enforcement boundary. |
| Provider representation | Model-family Compiler | It serializes only eligible executable definitions and directive representations for the selected capability profile. |

## Exact-identity invariant

An executor binding is valid only when all of the following agree:

- tool name;
- tool version;
- tool hash/content identity;
- input schema hash/content;
- side-effect semantics;
- declared capability metadata;
- project/execution scope;
- approval and sandbox policy;
- observation/result schema and version.

A definition update invalidates the previous executor binding until a matching binding is committed. Silent fallback to a builtin executor by name is forbidden.

## Lifecycle states

| State | Definition committed | Executor bound | Model-visible | Invocation result |
|---|---:|---:|---:|---|
| `RegisteredPendingExecutor` | Yes | No | No | No model call should occur |
| `Ready` | Yes | Yes, exact identity | Yes if purpose/capability allows | Normal ToolRuntime path |
| `Revoked` | Historical or disabled | Irrelevant | No | Existing durable invocations reconcile under Runtime rules |
| `RepresentationOnly` | Yes | No ToolRuntime executor by design | Only through directive representation routing | Representation Decoder, never ToolRuntime |

## Current mismatch classification

Current source establishes:

- `ToolCatalogPortLive({ projectId })` can append committed project definitions (`packages/tool-runtime/src/catalog.ts:223-270`).
- Production composition supplies builtin-only `ToolDefinitionStoreLive` and `ToolRuntimeLive(BUILTIN_EXECUTORS)` (`apps/single-workspace/src/composition.ts:353-368`).
- `ToolRuntimePort.invoke` therefore cannot resolve an unregistered project definition and returns `Denied("unknown tool")` before executor lookup (`packages/tool-runtime/src/runtime.ts:103-116`).

This is an **implementation gap against the governance invariant**, not a reason to change canonical tool semantics. No executor or catalog filtering is implemented in this closure.

## S01 impact

- A builtin-only S01 sentinel can be scoped safely if the exposure resolver guarantees no unready project definitions are visible.
- The current production path does not yet enforce that guarantee.
- Therefore S01 production implementation remains **NOT AUTHORIZED** until the readiness invariant is mechanically implemented or the S01 execution is explicitly isolated from project tool exposure.

## Test/evidence requirements for future implementation

The future implementation must add tests for:

1. registered project definition without executor → absent from model-visible surface;
2. exact matching executor/version/hash → visible and invokable;
3. stale executor binding after definition hash change → absent/denied before model exposure;
4. representation-only definition → routed to decoder, never ToolRuntime;
5. project scope and authority mismatch → runtime denial even when visible;
6. manifest records the visible definition identity and executable/directive classification.

This document does not add those tests.
