# P5 — 03 Directive Handling

**Authority:** DID v1.9 §8.15, §11 P5, G3; P3 `03`, P4 `02`.
**Status:** DRAFT (first draft for contract review).

## 1. `DirectiveUnsupported` (G3)

A directive whose owning phase is not implemented in the running slice returns a
**non-fatal, model-visible `DirectiveUnsupported` directive execution result**:

```ts
interface DirectiveUnsupported {
  readonly _tag: "DirectiveUnsupported";
  readonly directiveKind: string;     // e.g. "ProposeChildWorkspace"
  readonly reason: string;
}
```

- It belongs to the **directive execution result / model-visible observation
  vocabulary** (like `CanonicalToolObservation`); it is **not** an
  `AgentDirective`, `DomainError`, `CommandRejection`, or Execution failure.
- It does not fail the Execution; the driver appends it as a Session
  `Observation` (`Observation.source = "Runtime"`) and continues the loop.

## 2. Supported / unsupported set in P5

| Directive | P5 handling |
|---|---|
| `InvokeTool` | P4 `ToolRuntimePort.invoke` |
| `Communicate` | recorded as an Observation (no outbound routing in P5) |
| `LoadSkill` | P3 Skills surface (`progressiveLoad`) |
| `ChangeMode` | updates `AgentExecutionState.currentMode` |
| `Yield` | `Completed(Yielded(reason, waitSpec))` (P2 WorkWait) |
| `CompletionClaim` | `Completed(CompletionClaimed)` (Execution only; `04` §3) |
| `RequestGovernance` | recorded as an Observation; no governance routing in P5 |
| `ProposeChildWorkspace` | **`DirectiveUnsupported`** (P6) |
| `SpawnSpecialist` | **`DirectiveUnsupported`** (P6) |
| `DeclareDependency` | **`DirectiveUnsupported`** (P7) |

## 3. Driver integration

- P3's `decodeTurn` still validates directives against the Output Contract; P5
  does not change the decoder.
- After decoding, the driver maps each directive to its handler; an unsupported
  kind yields `DirectiveUnsupported` rather than an error.
- `DirectiveUnsupported` is never surfaced as `Denied`/`AuthorityDenied`.

## 4. Must Not Decide

- No `ProposeChildWorkspace` / `SpawnSpecialist` semantics (P6).
- No `DeclareDependency` semantics (P7).
- No governance routing (later phase).
- No change to the `AgentDirective` set or the Output Contract.
