# P12 — 07 ToolCatalogPort Model-Facing Resolution (G3)

**Authority:** DID v1.14 G3, §7.6, §8.19; P3 `01` §1/§2, P3 `02` §6, P4 `01` §1; P4 `00` F2.
**Status:** DRAFT.

## 1. Inherited defect (frozen correction)

DID §7.6 is authoritative: Model Context obtains, via `ToolCatalogPort`, the
**model-facing `ToolDefinition`** (Schema, description, capability metadata,
SideEffectSemantics, version/hash) — not merely a `ToolDefinitionRef`.

Current inherited defect:

```text
P3/P4 narrowed ToolCatalogPort to ToolDefinitionRef {name, version, hash}
model-context cannot import tool-runtime (DID §10.4.1)
⇒ compiler emits placeholders: description = tool.name, schemaJson = "{}"
```

This is corrected in P12 (P12 completion blocker #2).

## 2. Contract (frozen)

`ToolCatalogPort` must be able to resolve a **model-facing projection** of a
`ToolDefinition`. The concrete shape is frozen as:

```ts
interface ModelFacingToolDefinition {
  readonly name: string;                  // ToolDefinitionRef.name (identity, unchanged)
  readonly description: string;           // ToolDefinition.description
  readonly schemaJson: string;            // := ToolDefinition.inputSchemaJson
  readonly version: string;               // ToolDefinition.version
  readonly hash: string;                  // ToolDefinition.hash
  readonly capabilityMetadata: ReadonlyArray<string>; // ToolDefinition.capabilityMetadata
  readonly sideEffectSemantics: SideEffectSemantics;  // ToolDefinition.sideEffectSemantics
}

type ToolCatalogError =
  | { readonly _tag: "ToolNotRegistered"; readonly ref: ToolDefinitionRef };

interface ToolCatalogPortService {
  // refs eligible for model-facing exposure (catalogued, not turn-filtered)
  readonly visibleRefs: () => Effect.Effect<ReadonlyArray<ToolDefinitionRef>>;
  // model-facing projection for exactly one visible ref
  readonly resolveForModel: (
    ref: ToolDefinitionRef,
  ) => Effect.Effect<ModelFacingToolDefinition, ToolCatalogError>;
}
```

- Mapping is exact and total for a registered ref: `description`, `version`,
  `hash`, `capabilityMetadata` and `sideEffectSemantics` come from the full
  `ToolDefinition` (P4 `01` §1), and `schemaJson := inputSchemaJson` (the
  `PortableToolDefinition` field, P3 `01` §2). DID §7.6 explicitly enumerates
  **capability metadata** and **SideEffectSemantics** as metadata Model Context
  needs via `ToolCatalogPort`; they are model-facing and **are projected**
  (N-01 — do not narrow §7.6). Only `resultSchemaJson` and `source` are not
  model-facing and are not projected.
- `resolveForModel(unregistered)` fails with the typed `ToolNotRegistered`
  error; it never fabricates a placeholder (`description: name`,
  `schemaJson: "{}"`).
- An unregistered ref is absent from `visibleRefs`; `visibleRefs` is the
  renamed inherited `definitions()` surface. It **retains the inherited
  `Effect` channel** of `ToolCatalogPortService.definitions()`
  (`packages/ports/src/provider.ts`): `visibleRefs: () =>
  Effect.Effect<ReadonlyArray<ToolDefinitionRef>>`, not a synchronous accessor
  (N-07).
- **PortableToolDefinition disposition (N4):** `capabilityMetadata` / `sideEffectSemantics`
  are resolved by Model Context for tool-surface/visibility decisions and are **not**
  transmitted in `PortableToolDefinition` (which stays `{name, description, schemaJson}`,
  `packages/ports/src/provider.ts`). If a provider protocol later needs them, widening
  `PortableToolDefinition` is a **declared `ports` revision** (TR-tracked), not implicit.
- **Rename migration (N6):** the inherited `ToolCatalogPortService.definitions()` →
  `visibleRefs` rename (plus the `resolveForModel` addition) affects call sites/suites
  `packages/model-context/src/prepare-turn.ts`, `packages/tool-runtime/src/catalog.ts`,
  `packages/model-context/test/p3-prepare-turn.test.ts`,
  `packages/tool-runtime/test/p4-catalog.test.ts`, `tests/p3-driver.test.ts`,
  `tests/p3-integration.test.ts`; these are migrated in the same P12 change so `pnpm check`
  is green.
- Option chosen: **widen `ToolCatalogPort`** at the `ports` level so
  model-context consumes it through `ports` only.
- model-context **must not** depend on `tool-runtime` implementation (DID §10.4.1
  `model-context !-> tool-runtime`; `model-context -> ports`).
- `ToolRuntimePort` remains the invocation contract (unchanged).

## 3. Compiler requirement

The Model Context compiler must emit the **real** `description` and `schemaJson`
resolved from `ToolCatalogPort.resolveForModel(ref)` — `schemaJson` is the
tool's `inputSchemaJson`; the placeholder (`description:name`,
`schemaJson:"{}"`) is forbidden. The projection is consumed whole:
`capabilityMetadata` and `sideEffectSemantics` are model-facing metadata
(DID §7.6, §2) and must not be dropped by the compiler.

## 4. Invariants

```text
CI-6  no tool placeholder in PortableModelRequest.toolDefinitions
model-context resolves tool metadata via ports only
projection carries description / schema / version / hash / capabilityMetadata / sideEffectSemantics
resolveForModel(unregistered) → ToolNotRegistered; unregistered ref absent from visibleRefs
ToolDefinitionRef identity (name/version/hash) unchanged
visibleRefs retains the inherited Effect channel (not synchronous)
```

## 5. Must Not Decide

- No tool invocation semantics change (P4 unchanged).
- No `model-context -> tool-runtime` dependency.
- No new tool schema authority (P4 owns schemas).

## 6. Verification

```text
compiled request carries real description + schema + version for each visible tool
projection resolves capabilityMetadata + sideEffectSemantics for a visible ref
visibleRefs is an Effect-returning surface (inherited definitions() channel)
model-context package has no tool-runtime dependency (architecture test)
ToolCatalogPort returns model-facing projection for a visible ToolDefinitionRef
resolveForModel(unregistered) → ToolNotRegistered (no placeholder)
unregistered ref absent from visibleRefs
```
