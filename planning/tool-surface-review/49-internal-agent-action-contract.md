# Internal AgentAction Contract

**Date:** 2026-09-27
**Status:** Supersession proposal; no production type or frozen contract changed
**Purpose:** Define the intended scope and invariants of the process-local control ADT, not its payload schema.

## Contract boundary

```text
provider/model-facing tool call
  → generic typed ToolInvocation
  → ControlToolRegistry codec
  → internal AgentAction
  → Agent Runtime policy / handler
  → Application Command or Execution settlement
```

`AgentAction` is a discriminated TypeScript ADT owned by Agent Runtime. It is:

- process-local and turn-scoped;
- created only after a registered control-tool codec validates the model's
  semantic arguments;
- accompanied by trusted invocation context rather than containing trusted
  principal, execution, workspace, authority, or revision claims;
- consumed once by common Runtime control middleware and its typed handler.

It is **not** a model-facing schema, a provider output contract, a stable JSON
wire value, a persisted canonical record, or an Application Command DTO.
Application Commands remain the downstream durable request boundary.

## Action membership

The accepted Agent Action Language contains 15 action identities. The internal
control ADT should contain only actions that require Arbor control routing.
“Enter” below means a semantic branch is appropriate in the internal ADT; it
does not close any unresolved payload field or authorize an exposed tool.

| Canonical action | Internal `AgentAction`? | Reason |
|---|---:|---|
| `RespondToHuman` | **No** | This is bounded conversational content and turn completion, not a control transition. Keep it on P14's bounded response channel / model text result. |
| `InvokeTool` | **No** | It is an executable capability invocation. Preserve a typed `ExecutableInvocation`/`ToolIntent` route to ToolRuntime, with common Runtime admission metadata outside the control ADT. |
| `AssignWork` | **Yes** | A control action that requests a Work lifecycle command. `Provenance` mapping remains unresolved at the P1/Application boundary. |
| `Wait` | **Yes** | A control choice that yields/settles and registers a durable wait condition under Runtime rules. |
| `ClaimCompletion` | **Yes** | A control claim that produces the established CompletionClaimed settlement and triggers the existing verification consumer; it does not complete Work. |
| `AcceptWorkOutcome` | **Yes** | A control decision routed to P8/Application acceptance authority and exact revision bindings. |
| `RecordVerificationEvidence` | **Yes** | A verifier control action routed to the P8 evidence command. Exact ToolObservation source identity is still unresolved downstream. |
| `ConcludeVerification` | **Yes** | A verifier control action routed to the P8 conclusion command. Summary persistence/association remains unresolved downstream. |
| `SendMessage` | **Yes** | A durable communication action; Runtime binds communication metadata and sends through P6/Application. `Deliver` remains separate. |
| `DeclareDependency` | **Yes** | A control action requesting a dependency lifecycle transition through P7/Application. |
| `ProduceDeliverable` | **Yes** | A durable P7 result-publication action, distinct from a Report or ordinary artifact write. |
| `RequestDependencyMatch` | **Yes** | Requests deterministic Runtime matching; it does not assert that a Dependency is satisfied. |
| `Deliver` | **Yes** | A separate semantic delivery action whose deterministic downstream realization may use P6 `SendMessage(kind=Deliver)` / P7 contracts. |
| `ProposeChildWorkspace` | **Yes** | A durable responsibility-decomposition control action routed through formation/governance and Application. |
| `SpawnSpecialist` | **Yes** | A temporary ExecutionBound delegation control action; it does not create a durable Workspace. |

**Proposed internal branch count: 13.** The two excluded action identities
remain represented by separate Runtime result/input channels: executable
`ToolIntent` and bounded human-facing `TurnResponse`.

This count is semantic, not a model/tool count. A provider representation may
use several shallow tool names for one action or aliases for one internal
action. It must not alter the action meaning.

## Shared Runtime responsibilities

The ADT gives the Runtime a stable in-process `action kind` for:

1. action-specific freshness requirements;
2. activity/safety admission and loop accounting;
3. uniform handler selection and exhaustive coverage;
4. authority/policy dispatch to existing resolvers and command boundaries;
5. consistent result normalization and next-turn observations;
6. action-class audit and deterministic codec-to-command tests.

These responsibilities do not mean the ADT itself owns the underlying facts:

| Fact or rule | Owner |
|---|---|
| Authenticated principal, current Execution/Workspace/Session, binding and revisions | Runtime / trusted invocation context |
| Authority truth, applicable grants, parent governance, approvals | Authority Resolver / ToolRuntime / Application command rules |
| Domain lifecycle transition and validation | Domain and Application |
| Model's semantic selection/content | Validated action payload |
| Command IDs, message IDs, evidence IDs, timestamps, durable refs | Application/Runtime according to the frozen command contract |

The model-facing tool being visible never proves that it is authorized. The
AgentAction type does not carry an authorization grant and cannot bypass
CommandGateway or ToolRuntime.

## Registry and exhaustiveness invariants

The future ControlToolRegistry is the authoritative control-action registry.
For every exposed control tool:

- exactly one registered codec accepts its model-facing representation;
- codec success constructs exactly one valid internal action kind;
- that action kind maps to one control handler and a declared policy/capability
  classification;
- the action is not sent to ToolRuntime's executable executor;
- Runtime facts are bound from trusted context after decoding;
- failed, ambiguous, unknown, or incomplete semantic input fails closed;
- no omitted field is defaulted or inferred to make a command valid.

For every Action variant that the runtime may produce, the registry must have
an explicit handler or an explicit `not exposed/not executable in this
composition` registration. Missing a handler for a model-exposed control tool
is a composition error, not a routine `DirectiveUnsupported` observation.

One model-facing representation must resolve to no more than one Action
variant. Multiple provider-specific representations may map to the same
variant. If an action's semantic inputs are still under a Design Gap, its
registry entry remains unavailable until that gap is governed; the registry
must not supply a placeholder.

## Provenance and retention

An `AgentAction` may carry a reference to its originating `providerTurnId` and
`toolCallId` in an in-memory invocation envelope for routing and audit
correlation. It must not be serialized wholesale as a new wire contract.

The action object itself is ephemeral. Durable facts remain command receipts,
Domain events, append-only/runtime records, ToolInvocation records, and
Execution settlement. A separate audit projection may capture the minimum
correlation and semantic evidence required by governance; see
`50-control-tool-runtime-boundary.md` §5.

## Validation and tests implied by this contract

Later implementation design must establish:

- per-control-tool codec tests for required/unknown/malformed fields;
- a closed one-to-one tool-representation-to-action mapping test;
- registry completeness tests for exposure, capabilities, policy and handler;
- Runtime binding tests proving model arguments cannot override trusted facts;
- Application command/settlement mapping tests for each implemented action;
- action policy/freshness/admission tests over the internal ADT;
- an audit correlation test from provider call to durable effect.

These are future design constraints only. This document adds no test or runner.
