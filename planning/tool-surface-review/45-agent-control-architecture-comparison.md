# Agent Control Architecture Comparison

**Date:** 2026-09-27
**Baseline:** clean production source is `HEAD 063d40d236ef73aa2f007d057f9f6d045512fc21`; uncommitted workspace diffs are excluded.
**Scope:** compare the three architecture options against Arbor's frozen authority, lifecycle, persistence, and tool contracts. No schema or migration is specified here.

## Options

| Option | Boundary |
|---|---|
| **A — `Full Canonical AgentDirective`** | Provider/model-specific representations decode to a formal, versioned canonical directive union; Agent Runtime dispatches the union. |
| **B — `Internal AgentAction ADT`** | Provider/model-specific tool calls decode into a process-local typed `AgentAction`; Runtime applies common control and routes it. The ADT is not a model schema, wire protocol, or persisted record. |
| **C — `Direct Typed Control Tools`** | Each typed control tool is decoded and passed to its typed handler; there is no shared semantic action union. Shared invocation context, authorization, result protocol, and infrastructure remain available. |

The three options do not change the important trust boundary: a model request is intent, never a direct Domain mutation. Each option can preserve Application commands, Runtime bindings, authority validation, and Domain invariants.

## R1–R10 requirement matrix

Legend: **✓** naturally supports with the stated lower-layer enforcement; **△** possible, but requires extra per-tool wiring or an explicit shared mechanism. No union makes a hard security invariant true by itself.

| Requirement | A — Full canonical union | B — Internal ADT | C — Direct handlers |
|---|---|---|---|
| **R1 Model intent vs Domain state** | ✓ Decode intent, then route through Application. Union is not authorization. | ✓ Codec creates intent; handler/Application owns mutations. | ✓ Each handler calls Application; direct model writes remain prohibited. |
| **R2 Runtime binding** | ✓ Bind execution, workspace, principal, authority and revisions after decode. | ✓ Same; invocation context can accompany the ADT. | ✓ Bind these per handler from a common trusted context. |
| **R3 Provider/model independence** | ✓ Compiler can translate provider tools to canonical branches. | ✓ Provider/model tool codecs can translate to internal actions. | ✓ Each provider codec can dispatch a concrete tool directly. |
| **R4 Fail-closed semantic validation** | △ Requires complete branch validation after decoding. HEAD `decodeTurn` currently parses JSON and checks `_tag` allowlisting, then casts. | ✓/△ Each tool codec can validate one shallow shape; Runtime and Application still validate domain preconditions. | ✓/△ Each typed handler can validate its own input. This must not become duplicated or permissive. |
| **R5 Mechanical authority** | ✓ CommandGateway / ToolRuntime / domain checks enforce it; union only identifies intent. | ✓ Same authority mechanisms. | ✓ Same authority mechanisms. |
| **R6 Auditability** | △ A central value is convenient, but current code persists only `directiveKinds`, not arguments or full directive. Explicit audit persistence is still needed. | ✓ One internal action envelope is a natural audit/test seam; actual persistence must still be specified. | △ Each handler can emit an audit record, but uniform logging must be added consistently. |
| **R7 Replay / recovery** | △ Could be replayed only if full values were persisted and replay semantics designed; current design does neither. | ✓ Can remain transient; replay commands/effects and durable settlements as today. | ✓ Same; action objects need not be persisted. |
| **R8 Cross-module boundaries** | △ `model-context` currently owns the union and `agent-runtime` depends on it; model/provider representation and runtime execution semantics are coupled. | ✓ Model Context can emit provider-neutral tool proposals; Agent Runtime owns semantic decode and internal ADT; Application/Domain stay below. | ✓ Strong separation per tool, but common runtime policy may be spread across handlers or metadata. |
| **R9 Deterministic tests** | ✓ Round-trip branch tests and action-to-command tests. | ✓ Codec-to-action and action-to-command tests; shared control tests once. | ✓ Per-codec and per-handler contract tests. |
| **R10 Evolution cost** | △ New branch/version, representation mappings, contract coexistence, and potentially compatibility policy. No full-value history is currently stored. | ✓ Internal ADT evolution has no persisted wire migration. Model-facing tool versions remain independently governed. | ✓ No global action version, but changes touch direct handler wiring and cross-cutting policy registration. |

### Requirement conclusions

- **R1–R5 are enforced below the choice point.** A canonical union does not grant authority or protect canonical state. The CommandGateway validates command authority and idempotency; ToolRuntime validates the authorized tool invocation; Domain transitions validate lifecycle and revision preconditions. Relevant sources are `packages/application/src/gateway.ts`, `packages/application/src/authority-resolver.ts`, P4 `01-tool-contracts.md`, and the command handlers.
- **R6 is not delivered by today's AgentDirective.** The session output entry contains only action kinds. A full A implementation would need a new audit persistence decision just as B or C would. A type name does not preserve arguments.
- **R7 has no demonstrated dependence on replaying model actions.** Arbor's recovery decisions use provider attempts, command receipts, domain events, runtime records, and Execution settlement. If replay becomes a requirement, it should be explicitly designed around idempotent effects and versioned records; no such requirement follows from the current durability architecture.
- **R8–R10 distinguish B and C.** C is a viable architecture and remains maximally per-action. B centralizes semantic policy flow without exposing that shared internal vocabulary as a wire contract.

## Which capabilities need a shared union?

No inspected requirement is impossible without a unified `AgentDirective` or `AgentAction` union. The strongest concrete benefit of a *shared internal ADT* is one semantic action value flowing through common Runtime middleware. HEAD already performs the following cross-cutting actions:

- classifies `FreshnessRequirement` by action kind (`packages/agent-runtime/src/freshness.ts:12-25`);
- performs safety admission around tool/specialist activities and common stale-action re-prepare (`packages/agent-runtime/src/driver.ts:444-507,544-548`);
- routes actions via a typed handler registry and returns one common set of outcomes (`packages/agent-runtime/src/directive.ts:20-35`; driver lines 507-541);
- tests a model-output/action/settlement path using provider-neutral events (`tests/p3-driver.test.ts:290-322,344-400`).

With Option C, equivalent behavior can be implemented by registering per-tool metadata (e.g. activity class and freshness strength) and a common handler decorator. This avoids a semantic union but duplicates action classification between tool registration, policy metadata, and handler code unless one registry is carefully made authoritative. That is a real maintainability cost, but it does not justify Option A's formal versioned contract.

The existing driver is **not fully exhaustive**: missing handlers become `DirectiveUnsupported`; the union does not force every member to be implemented. A future internal ADT could enable stronger exhaustive policy and routing checks, but this has not been implemented or proven by the current driver.

## Wire-contract check

| Contract question | Evidence-based answer |
|---|---|
| Crosses package boundary? | Yes: `model-context` exports the union consumed by `agent-runtime`. |
| Crosses process/provider boundary as `AgentDirective`? | No: the provider port emits generic `CanonicalProviderEvent`; `AgentDirective` is decoded inside the Runtime process. |
| Persisted in full? | No: `ModelOutput` persists only `providerTurnId`, contract ref and directive tags. |
| Needed to re-decode historical actions? | No such consumer found. Historical provider turns retain an output-contract ref and manifest id; they do not retain the full action value. |
| External/public consumer? | None found; `@arbor/model-context` is a private workspace package. |
| Stable JSON representation required? | Provider tool arguments are JSON, but the canonical TypeScript union is not itself an externally consumed stable JSON API at HEAD. |

Therefore the distinction is:

```text
model-facing tool JSON
≠
internal typed action value
≠
durable Application command / Domain event
```

## Complexity comparison

| Cost/capability | A — Full canonical union | B — Internal ADT | C — Direct handlers |
|---|---|---|---|
| Conceptual layers | Tool representation → canonical contract → runtime | Tool representation → codec → internal action → runtime | Tool representation → tool codec/handler → runtime |
| Model schema count | Provider/model profiles still require concrete representations; one union does not remove them | Provider/model-specific tool definitions | Provider/model-specific tool definitions |
| Codec count | One or more per-profile representation decoders plus canonical validation | Per-tool or per-profile codecs to internal action | Per-tool codec into corresponding handler |
| Version burden | Highest: public-looking output-contract versioning plus representation and history policy | Internal type evolution plus tool schema versions; no action-wire coexistence | Tool/handler versions individually |
| Migration burden | Potential coexistence for `agent-directive-v1`/v2 metadata, though full historical directive payloads are absent | No durable action migration; preserve old metadata for reading | No global migration; per-tool compatibility still needed |
| Test burden | Canonical validator + every mapping + command effect | Every codec/action mapping + shared dispatcher/policy tests | Every codec/handler/effect + repeated policy wiring checks |
| Runtime indirection | Highest | Moderate and explicit | Lowest per action |
| Model adaptation | Adapt to canonical branch contract | Adapt to internal action; can use shallow concrete tools | Per-tool adaptation; no common action normalization |
| Audit | Central action record is easy to shape, but must be persisted | Central action record is easy to shape, but must be persisted | Requires common audit decorator or repeated logic |
| Type safety | Strong only if runtime validation is complete; HEAD validation is incomplete | Strong per codec and union dispatch; still needs runtime validation | Strong per codec/handler; errors isolated per tool |
| Extensibility | Add branch and version policy | Add internal action and codec; no persisted contract | Add independent tool/handler; common policy metadata must be wired |

OpenCode's tool runtime separates description, input/output schema, execution, and invocation context; its wrapper decodes input before running the body. Codex's current source uses typed tool handlers together with shared `Approvable` / `Sandboxable` runtime traits and approval/sandbox policy. Arbor can reuse this tool/codec/context/policy split. See the existing local source review in `22-agent-action-inventory.md` and the public OpenCode `packages/core/src/tool/tool.ts` and Codex `codex-rs/core/src/tools/sandboxing.rs` sources; these examples are architectural analogies, not Arbor contracts.

## Arbor-specific work that remains regardless of choice

Codex/OpenCode-style tools provide a useful invocation skeleton, not Arbor's domain semantics. Arbor still needs its own deterministic control for:

- `Responsibility`, `Work`, and Execution lifecycles;
- parent/child governance and authority facts;
- dependency matching and durable waiting;
- verification evidence, verdict aggregation, Acceptance, and completion;
- cross-Workspace communication with durable Inbox/correlation;
- Runtime-bound identities, revisions, principals, idempotency, and recovery;
- separation of visible model tools from authorized invocation.

These are owned by Application, Domain, Runtime, and existing P6/P7/P8 contracts. Their complexity does not imply a model-facing monolithic union.
