# Model–Runtime Binding Review

## Binding rule

The model proposes a tool name and tool arguments. Runtime supplies identity, authority, resource admission, approvals, sandbox, persistence, and settlement. The current `ToolIntent` and `ToolExecutionContext` types make that split explicit (`packages/ports/src/tool.ts:42-92`).

## Field ownership matrix

| Field | Model may choose/provide | Runtime knows/binds | Current evidence | Audit judgment |
|---|---|---|---|---|
| `read.path`, `list.path`, `patch.path`, `shell.cwd` | Resource intent within visible schema | Canonical resource regions, project/workspace, sandbox root | tool handlers + `environment.resolve` | Appropriate split; runtime must remain authoritative |
| `patch.unifiedDiff` | Yes | No semantic reconstruction by runtime | `patchExecutor` | Model-owned content, runtime-owned write admission |
| `shell.command`, `timeoutMs` | Yes, subject to policy | Shell policy, approval, sandbox, timeout enforcement | `shell.ts`, `ToolRuntimePort.invoke` | Model proposes; runtime decides whether execution is allowed |
| tool name/version | Tool proposal | Definition lookup and executor lookup | `runtime.ts:103-116` | Version should remain runtime-validated |
| `callRef` | Present in `InvokeTool` branch | Used to derive invocation id in slice handler | `directives.ts:346-353` | Correlation identity is runtime-sensitive; current model supply is a governance question |
| `invocationId` | No | Generated from execution/call data by handler | `directives.ts:351-353` | Runtime-owned |
| `approvalId` | No in current handler (`null`) | Approval store and approval matching | `directives.ts:354`, `runtime.ts:149-171` | Runtime-owned; current slice does not expose model-selected approval |
| principal, actor | No | Authenticated request context | `ToolExecutionContext` and handler | Runtime-owned |
| workspace/project/session/execution ids | No | Execution binding | `ToolExecutionContext` | Runtime-owned |
| authority, capabilities, expiry, delegation depth | No | `InvocationAuthority` and checks | `authority.ts`, `runtime.ts:136-147` | Runtime-owned hard invariant |
| control-basis digest | No | Current execution control basis | handler and runtime context | Runtime-owned; stale checking occurs before handler routing |
| `CompletionClaim.claim.workRevision` | Model currently supplies | Current work/control basis is also runtime-known | `decode.ts:184-196`, driver completion path | High review item: model-provided revision is stale-sensitive and should not be trusted without runtime comparison |
| `SpawnSpecialist.spec` / `ProposeChildWorkspace.spec` | Current schema is `{}`; intended mission/proposal semantics are model-driven | IDs, parent, project/workspace, actor, command gateway state | directive handlers and gateway calls | Boundary is under-specified; no semantic field inventory can be proven from `{}` |
| `Yield.waitSpec` | Model chooses wait reason/conditions | Current execution/workspace identity and wait admission | `decode.ts:197-214`, driver settle path | Mixed; identity fields inside conditions need explicit ownership review |
| `LoadSkill.skillId`, `tier` | Model chooses requested skill/tier | Registry availability and content | `skills.ts`, composition registry | Runtime must reject unavailable/untrusted skill |

## Runtime enforcement chain

For executable tools the current chain is:

```text
ToolCallProposed
→ decodeTurn / InvokeTool
→ ToolRuntimePort.invoke
→ definition lookup
→ executor lookup
→ JSON input validation
→ environment.resolve(resource arguments)
→ InvocationAuthority check
→ approval check
→ ResourceAdmission
→ intent persistence
→ sandbox open
→ executor
→ settlement persistence
→ bounded CanonicalToolObservation
```

Evidence: `packages/tool-runtime/src/runtime.ts:101-257`; composition wiring `apps/single-workspace/src/composition.ts:359-368`.

This is a real mechanical enforcement path. It must not be described as prompt-only authority.

## Directive binding

`arbor_directive` is not sent to `ToolRuntimePort`. `decodeTurn` validates its JSON against the output contract and returns canonical `AgentDirective`; the execution driver then performs control-basis freshness checks and routes to handlers (`packages/model-context/src/decode.ts:405-455`; `packages/agent-runtime/src/driver.ts:962-1037`). Some branches settle directly (`CompletionClaim`, `Yield`); some have handlers; `DeclareDependency` has no registered slice handler and becomes `DirectiveUnsupported` in the current slice.

## Findings

### F-TS-02 — runtime-owned identity is represented as model payload in some directive branches

- **Severity:** HIGH (governance/contract review; no change made).
- **Category:** model/runtime binding ambiguity.
- **Evidence:** `InvokeTool.callRef` is model-visible and used to derive `invocationId`; completion claims carry `workRevision`; child/specialist specs are currently `{}` while handlers bind IDs.
- **Call path:** `decodeTurn → driver → SliceDirectiveHandlersLive → ToolRuntime/CommandGateway`.
- **Status:** `DESIGNED mixed / IMPLEMENTED mixed / TESTED partial / BEHAVIORALLY VERIFIED no`.
- **Implication:** future representation adaptation must preserve the distinction between model-selected semantic intent and runtime-generated identity/control facts.

### F-TS-03 — canonical directive branches do not have uniform handler coverage

- **Severity:** MEDIUM.
- **Category:** capability/coverage gap.
- **Evidence:** handler registry includes `InvokeTool`, `Communicate`, `LoadSkill`, `ChangeMode`, governance/child/specialist handlers; the driver separately settles `CompletionClaim` and `Yield`; unsupported branches are journaled as `DirectiveUnsupported`.
- **Status:** `DESIGNED ten branches / IMPLEMENTED partial / TESTED scripted / BEHAVIORALLY VERIFIED no`.
- **Implication:** a model-visible directive branch is not equivalent to a completed runtime capability.
