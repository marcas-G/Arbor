# P4 — 02 Tool Runtime Pipeline

**Authority:** SD v1.3 §6.5/§6.6/§6.7; DID v1.8 §7.6/§6A.7.
**Status:** DRAFT (first draft for contract review).

## 1. Frozen pipeline order (SD §6.5)

```text
Tool Intent
→ Input Validation
→ Canonical Resource Resolution        (05 §2, ProjectEnvironmentPort)
→ Responsibility Authority             (03 §2, trusted fact)
→ Permission / Approval                (03 §3–§4)
→ Resource Admission                   (05 §3, validate-only)
→ Sandbox / Isolation                  (04)
→ Execute
→ Settlement                           (01 §5)
→ Bounded Model Observation            (01 §4, SD §6.6)
```

The order is a contract: authorization/resource checks precede execution.

## 2. `ToolRuntimePort.invoke`

```ts
interface ToolRuntimePortService {
  readonly invoke: (
    intent: ToolIntent,
    context: ToolExecutionContext,
  ) => Effect.Effect<CanonicalToolObservation, ToolRuntimeError>;
}
```

Steps:

1. **Input validation** — `argumentsJson` must validate against the definition's
   `inputSchemaJson`; invalid input → `ExpectedFailure` (model-correctable), not
   a runtime crash.
2. **Canonical resource resolution** — resolve declared resource arguments via
   `ProjectEnvironmentPort` (`05` §2).
3. **Responsibility authority** — deterministic exact-match against the trusted
   `InvocationAuthority` (`03` §2).
4. **Permission / Approval** — capability-ceiling check + `InvocationApproval`
   match/consume (`03` §3–§4).
5. **Resource admission** — validate-only ownership check (`05` §3).
6. **Sandbox** — obtain an isolated execution context (`04`).
7. **Execute** — perform the effect.
8. **Settlement** — persist the `ToolInvocationSettlement` + the
   `SideEffectSemantics` snapshot (`06`).
9. **Bounded observation** — return the size-bounded model-visible observation;
   large raw results behind an Artifact reference (`07`).

## 3. Denial projection

- Authority/permission/resource denial is a **`Denied` observation** (DID §6A.7),
  never an Execution failure.
- A denial is still persisted as a settled invocation (`06`).

## 4. Organizational actions are not tools

`create_child`, `assign`, `query_workspace`, `declare_dependency`,
`report_parent` route through `CommandGateway` / the Communication Runtime, not
`ToolRuntimePort` (DID §7.6, SD §6.7).

## 5. Idempotency / retry

- The invocation key is `(executionId, invocationId)`; `Idempotent` replay uses
  the same key (`01` §2).
- `Reconcilable` resolves external reality before any replay.
- `NonIdempotent` ambiguity → `OutcomeUnknown`, never automatic replay.
- Retry never bypasses the pipeline; re-entry re-runs authority/resource checks.

## 6. Stop / quiescence

- After `StopExecution` (P2), no new `invoke` admission.
- In-flight invocations cancel/confirm/reconcile by `SideEffectSemantics`;
  unresolved → `OutcomeUnknown(ReconciliationRequired(invocationRefs))` (DID §3.4,
  SD §7.3). The P2 `ReconciliationSource` is implemented in `06` §4.

## 7. Must Not Decide

- No authority resolver (G1).
- No ownership mutation (G4).
- No advanced sandboxing (P11).
- No provider/model-context semantics (P3).
