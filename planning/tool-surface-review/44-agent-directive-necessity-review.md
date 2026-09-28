# AgentDirective Necessity Review

**Date:** 2026-09-27
**Status:** Architecture review; no production, Prompt, or frozen-contract changes
**Decision candidate:** `REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`
**Baseline:** `master` at `063d40d236ef73aa2f007d057f9f6d045512fc21` (`HEAD`). The shared working tree contains extensive unrelated uncommitted implementation edits. Production facts below are taken from `HEAD`; working-tree differences are not treated as production evidence.

## Question and conclusion

Arbor needs a typed boundary between model-selected intent and Runtime/Application effects. The evidence does **not** show that this boundary must be a versioned canonical wire contract named `AgentDirective`. In the current implementation the directive value is transient, crosses an in-process package boundary, and is not persisted with its semantic arguments. Versioning its union therefore adds contract and migration weight without currently buying replay, public interoperability, or event-sourcing capability.

The best fit among the reviewed choices is an internal `AgentAction` ADT after provider/model-specific tool decoding. A shared action value gives the Runtime one place to apply freshness classification, activity admission, routing, common results, and uniform tests. This keeps a real semantic control boundary while removing the need for every model-facing representation to serialize one monolithic union.

No requirement examined is literally impossible with direct typed handlers (Option C). The internal ADT is justified because cross-cutting control behavior already exists and currently discriminates by semantic action kind. Option C can reproduce it, but either duplicates that classification across handlers or introduces an action metadata registry that serves much of the same internal purpose.

This is a governance recommendation only. The frozen DID explicitly names `AgentDirective`; Options B and C would require a later manual governance decision to supersede those clauses. This review does not amend them, resume the paused v2 field-source review, or authorize implementation.

## AgentDirective Current Responsibility Map

### Actual production path at `HEAD`

```text
ToolCatalog.visibleRefs / resolveForModel
  → ModelContext.prepareTurn
  → compileTurn (PortableModelRequest + ModelContextManifest)
  → ProviderRuntime / ProviderPort
  → CanonicalProviderEvent[]
  → decodeTurn + OutputContract allowlist
  → ModelOutput.directives: AgentDirective[]
  → AgentRuntime freshness / safety / handler dispatch
  → Application CommandGateway (for routed canonical effects)
  → command receipt / event / durable domain or runtime record
  → bounded Session Observation or Execution settlement
```

Evidence:

- `packages/model-context/src/prepare-turn.ts`, `ModelContextLive.prepareTurn`: gets visible tool refs from `ToolCatalogPort`, resolves their model-facing definitions, and passes those plus the selected program's `outputContract` to `compileTurn` (HEAD lines 127–155).
- `packages/model-context/src/compiler.ts`, `compileTurn`: emits `toolDefinitions` only from `input.plan.tools`; `outputContractRef` is a separate request field. The compiler does not synthesize an `arbor_directive` definition in HEAD (lines 79–116). `git grep` at HEAD finds the reserved `arbor_directive` name in `decode.ts` and test fixtures, not as a production catalog definition or compiler insertion.
- `packages/ports/src/provider.ts`, `CanonicalProviderEvent` / `ProviderPortService`: the provider-facing normalized event is `ToolCallProposed { callRef, toolName, argumentsJson }`; it does not contain an `AgentDirective` (lines 120–154).
- `packages/model-context/src/decode.ts`, `decodeTurn`: interprets an `arbor_directive` proposal as JSON, admits its `_tag` through `OUTPUT_CONTRACTS`, and casts the parsed value to `AgentDirective` (lines 103–159).
- `packages/agent-runtime/src/driver.ts`, `AgentDriverLive.drive`: invokes `decodeTurn`, journals only directive kind metadata, applies freshness and safety handling, then routes by tag to a `DirectiveHandler` or settles (lines 360–383, 415–435, 444–541).
- `apps/single-workspace/src/directives.ts`, `SliceDirectiveHandlers` and per-kind factories: supplies the application-specific handler implementations; those handlers may call `CommandGateway` and return bounded observations (lines 42–48, 91–210, 383–391).

Two current implementation limits materially affect the contract claim:

1. The HEAD compiler does not add the reserved directive schema. Unless a runtime catalog independently supplies a definition named `arbor_directive`, the request has no compiler-supplied schema for that output. The working-tree edit to `packages/model-context/src/compiler.ts` does add such behavior, but it is uncommitted and excluded from this baseline.
2. `decodeTurn` is not a complete branch-payload validator at HEAD. It checks JSON parseability and the output-contract tag allowlist, then casts the object. `unknown` payloads such as `spec` and `request` further defer shape checking. Therefore “validated AgentDirective” in P3 design prose is stronger than this exact code path. A future codec must fail closed on missing or invalid semantic input before binding Runtime facts.

### Definition, consumers, and package boundary

| Question | Clean-HEAD finding | Evidence |
|---|---|---|
| Where is it defined? | As a TypeScript discriminated union in `@arbor/model-context`; v1 has 10 tags. It is exported through that package's `index.ts`. | `packages/model-context/src/decode.ts:9-70`; `packages/model-context/src/index.ts:1-10` |
| Who consumes it? | `@arbor/agent-runtime` imports it for `DirectiveHandler.kind`, handler inputs, and freshness classification. The single-workspace application constructs handlers. | `packages/agent-runtime/src/directive.ts:6,29-35`; `packages/agent-runtime/src/freshness.ts:1,12-25`; `apps/single-workspace/src/directives.ts:1-48` |
| Does it cross a boundary? | Yes, a package boundary inside one process: model-context returns it and agent-runtime consumes it. It is not a cross-process provider/API message. | `packages/agent-runtime/package.json:15-20`; `packages/ports/src/provider.ts:120-154` |
| What runtime work does the common union enable? | One per-turn loop can classify freshness, apply common safety admission for selected tags, special-case settle-producing actions, search a typed handler registry, and normalize handler outcomes. | `packages/agent-runtime/src/freshness.ts:12-25`; `packages/agent-runtime/src/driver.ts:444-541`; `packages/agent-runtime/src/directive.ts:20-35` |
| Is handling exhaustive? | Not currently. `handlers.find` may miss a tag and yields a non-fatal `DirectiveUnsupported`; the union constrains handler tag spelling but does not statically require every branch to have a handler. | `packages/agent-runtime/src/driver.ts:507-516`; `packages/agent-runtime/src/directive.ts:29-35` |

### Persistence, wire status, and replay

| Question | Finding | Evidence |
|---|---|---|
| Is the full directive persisted? | No. `ModelOutput` session entry stores `providerTurnId`, `outputContractRef`, and `directiveKinds`; it does not store the semantic arguments or serialized directive. | `packages/agent-runtime/src/driver.ts:415-435` |
| Is the output contract reference persisted? | Yes. `ProviderTurnRecord` and the SQLite `provider_turns` row contain `outputContractRef`; the manifest also carries it. This is provenance/version metadata, not persistence of the directive value. | `packages/ports/src/provider.ts:199-207`; `adapters/persistence-sqlite/src/migrations.ts:258-299`; `packages/model-context/src/compiler.ts:40-63,118-140` |
| Is the action itself in a durable event/journal? | Not as a uniform `AgentDirective` record. Durable effects are recorded through their owning boundary: commands/receipts/events, runtime records, and Execution settlement. Completion settlement carries `CompletionClaimed` data; the provider output union itself is not the event. | `packages/agent-runtime/src/driver.ts:462-479`; `packages/application/src/gateway.ts:220-345`; P3 `03-agent-loop-driver.md:23-25,96-110` |
| Is full decision replay required by recovery? | No requirement found in the inspected P3/P9/P12 persistence path. Recovery inspects unsettled ProviderTurn attempts and durable command/domain/execution facts; it does not reload a serialized AgentDirective and re-execute it. | `packages/ports/src/provider.ts:214-225`; `adapters/persistence-sqlite/src/provider-turns.ts:109-155`; `planning/phases/P3.md`; P9 recovery tests `tests/p9-recovery-driver.test.ts`, `tests/p9-worker-crash.test.ts` |
| Is `agent-directive-v1` a public wire contract? | No public HTTP, plugin, or cross-process consumer was found. It is an internal output-contract reference used by model context, provider-turn metadata, and session metadata. The package is private. | `packages/model-context/package.json:2-10`; `packages/model-context/src/decode.ts:47-70`; `packages/ports/src/provider.ts:52-59,199-207` |
| Would a v1/v2 migration need to rewrite full old directive payloads? | No old full payload is persisted in the inspected schema. Historical output-contract refs and directive-kind summaries would remain readable metadata; no directive decoder/replay migration is evidenced. | `packages/agent-runtime/src/driver.ts:415-435`; `adapters/persistence-sqlite/src/provider-turns.ts:30-38,109-155` |

The session transcript is not a command journal. Its `ModelOutput` row is useful for identifying the output contract and selected action kinds, but it is insufficient to answer “what exact arguments did the model request?” after the fact. That audit need, if required, must be designed explicitly; making the action union versioned does not solve it.

## Frozen-design comparison

The frozen DID says the Agent produces structured `AgentDirective` values and names the directive loop in §8.15 and §10.6. P3 `03-agent-loop-driver.md` likewise specifies `decodeTurn → validated AgentDirective → owning boundary`. DID §10.6 assigns prompt composition, context selection, tool exposure, and model-family semantic adaptation to Model Context rather than AgentRuntime.

This is stronger than the current implementation's persistence and wire requirements: design freezes a semantic execution interface, but not a durable public `AgentDirective` transport. An internal ADT can preserve the semantic interface while changing where model-specific decoding ends and runtime routing begins, subject to manual supersession of the frozen design.

## Findings

1. Arbor needs a typed semantic action boundary and deterministic Application/Runtime enforcement.
2. Current `AgentDirective` is in-process and transient, not a public wire or replay record.
3. Versioned `agent-directive-v2` would be another canonical action representation without a demonstrated persistence or interoperability consumer.
4. A private `AgentAction` ADT is useful because the driver performs common action-level control work today.
5. The implementation gap between the frozen P3 description and HEAD `decodeTurn` is validation completeness; this is not evidence that the union must be a versioned wire contract.
6. This review recommends no production action. The repository's uncommitted changes are not accepted as a baseline or evidence of production state.

## Evidence index

- Current type/decode: `packages/model-context/src/decode.ts`, `decodeTurn`, `OUTPUT_CONTRACTS`; tests: `packages/model-context/test/p3-decode.test.ts`.
- Runtime dispatch: `packages/agent-runtime/src/driver.ts`, `AgentDriverLive.drive`; `packages/agent-runtime/src/directive.ts`; tests: `tests/p3-driver.test.ts`, `tests/p3-freshness.test.ts`.
- Provider/output persistence: `packages/ports/src/provider.ts`, `ProviderTurnRecord`; `adapters/persistence-sqlite/src/provider-turns.ts`; SQLite schema in `adapters/persistence-sqlite/src/migrations.ts`; session writes in `packages/agent-runtime/src/driver.ts`.
- Frozen requirements: DID v1.17 §8.15, §8.19, §10.6; P3 `03-agent-loop-driver.md`; P4 `01-tool-contracts.md`; P6 `02-communication-protocol.md`; P8 `01-verification-commands.md`.
