# P4 — 01 Tool Contracts

**Authority:** DID v1.8 §7.6, §6A.7, §9.12; SD v1.3 §6.5/§6.6; G1/G5/G6.
**Status:** DRAFT (first draft for contract review).

## 1. ToolDefinition (catalog contract)

```ts
interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly description: string;                  // model-facing
  readonly inputSchemaJson: string;              // exact P4 contract (G6)
  readonly resultSchemaJson: string;             // exact P4 contract (G6)
  readonly capabilityMetadata: ReadonlyArray<string>;
  readonly sideEffectSemantics: SideEffectSemantics;
  readonly source: "Builtin" | "Project";
}
```

- `inputSchemaJson` / `resultSchemaJson` are the **frozen exact schemas** for the
  tool version (G6) — not implementation choice.
- `ToolCatalogPort` (P3-002) returns `ToolDefinitionRef { name, version, hash }`
  for the model-visible tool surface. P4 owns the full `ToolDefinition` record
  and a `ToolDefinitionStore`; the ref and the full record share the same
  `(name, version, hash)` identity. `ModelContext` decides visibility;
  `ToolRuntime` decides authorization (DID §7.6).

## 2. SideEffectSemantics

```ts
type SideEffectSemantics =
  | "ReadOnly"
  | "Idempotent"
  | "Reconcilable"
  | "NonIdempotent";
```

Retry rule (DID §6A.7):

```text
ReadOnly      -> transient retry allowed
Idempotent    -> same invocation key replay allowed
Reconcilable  -> reconcile before deciding replay
NonIdempotent -> automatic replay forbidden on ambiguity
```

## 3. ToolIntent / ToolExecutionContext

```ts
interface ToolIntent {
  readonly callRef: string;              // from AgentDirective.InvokeTool
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argumentsJson: string;
  readonly invocationId: ToolInvocationId;   // caller-preallocated
}

interface ToolExecutionContext {
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly authenticatedPrincipal: Principal;
  readonly authority: InvocationAuthority;   // 03 §2
  readonly controlBasisDigest: string;       // digest of the P3 manifest ControlBasis
  readonly requestedAt: string;
}
```

## 4. CanonicalToolObservation

```ts
type CanonicalToolObservation =
  | { readonly _tag: "Success"; readonly observation: BoundedObservation;
      readonly resultRef: string | null }
  | { readonly _tag: "ExpectedFailure"; readonly observation: BoundedObservation }
  | { readonly _tag: "Denied"; readonly reason: string }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "OutcomeUnknown"; readonly reconciliationRefs: ReadonlyArray<InvocationRef> }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };

interface BoundedObservation {
  readonly text: string;             // model-visible, size-bounded
  readonly truncated: boolean;
}
```

- `Denied` is the model-visible `ToolInvocationDenied` projection (DID §6A.7),
  not an Execution failure.
- Large raw results live behind `resultRef` (Artifact), never in the observation
  (SD §6.6).

## 5. ToolInvocationSettlement

```ts
type ToolInvocationSettlement =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ExpectedFailure" }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "OutcomeUnknown"; readonly reconciliationRefs: ReadonlyArray<InvocationRef> }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };
```

`No result != No effect` (SD §6.5): an `OutcomeUnknown` invocation may still have
produced an external effect and must not be retried blindly.

## 6. Effect channels

```text
ToolRuntimePort.invoke(intent, context)
  A = CanonicalToolObservation
  E = ToolRuntimeError (narrow, translated; no universal error)
  R = ToolCatalogPort | SandboxPort | BlobStorePort | ArtifactService
      | ProjectEnvironmentPort | ResourceOwnershipRepository | Clock | IdGenerator
```

Adapter/SDK errors are translated at the adapter boundary (DID §0A.6).

## 7. Must Not Decide

- No PermissionGrant / Parent / User resolution (G1; `03`).
- No ownership mutation (G4; `05`).
- No Model Context / prompt semantics (P3).
- No verification verdict (P8).
- No environment/git-specific behavior (P11).
