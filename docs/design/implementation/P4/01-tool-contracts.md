# P4 — 01 Tool Contracts

**Authority:** DID v1.40 §6A.7/§9.12; DID v1.8 §7.6; SD v1.15 §6.5/§6.6; G1/G5/G6.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

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
- `ToolCatalogPort` (P3-002) resolves the **model-facing `ToolDefinition`**
  (`visibleRefs()` + `resolveForModel(ref)`), not refs-only. P4 owns the full
  `ToolDefinition` record and a `ToolDefinitionStore`; the ref
  `ToolDefinitionRef { name, version, hash }` and the full record share the same
  `(name, version, hash)` identity. `ModelContext` decides visibility;
  `ToolRuntime` decides authorization (DID §7.6).
- **P12 TR-11 propagation (P12 `07` §1/§2; DID v1.14 G3).** DID §7.6 is
  authoritative: Model Context obtains the model-facing projection (real
  `description` / schema / version / hash / `capabilityMetadata` /
  `sideEffectSemantics`) via `ToolCatalogPort`; the inherited refs-only
  narrowing and model-context placeholders are the P12-corrected inherited
  defect. `resolveForModel(unregistered)` fails with a typed `ToolNotRegistered`
  and never fabricates a placeholder. `ToolRuntimePort` remains the invocation
  contract (unchanged).

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
  readonly approvalId: string | null;        // Runtime-selected Executable approval
  readonly approvalRevision: number | null;  // exact Approved CAS revision; Runtime-only
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
  /** Runtime-owned active ExecutionOrigin lease; production requires all fields. */
  readonly executionFence: {
    readonly executionId: ExecutionId;
    readonly workerId: string;
    readonly workerIncarnationId: string;
    readonly fencingGeneration: LeaseGeneration;
  };
  readonly requestedAt: string;
}
```

The lease tuple comes only from the current `ExecutionOrigin` supplied by
`runExecution` and copied by the Executable Tool Handler. It is never decoded
from model arguments, ToolIntent or approval payload. Production fails closed
if any tuple member is absent. P4 passes the same tuple to each fenced durable
mutation; it does not extend authority beyond the active Execution.
The model/provider output cannot supply `approvalId` or `approvalRevision`;
the handler populates both only from the Runtime-owned Executable approval
ledger when resuming the same pinned LogicalAction.

## 4. CanonicalToolObservation

```ts
type CanonicalToolObservation =
  | { readonly _tag: "Success"; readonly observation: BoundedObservation;
      readonly resultRef: string | null }
  | { readonly _tag: "ExpectedFailure"; readonly observation: BoundedObservation }
  | {
      readonly _tag: "Denied";
      readonly reasonCode: PersistedNoEffectDenialCode;
      readonly reason: string;
    }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "OutcomeUnknown"; readonly reconciliationRefs: ReadonlyArray<InvocationRef> }
  | {
      readonly _tag: "ReconciledNoEffect";
      readonly reasonCode: ReconciledNoEffectCode;
      readonly reconciliationFactRef: ReconciliationFactId;
      readonly observation: BoundedObservation;
      readonly resultRef: ArtifactRef;
    }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };

interface BoundedObservation {
  readonly text: string;             // model-visible, size-bounded
  readonly truncated: boolean;
}

/** Trusted P4 handoff data; P3/Application adds the logical-step/action identity. */
interface ResolvedExecutableIntentForApproval {
  readonly intent: ToolIntent;
  readonly actionDigest: string;
  readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
  readonly sideEffectSemantics: SideEffectSemantics;
}

type ToolRuntimeOutcome =
  | CanonicalToolObservation
  | { readonly _tag: "ApprovalRequired";
      readonly resolvedIntent: ResolvedExecutableIntentForApproval };
```

`NoEffectDenialCode` is closed:

```ts
type NoEffectDenialCode =
  | "InvocationAuthorityDenied"
  | "ApprovalRejected"
  | "ApprovalNotFound"
  | "ApprovalMismatch"
  | "ApprovalExpired"
  | "ApprovalConsumedByOtherInvocation"
  | "ResourceResolutionDenied"
  | "ResourceAdmissionDenied"
  | "ApprovalNoLongerAuthorized";

/** Historical persisted-row compatibility only; never written by new P4 paths. */
type LegacyNoEffectDenialCode = "ApprovalRequired";
type PersistedNoEffectDenialCode =
  | NoEffectDenialCode
  | LegacyNoEffectDenialCode;
```

The version-1 Denied projection maps each code to a fixed bounded Runtime
observation. The stored reason code, rather than mutable current policy or
error text, determines replay.

- `Denied` is the model-visible `ToolInvocationDenied` projection (DID §6A.7),
  not an Execution failure.
- Historical `Denied(ApprovalRequired)` values decode and replay their exact
  terminal result only. New approval-required calls use the nonterminal
  `ApprovalRequired` handoff in `02`; they are not new-write denials.
- Large raw results live behind `resultRef` (Artifact), never in the observation
  (SD §6.6).

## 5. ToolInvocationSettlement

```ts
type ToolInvocationSettlement =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ExpectedFailure" }
  | {
      readonly _tag: "Denied";
      readonly reasonCode: NoEffectDenialCode;
    }
  | {
      readonly _tag: "ReconciledNoEffect";
      readonly reasonCode: ReconciledNoEffectCode;
      readonly reconciliationFactRef: ReconciliationFactId;
    }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "OutcomeUnknown"; readonly reconciliationRefs: ReadonlyArray<InvocationRef> }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };

/** Row-decoder union: the legacy code is read/replay-only, never newly written. */
type PersistedToolInvocationSettlement =
  | Exclude<ToolInvocationSettlement, { readonly _tag: "Denied" }>
  | { readonly _tag: "Denied";
      readonly reasonCode: PersistedNoEffectDenialCode };

type ReconciledNoEffectCode =
  | "AuthoritySnapshotChanged"
  | "ResourceSnapshotChanged"
  | "ApprovalNoLongerAuthorized"
  | "StopRequested"
  | "ReplayLimitReached";

type ReconciliationUnknownCode =
  | "ProfileUnavailable"
  | "EffectIdentityUnavailable"
  | "ExternalSourceUnavailable"
  | "ExternalSourceNotAuthoritative"
  | "EvidenceStale"
  | "EvidenceBindingMismatch"
  | "AttemptNotFinal"
  | "ResultEvidenceUnavailable"
  | "ProfileVersionUnavailable";

type ToolReconciliationResult =
  | { readonly _tag: "NotOccurred"; readonly proof: ReconciliationProofRef }
  | { readonly _tag: "Occurred";
      readonly proof: ReconciliationProofRef;
      readonly settlement: "Success" | "ExpectedFailure";
      readonly resultRef: ArtifactRef }
  | { readonly _tag: "StillUnknown";
      readonly reasonCode: ReconciliationUnknownCode;
      readonly evidenceRef: ArtifactRef | null };
```

`No result != No effect` (SD §6.5): an `OutcomeUnknown` invocation may still have
produced an external effect and must not be retried blindly.

`Denied` is a durable no-effect terminal result and is valid only while
`effect_admission_state = NotAdmitted`. It is distinct from
`ExpectedFailure` (the tool ran and reported a normal failure) and
`OutcomeUnknown` (the effect may have happened). `Interrupted` is the existing
stop/quiescence terminal result; it is not a Denied code.

`ReconciledNoEffect` is a distinct terminal observation/settlement for a
`MayHaveStarted` invocation only when its same-attempt immutable fact proves
`NotOccurred`; it is never P4 `Denied` and never resets admission state.
Reconciliation-produced terminal `Success`, `ExpectedFailure`, or
`ReconciledNoEffect` carries the selected same-invocation/same-attempt fact
reference. Ordinary terminal settlements and migrated P36 terminal history do
not acquire a selected fact. Late contradictory evidence is appended as
`PostTerminalEvidence` and cannot replace the selected fact or rewrite the
settlement.

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
