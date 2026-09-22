# P3 — 01 Provider Contracts

**Authority:** DID v1.7 §6A.8, §6A.9, §7.5, §7.9, §9.10, §9.11; SD v1.3 §6.1–§6.4, §13.7.
**Status:** DRAFT (first draft for contract review).

## 1. ProviderPort

```ts
interface ProviderPortService {
  readonly runTurn: (input: {
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => Stream.Stream<CanonicalProviderEvent, ProviderFailure>;
}
```

- `runTurn` is the **only** surface `agent-runtime` sees (DID §7.5).
- **P12 B-4 propagation (implementation port surface, no semantic change):** `runTurn`
  resolves to a `ProviderRunResult { events; attemptNo }` so the driver can report the real
  Turn-local provider retry ordinal as `RuntimeSafetyObservation.retryCount` (P12 `08` §7,
  DID §6A.9: provider retry never creates a new `ProviderTurn`). The event stream and error
  channel are unchanged.
- `ProviderRuntime` owns transport, auth, streaming, timeout, safe retry,
  protocol normalization and usage extraction; it never rewrites Arbor
  instruction semantics.
- The port `E` is `ProviderFailure` (narrow, normalized); SDK/transport errors
  are translated at the adapter boundary and never leak.

## 2. Request / execution context

```ts
interface PortableModelRequest {
  readonly modelRef: string;
  readonly instructions: ReadonlyArray<PortableInstruction>;
  readonly messages: ReadonlyArray<PortableMessage>;
  readonly toolDefinitions: ReadonlyArray<PortableToolDefinition>;
  readonly outputContractRef: string;
  readonly budget: { readonly maxOutputTokens: number };
  readonly cacheHints: ReadonlyArray<CacheHint>;
}

interface ProviderExecutionContext {
  readonly providerTurnId: ProviderTurnId;
  readonly attemptNo: number;
  readonly secretRef: SecretRef;
  readonly timeoutMs: number;
  readonly cancellation: CancellationRef;
}
```

`PortableModelRequest` is model-family neutral; the model-family compiler
(`05` §5) produces it from a `PreparedModelTurn`.

`SecretRef` is a P3 `ports`-level opaque reference (DID §7.9); the raw
credential is resolved only inside the ProviderRuntime adapter. `ProviderTurnId`
is a domain ID (`ptn_`); `CancellationRef` and `CacheHint` are P3 port types.

## 3. CanonicalProviderEvent (frozen ADT — C4)

Provider events are **normalized transport/runtime vocabulary**. They must
**not** directly express an `AgentDirective`; decoding a proposal into a
validated directive is the AgentRuntime/ModelContext job (`03` §3).

```ts
type CanonicalProviderEvent =
  | { readonly _tag: "TurnStarted"; readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number; readonly modelRef: string }
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "ReasoningDelta"; readonly text: string }
  | { readonly _tag: "ToolCallProposed"; readonly callRef: string;
      readonly toolName: string; readonly argumentsJson: string }
  | { readonly _tag: "UsageReported"; readonly inputTokens: number;
      readonly outputTokens: number; readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number }
  | { readonly _tag: "ContinuationState"; readonly stateRef: string }
  | { readonly _tag: "TurnCompleted"; readonly finishReason: ProviderFinishReason }
  | { readonly _tag: "TurnFailed"; readonly failureKind: ProviderFailureKind };

type ProviderFinishReason =
  | "Stop" | "MaxOutputTokens" | "ToolCall" | "ContentFilter";
```

- `ToolCallProposed` is a **raw model proposal**, not an authorized invocation
  and not an `AgentDirective`.
- Streaming deltas (`TextDelta` / `ReasoningDelta`) never enter Session history
  (DID §9.8); only a decoded `ModelOutput` entry does.
- `ContinuationState` carries provider continuation metadata for multi-turn
  continuity; it is opaque to Model Context.

## 4. ProviderRuntime responsibilities

```text
transport / connection
auth (via SecretStorePort; raw credential never reaches the Agent)
streaming assembly + backpressure
timeout
safe retry -> ProviderAttempt (Turn-local ordinal)
protocol normalization -> CanonicalProviderEvent
usage extraction -> UsageReported
cancellation propagation
```

Provider retry never creates a new `ProviderTurn` and never increments the
Agent `turnNo` (DID §6A.9).

## 5. ProviderTurn vs ProviderAttempt

- `ProviderTurn` = one logical model decision, bound to exactly one
  `ModelContextManifest` and one Output Contract (DID §6A.9, §9.10).
- `ProviderAttempt` = a transport attempt under that Turn; `attempt_no` is
  Turn-local (from 0).
- The Turn intent + Manifest are persisted **before** the provider request
  (`04` §3).
- `UsageReported` aggregates per Turn (sum over attempts).

## 6. Provider failure model (DID §6A.8)

```ts
type ProviderFailureKind =
  | "RateLimited"
  | "ProviderUnavailable"
  | "AuthenticationFailed"
  | "RequestRejected"
  | "StreamInterrupted"
  | "ProtocolViolation";
```

- `ModelOutputContractViolation` is **not** a provider transport failure; it is
  a Model Context / Agent Runtime concern (`06` §3).
- `AuthenticationFailed` / `RequestRejected` are non-retryable at the transport
  layer; `RateLimited` / `ProviderUnavailable` / `StreamInterrupted` may retry
  under the safe-retry policy; `ProtocolViolation` is terminal for the Turn.

## 7. Streaming, cancellation, and Stop

- A `StopExecution` (P2) closes admission of new ProviderTurns; an in-flight
  Turn is cancelled through `ProviderExecutionContext.cancellation`.
- A cancelled Turn ends with `TurnFailed("StreamInterrupted")` or a controlled
  interruption; it never produces a partial `AgentDirective`.
- Streaming deltas are transient; only the settled Turn produces Session entries.

## 8. ModelCapabilityPort

```ts
interface ModelCapabilityPortService {
  readonly resolve: (input: {
    readonly binding: AgentBinding;
    readonly cognitiveMode: string;
    readonly requiredCapabilities: ReadonlyArray<string>;
  }) => Effect.Effect<ModelCapability, ModelCapabilityError>;
}
```

- Model selection is deterministic Runtime (SD §6.2), not an LLM decision.
- `ModelCapability` carries `modelRef`, context window, output ceiling,
  supported tool-call protocol, and model-family tag used by the compiler.

## 9. SecretStorePort

- Provider credentials are referenced by `SecretRef` only (DID §7.9).
- The ProviderRuntime resolves the credential at the execution boundary; the
  Agent and Model Context never receive raw secrets.

## 10. Must Not Decide

- No `AgentDirective` in `CanonicalProviderEvent`.
- No tool authorization/execution (P4 `ToolRuntimePort`).
- No prompt text (P3 `05` / feature phases).
- No Session/Epoch/Checkpoint persistence (P2).
- No Context selection policy (P3 `02`).
