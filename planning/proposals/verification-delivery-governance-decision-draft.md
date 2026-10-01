# Verification Delivery Governance Decision Draft

**Status:** ACCEPTED / IMPLEMENTATION AUTHORIZED

**Decision token:** `ACCEPT_VERIFICATION_DELIVERY_CONVERGENCE`

**Existing gaps addressed:** G-V2-2, G-V2-3, G-V2-4

## VD-1 — Exact ToolObservation evidence identity

Verifier evidence must preserve two distinct identities:

```text
effect identity       = ToolInvocationId
observation identity  = ToolResult.observationRef
```

Neither substitutes for the other. A `ToolObservation` evidence source is the
pair plus its owning Execution/call binding:

```ts
interface ToolObservationEvidenceSource {
  readonly toolInvocationId: ToolInvocationId
  readonly observationRef: string
  readonly executionId: ExecutionId
  readonly callRef: string
}
```

Runtime binds these fields from durable ToolInvocation + sourced Session
ToolResult. The verifier model may select an observation and explain relevance;
it never supplies or rewrites identity fields. The source is admissible only
when the invocation is terminal, the ToolResult is sourced and the bound
Verifier Execution is authorized to observe the target Verification.

## VD-2 — Verification conclusion summary

For normal conclusion, the verifier owns summary meaning and UTF-8 content.
For `Unknown(Orphaned)`, the authorized Parent owns the orphan explanation.

Runtime performs:

```text
authored summary bytes
→ BlobStorePort.put
→ resolve/check returned content-addressed BlobRef
→ ConcludeVerification(summaryRef)
```

The concluded Verification state/table MUST durably retain `summaryRef` in the
same control-DB transaction as verdict/criteriaResults/conclusionReason.
`VerificationConcluded` also carries summaryRef. Thus:

```text
committed conclusion ⇒ summaryRef resolves to the accepted bytes
```

Blob-only failure before command commit may leave an unreachable orphan blob;
it is not a conclusion and may be collected only while unreachable.

## VD-3 — initialWork VerificationMission lifecycle

`ProposeChildWorkspace.initialWork` is optional. If present, it MUST carry an
explicit complete `VerificationMission` authored by the proposing Parent:

```text
goal non-empty
criteria structured
at least one required criterion
riskRequirements explicit array
```

Runtime does not synthesize a mission from objective/why, and the historical
`p6-placeholder` is not valid for new initial Work. A proposal without a valid
mission may still create the child Workspace only when `initialWork` is absent;
it cannot create an unverifiable initial Work. Later mission refinement uses the
normal Work revision path and invalidates prior completion/verification binding.

## VD-4 — Runtime/action boundary

- Model-facing verifier action carries semantic criterion judgments, selected
  evidence references and summary content.
- Runtime supplies Verification/Work/revision binding, ToolInvocationId,
  observationRef, IDs, timestamps, authority, BlobRef and command identity.
- AgentAction remains process-local and unpersisted; Commands/events/runtime
  records remain the durable truth.
- No universal `AgentDirective` or prompt-only enforcement is introduced.

## VD-5 — Failure and recovery

- Missing/stale/foreign ToolObservation source: reject; no evidence row.
- Blob put/resolve failure: no conclusion command.
- Blob success + command failure: orphan blob allowed, Verification remains Open.
- Exact replay uses the same content-addressed ref and command fingerprint.
- Conflicting summary/verdict under the same logical command identity is an
  idempotency conflict.
- A second conclusion cannot mutate an already concluded Verification.

## VD-6 — Acceptance and completion remain separate

This decision does not allow Verification Pass to auto-accept Work. Parent
Acceptance remains a separate governance judgment. `CompleteWork` still
revalidates the exact Work revision, Pass Verification and matching Acceptance.

## Acceptance record

The user accepted the complete VD-1…VD-6 contract through the explicit
instruction `完成这些` on 2026-10-02. This authorizes the owning contract landing
and Track-B implementation. The historical token
`ACCEPT_VERIFICATION_DELIVERY_CONVERGENCE` remains the stable audit label for
this decision.
