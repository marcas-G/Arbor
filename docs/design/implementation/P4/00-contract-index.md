# P4 — Contract Index

**Authority:** DID v1.40, with P4 phase contracts frozen under DID v1.8 except
where this index records the v1.18 source-of-truth supersession. These
documents are **not** a fifth design layer; they are the P4-owned
implementation contracts authorized by DID §13.

## Accepted owner amendment — AH7-DG-03 (2026-10-10)

Decision: `ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`. The exact accepted
proposal is
`planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.
Acceptance and delegated landing authority are recorded in
`planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md`.

The amendment is limited to P4 `01`/`02`/`03`/`06`: exact approval is consumed
with the intent in one fenced pre-effect claim transaction, separate from
terminal result settlement. It adds typed no-effect `Denied`, the
`effect_admission_state` lifecycle, P4 stop/quiescence admission and the P4
Worker-fencing surfaces. Control `ActionApproval` / AssignWork consumption is
unchanged. No DID version was changed; each owner clause cites this accepted
amendment and its source digest.

## Accepted owner amendment — EA-DG-01 (2026-10-11)

Decision `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`, fixed proposal
SHA-256 `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
acceptance and landing audit:
`planning/results/EA-DG-01-governance-acceptance.md` and
`planning/results/EA-DG-01-contract-landing.result.md`.

The P4 `01`/`02`/`03`/`06` amendment adds a nonterminal Executable
`ApprovalRequired` handoff, exact Runtime-owned action binding, exact Approved
revision in the fenced P4 claim, `ApprovalRejected`, legacy-only replay of
`Denied(ApprovalRequired)`, and the P4 side of forward migration 0038. MAC
owns the shared ActionApproval lifecycle; the Control route and CAPA
AssignWork consume path are unchanged. Migration 0038 depends on integrated
AH7/P36 0036 and AH10 Deliver 0037; no earlier migration is edited. Its
table rebuild preserves 0033's `action_approvals_id_project` composite UNIQUE
key required by the existing AssignWork target-binding foreign key.

## Accepted owner amendment — AH7-DG-02 Reconcilable reality proof / P39

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P4 `01` owns the `ReconciledNoEffect` canonical observation/settlement and
closed proof/reason unions; `02` owns effect/reconcile/replay/Stop ordering;
`03` owns trusted approval revision/subject binding; `06` owns P39 binding,
attempt/fact/selected-fact DDL and transaction/fence rules; `08` owns
shell@3 classification and the constrained-profile gate. P39 is
`0039_ah7_reconciliation_attempts`, after accepted P36/P37/P38 owner contracts;
their migration implementations remain unintegrated and separately gated.

```text
Detailed Implementation Design v1.18 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P4/**   (these contracts)
```

**DID v1.18 ACR supersession:** P4's executable-tool authorization,
ResourceAdmission, sandbox, invocation persistence/reconciliation, and
observation contracts remain unchanged. The P3→P4 model-call bridge through
`AgentDirective.InvokeTool` is historical; the current architecture boundary
is a provider-neutral typed executable `ToolInvocation` routed to the
existing P4 `ToolIntent` / `ToolRuntimePort` path.

## Documents

| Doc | Owns |
|---|---|
| `01-tool-contracts.md` | `ToolDefinition`, `ToolIntent`, `ToolExecutionContext`, `CanonicalToolObservation`, `SideEffectSemantics`, `ToolInvocationSettlement` |
| `02-tool-runtime-pipeline.md` | the SD §6.5 pipeline; `ToolRuntimePort.invoke`; exact approval matching; nonterminal `ApprovalRequired`; terminal no-effect Denied; bounded observation |
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
| G2 Exact-Intent Approval, atomic single consumption in the fenced intent claim (not terminal settlement) | `03` §4, `06` §2–§5 |
| G3 P4 `SandboxPort` + minimal executor; P11 advanced | `04` |
| G4 Resource Admission validate-only | `05` |
| G5 `read`/`patch`/`shell` versioned contract artifacts | `08` |
| G6 tool schemas + shell policy enforcement are P4 contract | `01`, `08` |

## Seams (inherited)

- **P3 → P4**: provider-neutral typed executable `ToolInvocation` →
  existing P4 `ToolIntent` + trusted `ToolExecutionContext` →
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

**DID v1.22 SCRC successor:** `02` §7 freezes callRef-paired Session result
handoff without changing P4's executable ToolRuntime pipeline. Agent Runtime
owns Session append; ToolRuntime remains the authority/effect/settlement owner.
This additive design successor is not SCRC implementation evidence.
