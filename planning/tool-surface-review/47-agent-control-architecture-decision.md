# Agent Control Architecture Decision

**Date:** 2026-09-27
**Decision status:** Governance recommendation; no frozen contract or production code changed
**Recommended option:** `REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`

## Recommendation

Reduce `AgentDirective` from a formal versioned canonical output contract to an internal, process-local `AgentAction` ADT. Keep provider/model-facing tool definitions and codecs separate from Arbor's internal action semantics. Keep Application commands, Domain events, authority facts, and durable records as the canonical effect boundaries.

```text
provider/model tool representation
  → model-context provider-neutral ToolCall proposal
  → agent-runtime typed codec
  → internal AgentAction ADT
  → shared freshness / safety / routing
  → owning control handler
  → CommandGateway / ToolRuntime / Execution settlement
  → Domain or durable Runtime effect
```

This preserves the useful internal typed handoff while avoiding a versioned canonical union that every provider codec must target despite there being no external contract consumer. It also matches the evidence: `AgentDirective` is not persisted in full, is not sent across an Arbor process boundary, and has no external consumer. A TypeScript union crossing an internal package boundary is not, by itself, a wire protocol.

## Why not Option A — `KEEP_FULL_AGENT_DIRECTIVE`

Option A can work and aligns with the current frozen DID. It remains useful if Arbor later establishes a real consumer for a versioned canonical action representation, such as:

- persistent action records that are re-decoded or replayed across versions;
- a cross-process/plugin API that promises stable serialized action semantics;
- independently deployed runtimes that exchange canonical actions;
- an explicit event-sourced model-decision journal.

None of those requirements is evidenced in the inspected HEAD. The existing ProviderTurn and Session metadata persist output-contract identity and directive kinds, not full action arguments. A versioned union therefore creates an additional evolution/migration policy without a current replay or interoperability consumer. It also does not remove provider/model representation compilation; Qwen's shallow tool needs still require adaptation before decoding.

**What A offers over B:** a named canonical contract version and a clear versioned semantic boundary after representation decode. **What it costs here:** stronger compatibility obligations than current persistence/wire use warrants, plus a gap between the frozen “validated directive” description and HEAD's partial tag-only decode.

## Why not Option C — `REMOVE_UNIFIED_AGENT_DIRECTIVE_USE_TYPED_CONTROL_TOOLS`

Option C is also viable. It can satisfy action-to-command tests, authority checks, fail-closed codecs, audit, and recovery through per-tool handlers plus shared infrastructure. No Arbor invariant logically requires a semantic union.

The cost is concentrated in Arbor's shared action loop. Freshness classification, safety activity admission, handler dispatch, settlement outcomes, and unsupported-action observations are currently common Runtime work. C must either repeat relevant policy in each typed tool handler or use an authoritative tool metadata registry and common decorator. That is implementable, but risks action semantics being split between schema, handler registration, and policy tables.

**What C offers over B:** fewer semantic normalization steps and highly isolated handlers. **What it gives up:** one common typed action value for cross-cutting control middleware, uniform internal action audit, and a simple shared model-intent-to-command test seam.

## What is and is not uniquely bought by a union

No hard product or security requirement is impossible without a union. A generic tool name, schema version, and shared invocation context can support authorization, audit, and per-tool tests. Application and Domain enforcement remain decisive regardless of architecture.

The concrete benefit of B is narrower: one internal action identity lets a single Runtime pipeline apply the same action-level rules before dispatch. This is more than type tidiness because Arbor already uses action identity to select freshness strength, safety admission, special settlement behavior, and handler routing. The ADT should exist only at that in-process control seam, not as a provider-facing schema or durable contract.

The present implementation does not make this exhaustive today: handler lookup is dynamic and missing handlers become `DirectiveUnsupported`. Retaining an internal ADT is an opportunity for stronger compile-time handler coverage, but that improvement would need a later explicit design and test; it is not an existing guarantee.

## Codex / OpenCode pattern and Arbor-specific needs

The existing repository review in `22-agent-action-inventory.md` describes the useful OpenCode/Codex pattern: named tools with schemas and executable handlers; argument validation before execution; invocation context; separate Runtime permission/sandbox/approval policy. OpenCode's current `packages/core/src/tool/tool.ts` pairs input/output schemas and typed execution with a context, and decodes input in its runtime wrapper. Codex's current `codex-rs/core/src/tools/sandboxing.rs` factors shared `Approvable` and `Sandboxable` traits while concrete handlers remain typed. These are patterns to reuse, not contract authority for Arbor.

Arbor can reuse:

- concrete model-facing tool names and shallow per-tool schemas;
- typed argument codecs;
- a trusted invocation context supplied by Runtime;
- separate visibility and authorization;
- bounded tool/action observations;
- central dispatch and execution policy around the typed handler.

Arbor must add and preserve its own semantics:

- long-lived Responsibility and Work lifecycles;
- Work settlement followed by independent Verification, Acceptance, and completion;
- formation governance and the distinction between durable Workspace decomposition and temporary specialist execution;
- Dependency matching, durable waits, and wake/recovery rules;
- durable, correlated cross-Workspace communication;
- exact-bound command authority, freshness, idempotency, and replay of durable effects.

These Arbor-specific requirements belong in Runtime, Application, and Domain contracts; they do not require the model to generate one canonical multi-action JSON union.

## AgentDirective v2 decision

The recommendation is:

```ini
agent_directive_v2_as_versioned_canonical_contract = NOT_REQUIRED_BY_CURRENT_EVIDENCE
agent_action_as_internal_adt = USEFUL
full_action_payload_persistence = NOT_REQUIRED_BY_CURRENT_EVIDENCE
```

Accordingly, do not continue the current v2 work as a canonical wire/output schema. The existing v2 drafts and action analyses remain useful inputs for defining internal semantic actions and per-tool codecs if governance accepts this direction. They are not authorization to implement, and this review does not revisit the four paused field-source gaps.

`RespondToHuman` remains the bounded response channel already separated from the structured directive concept. This architecture review does not fold it into tool calls or define its output contract.

## Migration boundary for a later governed change

Current clean-HEAD path:

```text
ModelContext.decodeTurn
  → AgentDirective
  → AgentRuntime
```

Candidate after explicit governance and scoped design:

```text
Model Context compiles model-family tool representation
  → provider-neutral tool-call proposal
  → Agent Runtime codec creates internal AgentAction
  → shared control middleware / typed handler
  → existing Application command, ToolRuntime, or Execution settlement
```

Responsibility boundary:

| Area | Candidate ownership |
|---|---|
| Model Context | Select visible tools, compile concrete schemas for the selected model/provider profile, preserve generic provider events, and record representation provenance in the existing manifest boundary if required by governance. |
| Agent Runtime | Decode each control call into internal `AgentAction`; bind execution facts from trusted context; apply freshness/safety/routing and return common execution outcomes. |
| Application | Keep command DTOs, command IDs, idempotency, command authority, gateway validation, receipts, transactions, and event emission. |
| Domain | Keep lifecycle transitions and semantic invariants unchanged. |
| Tool Runtime | Keep executable capability authorization, sandbox/resource admission, invocation recovery, and bounded observations. |
| Persistence | Do not persist `AgentAction` unless a separate governance decision demonstrates a replay/audit need. Continue storing durable commands, events, settlements, and manifests. |

The existing `agent-directive-v1` output-contract references and `directiveKinds` transcript fields are historical metadata. No full v1 directive payload is present in the inspected persistence schema, so this review found no need to migrate old action JSON. Reading historical contract refs may remain necessary for transcript/manifest interpretation.

## Frozen-contract governance boundary

`docs/design/03-detailed-implementation-design.md` §8.15 and §10.6, plus P3 `03-agent-loop-driver.md`, freeze the AgentDirective boundary. The `AGENTS.md` governance rule reserves `docs/design/**` changes for manual governance.

If this recommendation is adopted, manual governance must explicitly supersede the relevant frozen design clauses before any implementation authorization. This review does not edit those files and does not authorize deletion, renaming, or package changes.

## Next decision point

The next step is a manual governance decision on whether to adopt `REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`. If accepted, authorize a **scoped design** that defines only:

1. where provider-neutral tool proposals end and Agent Runtime codecs begin;
2. the internal ADT's action identity and shared control metadata;
3. the validation and fail-closed path before Runtime binding;
4. handler exhaustiveness versus intentional unsupported behavior;
5. what audit data is required, if anything beyond the current action-kind transcript;
6. how old output-contract references remain readable.

Only after that design is accepted should a separate implementation authorization be considered. S01, the model-facing schema, the v2 source gaps, and Wave 2 remain stopped.
