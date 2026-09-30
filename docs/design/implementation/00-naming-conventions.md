# Arbor Implementation Naming Conventions

## Purpose

Names must identify both the owning boundary and the thing's lifecycle. A
reader should not need historical phase knowledge to understand a symbol.

## Canonical domain vocabulary

| Name | Meaning | Do not call it |
|---|---|---|
| Project | Top-level governance and lifecycle boundary | repository, folder |
| Workspace | Long-lived responsible identity | worktree, session, agent |
| Work | Outcome requirement owned by a Workspace | task execution, chat |
| Execution | Recoverable episode that performs Work or coordination | agent identity |
| Session | Ordered durable model/runtime context history | conversation identity |
| AgentLoop | The complete runtime algorithm for one Execution | AgentTurn |
| AgentLoopStep | One durable recoverable loop iteration | Turn, DecisionTurn |
| ProviderTurn | One logical model decision, possibly with retry attempts | Agent turn |
| ModelDecision | In-process preparation/provider/decode result | durable Turn |
| ToolInvocation | One executable tool effect attempt | control action |
| AgentAction | Process-local typed control action | directive, wire contract |
| ControlBasis | Trusted revision snapshot used for freshness | prompt metadata |

## Application/runtime vocabulary

- `SingleWorkspace*` names the production application composition. `Slice*`
  is a retired implementation-phase term.
- `Legacy*` must prefix retained superseded paths that are not part of the
  production graph.
- `ExecutableTool*` means the path routed through Tool Runtime.
- `ControlAction*` means the path decoded to internal `AgentAction` and routed
  to an Application/settlement boundary.

## Verb conventions

| Verb | Use |
|---|---|
| `build` | compose a complete application/layer |
| `make` | construct a local service/handler from supplied dependencies |
| `resolve` | deterministically derive a trusted value from canonical inputs |
| `record` | append or persist an already-established fact |
| `execute` | perform an effectful action |
| `complete` | finish a lifecycle phase after effects are committed |
| `decode` | parse provider/model-authored data without executing it |

Avoid generic verbs such as `process`, `handleThing`, or `progress` when a
domain-specific verb exists.

## Agent Runtime module names

- `agent-loop-driver.ts` — top-level loop orchestration.
- `model-decision.ts` — prepare context, call Provider, decode/repair output.
- `model-output-journal.ts` — accept decoded output durably.
- `agent-loop-actions.ts` — execute ordered executable/control actions.
- `agent-loop-step-completion.ts` — commit observations, successor or settlement.
- `agent-loop-policy.ts` — pure bounds and settlement policy.

`ProviderTurn` remains reserved for Provider Runtime persistence and transport;
these modules must not introduce another generic `Turn` abstraction.

## Presentation names

Internal IDs remain available for diagnostics and copy actions, but ordinary
UI labels use Project/Workspace/Work names. A Workspace and a Git worktree are
never presented as the same concept.

## Historical evidence

Old planning/result records may retain superseded symbol names because they
describe the source tree at their recorded baseline. Current design and source
must use this vocabulary; architecture tests enforce the forbidden aliases.
