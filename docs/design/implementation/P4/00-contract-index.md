# P4 — Contract Index

**Authority:** DID v1.8 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P4-owned implementation contracts authorized
by DID §13.

```text
Detailed Implementation Design v1.8 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P4/**   (these contracts)
```

## Documents

| Doc | Owns |
|---|---|
| `01-tool-contracts.md` | `ToolDefinition`, `ToolIntent`, `ToolExecutionContext`, `CanonicalToolObservation`, `SideEffectSemantics`, `ToolInvocationSettlement` |
| `02-tool-runtime-pipeline.md` | the SD §6.5 pipeline; `ToolRuntimePort.invoke`; `ToolInvocationDenied`; bounded observation |
| `03-authority-permission-approval.md` | trusted `InvocationAuthority` fact, capability-ceiling exact-match, `InvocationApproval` + atomic consumption |
| `04-sandbox.md` | `SandboxPort` contract + minimal local executor |
| `05-resource-admission.md` | validate-only `ResourceOwnership ⊆ ResourceBoundary`; canonical region resolution |
| `06-invocation-persistence-reconciliation.md` | `tool_invocations` DDL + `ToolInvocationStore`; `SideEffectSemantics` snapshot; P2 `ReconciliationSource` implementation |
| `07-blob-artifact.md` | `Artifact` domain type, `BlobStorePort`, `ArtifactMetadataRepository`, `ArtifactService` |
| `08-minimal-tools.md` | versioned `read` / `patch` / `shell` tool contract artifacts + shell policy enforcement |
| `00-contract-index.md` | this index |

## P4 scope (DID §11 P4)

`ToolCatalogPort / Tool definitions`, `Authority / Permission`,
`ResourceBoundary / ResourceAddress resolution`, `Sandbox`,
`ToolInvocation persistence`, `Blob/Artifact service`,
`read / patch / shell minimal tools`.

## DID v1.8 governance inputs

| Ruling | Closed by |
|---|---|
| G1 trusted `InvocationAuthority` fact (resolver deferred) | `03` §2–§3 |
| G2 Exact-Intent Approval, atomic single consumption | `03` §4 |
| G3 P4 `SandboxPort` + minimal executor; P11 advanced | `04` |
| G4 Resource Admission validate-only | `05` |
| G5 `read`/`patch`/`shell` versioned contract artifacts | `08` |
| G6 tool schemas + shell policy enforcement are P4 contract | `01`, `08` |

## Seams (inherited)

- **P3 → P4**: `AgentDirective.InvokeTool { callRef, toolName, argumentsJson }` →
  `ToolRuntimePort.invoke` → `CanonicalToolObservation` → P3 Session `Observation`.
- **P2 safety gate**: the P3 driver calls `RuntimeSafetyGate.admitActivity` before
  any admission; a safety `Stop` prevents P4 admission.
- **P2 Stop → reconciliation**: in-flight invocations cancel/confirm/reconcile by
  `SideEffectSemantics`; unresolved → `OutcomeUnknown(ReconciliationRequired)`;
  P4 implements the P2 `ReconciliationSource`.
- **P1/P2 resource model**: `ProjectEnvironmentPort` resolver + `CanonicalResourceRegion`
  algebra + `ResourceOwnershipRepository`/`OwnershipWriteService`.
- **P3 `ToolCatalogPort`** contract (declared in P3-002) is implemented by P4.

## Contract review (round 1)

| # | Finding | Classification | Resolution |
|---|---|---|---|
| F1 | `ToolExecutionContext.controlBasis: ControlBasis` would require `tool-runtime -> model-context` (forbidden by DID §10.4.1) | P4 phase-scoped | replaced with `controlBasisDigest: string` (`01` §3); `InvocationAuthority` binds the digest (`03` §2) |
| F2 | P3 `ToolCatalogPort` returns refs, but P4 needs full `ToolDefinition` | P4 phase-scoped | P4 owns the full `ToolDefinition` + `ToolDefinitionStore`; identity `(name, version, hash)` shared with the P3 ref (`01` §1). **P12 TR-11 propagation:** DID §7.6 is authoritative — `ToolCatalogPort` resolves the model-facing `ToolDefinition` (`visibleRefs()` / `resolveForModel()`), not refs-only (`01` §1; `P12 07`) |
| F3 | P4 port errors (`ToolRuntimeError`, `SandboxError`, `ResourceAdmissionError`, `ToolInvocationStoreError`, `ArtifactError`, `BlobStoreError`) | P4 phase-scoped | declared in `ports` (P4-002) |
| F4 | `ToolInvocationIntent` / `ToolInvocationRecord` shapes | P4 phase-scoped | declared in `ports` (P4-002) |
| F5 | `shell` policy allow/deny lists and limits | implementation/empirical | mechanism is contract (`08` §4); lists/numbers empirical |

**Blocking = 0.** No open P4 Design Gap.

## Implementation reconciliation (post-acceptance)

| Deviation | Owning contract |
|---|---|
| `InvocationAuthority.allowedCapabilities` | `03` §2 |
| `ToolExecutionContext.authenticatedPrincipal` | `01` §3 |
| `ToolIntent.approvalId` | `01` §3 |
| per-intent approval predicate (`shell` destructive) | `02` §2, `08` §4 |

## Status

FROZEN (contracts) — independent review round 1 complete, **Blocking = 0**;
implementation reconciliation applied. **FORMALLY CLOSED.**
