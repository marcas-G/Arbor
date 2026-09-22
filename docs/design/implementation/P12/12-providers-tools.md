# P12 — 12 Providers / Tools (DID §11 P12 "more providers/tools")

**Authority:** DID v1.14 §11 P12, §7.5, §7.6, §6A.8, §6A.9, §9.10/§9.11, §10.4.1, §13; SD v1.3 §6.1–§6.4, §6.5–§6.7, §8.2; P3 `01` (ProviderPort / CanonicalProviderEvent / ModelCapabilityPort / failure model), P3 `02` §10, P3 `06`; P4 `00` F2, P4 `01`/`02`/`04`/`05`/`08` (G1–G6); P12 `01` §5, P12 `07`.
**Status:** DRAFT.

## 1. Boundary (frozen)

```text
P12 adds real provider adapters + more tools.
ProviderPort / CanonicalProviderEvent semantics are UNCHANGED (P3 `01` §1/§3).
Tool invocation semantics are UNCHANGED (P4 pipeline, `02` §1); P4 G1–G6 stay intact.
New adapters live under `adapters/*` (DID §10.4.1) and are wired only at the Composition Root.
```

## 2. Real provider adapter (beyond `provider-fake`)

```ts
interface ProviderPortService {          // unchanged — P3 `01` §1, DID §7.5
  readonly runTurn: (input: {
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => Stream.Stream<CanonicalProviderEvent, ProviderFailure>;
}
```

- The first concrete real family is **`adapters/provider-openai`**; the pattern generalizes
  to `adapters/provider-<family>`. P12 requires that this adapter:
  - **exists** as a package under `adapters/*` (DID §10.4.1 `adapters/* → domain, ports`);
  - **implements `ProviderPort`** as a `Layer` (the `ProviderPortService` above is unchanged);
  - is **selected at the Composition Root only**, via the model catalog `adapterId` (§3) —
    never auto-discovered, never a runtime/LLM decision;
  - translates adapter-specific SDK/transport errors to `ProviderFailure` at the adapter
    boundary (DID §0A.6, P3 `06` §1) so **no SDK type appears in the error channel**: the
    stream `E` is `ProviderFailure`, never `OpenAISdkError` or a raw transport error.
- Assertion: injecting an SDK error into the adapter surfaces as `ProviderFailure` on the
  `runTurn` error channel, and the `E` type contains no SDK/transport type (DID §0A.6).
- `ProviderRuntime` responsibilities are unchanged: transport / auth / streaming /
  timeout / safe retry / protocol normalization / usage extraction (P3 `01` §4).
- Provider retry never creates a new `ProviderTurn` and never increments the Agent
  `turnNo` (DID §6A.9).
- `provider-fake` remains the deterministic CI double (P5 `01` §4); a real adapter is
  selected at composition, never gating CI.

## 3. Model catalog / model→adapter resolution

```ts
ModelCatalogEntry = {
  modelRef: string
  adapterId: string          // which ProviderPort adapter serves it
  capability: ModelCapability
  priceSheetVersion?: string // usage cost only (see `04` §3); never authority
}
```

- `modelRef` → adapter + capability resolution is **deterministic Runtime** (SD §6.2),
  never an LLM decision; resolution happens at the Composition Root.
- The catalog is declarative config (a `DeclarativePlugin` artifact, `01` §1) — no code
  execution, no new package edge.
- Unknown `modelRef` → typed `ModelCapabilityError`; never a silent fallback to another model.

## 4. `ModelCapabilityPort` real implementation (replaces the static fake)

```ts
interface ModelCapabilityPortService {   // unchanged — P3 `01` §8
  readonly resolve: (input: {
    readonly binding: AgentBinding;
    readonly cognitiveMode: string;
    readonly requiredCapabilities: ReadonlyArray<string>;
  }) => Effect.Effect<ModelCapability, ModelCapabilityError>;
}
```

- P12 supplies the real implementation backed by the model catalog; the test-only static
  `Layer.succeed(ModelCapabilityPort, …)` is replaced at the Composition Root.
- `ModelCapability` keeps its frozen core (`modelRef`, `family`, `contextWindow`,
  `outputCeiling`, `toolProtocol`) and may be extended additively (§5).
- Selection stays deterministic and cannot bypass `A0`–`A3` instruction authority.

## 5. Provider failure vocabulary (closed union) + `ModelCapability` extension

```text
ProviderFailureKind (P3 `01` §6 frozen core; packages/ports/src/provider.ts) :
  RateLimited | ProviderUnavailable | AuthenticationFailed
  | RequestRejected | StreamInterrupted | ProtocolViolation

Classification (R-07 / NEW-10 — corrects the earlier "additive" claim):
  ProviderFailureKind is a CLOSED union. It is exhaustively consumed
  (CanonicalProviderEvent.TurnFailed.failureKind + the retry-disposition mapping,
  P3 `06` §2), so adding / removing / renaming a member is BREAKING for consumers.
  A new member is therefore NOT an additive (MINOR) extension:
    - add a tag        -> MAJOR SPI change  (bump PluginSdkApiVersion MAJOR, `01` §4)
    - remove/rename    -> MAJOR SPI change  (bump PluginSdkApiVersion MAJOR, `01` §4)
  Within one SPI MAJOR the union stays closed. An adapter that observes a
  provider-specific failure class with no frozen tag MUST normalize it to
  ProtocolViolation (terminal) at the adapter boundary — it MUST NOT emit an
  out-of-union value and MUST NOT pass an unknown tag through to consumers.
  The six frozen tags keep their exact retry dispositions (P3 `06` §2):
    retryable : RateLimited | ProviderUnavailable | StreamInterrupted
    terminal  : AuthenticationFailed | RequestRejected | ProtocolViolation
```

- `CanonicalProviderEvent.TurnFailed.failureKind` stays the single carrier; within an SPI
  MAJOR it carries exactly the six frozen tags above.
- **Open vs closed — explicit:** the union is **closed**, with a defined fallback (unknown
  provider-specific class → `ProtocolViolation`/terminal at the adapter boundary). There is
  no open-tag pass-through.
- `ModelCapability` may gain **optional** fields (modality/protocol variants, price-sheet
  reference) — this part is additive/MINOR; existing consumers remain valid. Any
  removal/reinterpretation of `ModelCapability` is a MAJOR change.
- This is a P12 phase contract revision; DID top-level semantics are unchanged.

## 6. Non-`read`/`patch`/`shell` tools via the generic seam

The P4 seam is generic already; P12 adds tools through it without touching the pipeline:

```ts
interface ToolDefinition {              // unchanged — P4 `01` §1
  name; version; hash; description;
  inputSchemaJson; resultSchemaJson;
  capabilityMetadata; sideEffectSemantics;
  source: "Builtin" | "Project";
}

interface ToolExecutor {                // tool-runtime seam (P4 `02` §2)
  name: string;
  write: boolean;
  requiresApproval: (intent: ToolIntent) => boolean;
  execute: (input: { intent; definition; context; sandbox; regions })
    => Effect.Effect<ToolExecutionResult, ToolRuntimeError>;
}
```

- A new builtin tool = one versioned `ToolDefinition` (exact schemas, P4 G6) + one
  `ToolExecutor` registered in the executor list; the frozen P4 pipeline runs unchanged
  (`02` §1: validation → resource resolution → authority → permission/approval → admission
  → sandbox → execute → settlement → bounded observation).
- `SideEffectSemantics` (`ReadOnly | Idempotent | Reconcilable | NonIdempotent`) governs
  retry/replay exactly as frozen (P4 `01` §2).
- **Project tools** enter only via explicit registration (`01` §5); the registered
  `ToolDefinition` is resolved model-facing via `07` (no placeholder schema/description).
- Organizational actions (`create_child`, `assign`, `query_workspace`, `declare_dependency`,
  `report_parent`) remain **not tools** and route through `CommandGateway` (P4 `02` §4).

## 7. P4 G1–G6 boundaries preserved

```text
G1  tool runtime never resolves PermissionGrant / Parent / User; it consumes a trusted
    InvocationAuthority fact (P4 `03` §2)
G2  Exact-Intent Approval record + atomic single consumption unchanged (P4 `03` §4)
G3  SandboxPort + minimal executor; advanced isolation stays P11 (P4 `04`)
G4  Resource admission validate-only; ownership change is a governance Command (P4 `05`)
G5  minimal read/patch/shell remain versioned contract artifacts; new tools are versioned too
G6  tool parameter/result schemas + shell policy enforcement remain P4 contracts
```

## 8. Must Not Decide

- No change to `ProviderPort` / `CanonicalProviderEvent` semantics; no provider protocol
  decision in Domain or Application.
- No tool authorization/execution semantics change; no authority resolution inside tool-runtime.
- No new package category or dependency edge beyond `adapters/* → domain, ports`.
- No LLM-driven model selection; no silent model fallback.
- No concrete allow/deny lists, retry numbers, or model prices (empirical; see `13`).

## 9. Verification

```text
adapters/provider-openai exists; implements ProviderPort; selected at Composition Root only
injected SDK error surfaces as ProviderFailure; E channel contains no SDK/transport type
model catalog resolves modelRef → adapter + capability deterministically; unknown → typed error
ModelCapabilityPort real implementation replaces the static test layer; compiler gets real capability
ProviderFailureKind is closed; add/remove/rename = MAJOR (PluginSdkApiVersion bump);
  unknown provider class normalizes to ProtocolViolation (terminal); six frozen tags keep retry dispositions
a non-read/patch/shell tool runs the unchanged P4 pipeline (authority + sandbox + settlement)
project tool without registration → not visible / not invocable (`01` §5)
model-facing tool metadata is real (no `schemaJson:"{}"` / `description:name`) (`07`)
```
