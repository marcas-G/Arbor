# P4 — 02 Tool Runtime Pipeline

**Authority:** SD v1.3 §6.5/§6.6/§6.7; DID v1.8 §7.6/§6A.7.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

## 1. Frozen pipeline order (SD §6.5)

```text
Tool Intent / No-effect rejection
→ Input Validation
→ Canonical Resource Resolution        (05 §2, ProjectEnvironmentPort)
→ Responsibility Authority             (03 §2, trusted fact)
→ Permission / Approval Match           (03 §3–§4)
→ Resource Admission                   (05 §3, validate-only)
→ Fenced Invocation Claim              (intent + approval consumption, 06 §2–§3)
→ Fenced Effect Admission              (stop + current authority + lease)
→ Sandbox / Isolation                  (04)
→ Execute
→ Settlement                           (01 §5)
→ Bounded Model Observation            (01 §4, SD §6.6)
```

The order is a contract: authorization/resource checks precede execution.
Approval matching precedes Resource Admission; after all checks pass, an
approval-required call persists the exact intent and consumes the exact
approval in one fenced transaction. A no-effect authority/approval/resource
denial is persisted through `recordNoEffectDenial`; it is a terminal record,
not an executable intent. No SQLite transaction spans Sandbox/Execute.

## 2. `ToolRuntimePort.invoke`

```ts
interface ToolRuntimePortService {
  readonly invoke: (
    intent: ToolIntent,
    context: ToolExecutionContext,
  ) => Effect.Effect<CanonicalToolObservation, ToolRuntimeError>;
}
```

**Caller concurrency boundary.** `ToolRuntimePort.invoke` is called by the
single current P3 AgentLoop action under its current `ExecutionOrigin`. P4 does
not provide invocation-level arbitration or a wait/owner protocol for
overlapping calls carrying a copied same-holder tuple; such calls are outside
the supported production path. This boundary does not change sequential
recovery: after `MayHaveStarted`, a NonIdempotent ambiguity follows §5 and P4
`06`—no automatic replay, and the existing `OutcomeUnknown`/reconciliation
disposition remains authoritative.

Steps:

1. **Input validation** — `argumentsJson` must validate against the definition's
   `inputSchemaJson`; invalid input → `ExpectedFailure` (model-correctable), not
   a runtime crash.
2. **Canonical resource resolution** — resolve declared resource arguments via
   `ProjectEnvironmentPort` (`05` §2).
3. **Responsibility authority** — deterministic exact-match against the trusted
   `InvocationAuthority` (`03` §2).
4. **Permission / Approval match** — capability-ceiling check and exact
   `InvocationApproval` match (`03` §3–§4). Whether an approval is required is
   evaluated **per intent** by the tool's policy predicate (e.g. `shell`
   destructive classification), not by a static per-tool flag. A denial before
   consumption persists a no-effect Denied result and leaves a valid approval
   unused.
5. **Resource admission** — validate-only ownership check (`05` §3).
6. **Fenced invocation claim** — for an approval-required call, persist the
   exact intent and conditionally consume the exact approval in one transaction
   after checking the full Worker fence and `stop_requested_at IS NULL`. A
   no-approval call persists its intent under the same fence/stop predicate. If
   stop wins before commit, return `ExecutionStopping` without intent or
   approval consumption. A lost consume CAS rolls back the new intent and
   returns `Denied(ApprovalConsumedByOtherInvocation)` through the no-effect
   denial record path.
7. **Fenced effect admission** — recheck current trusted authority, exact
   approval binding, stop predicate and Worker fence in one transaction. Only
   when all pass, transition `effect_admission_state` from `NotAdmitted` to
   `MayHaveStarted`; commit before opening Sandbox or Executor. If authority
   denies while `NotAdmitted`, persist a typed Denied result. If StopExecution
   wins first, an already claimed invocation settles `Interrupted` without an
   effect. Stale Worker or stopped Execution cannot enter the effect.
8. **Sandbox / Execute** — perform the effect outside the SQLite transaction.
   `MayHaveStarted` means the effect may have begun. A lease takeover after
   this marker cannot generically fence external I/O; the old Worker cannot
   settle/append Observation, and recovery follows `SideEffectSemantics`.
9. **Settlement** — persist the `ToolInvocationSettlement` + the
   `SideEffectSemantics` snapshot (`06`) in a separate fenced transaction.
10. **Bounded observation** — return the size-bounded model-visible observation;
   large raw results behind an Artifact reference (`07`).

## 3. Denial projection

- Authority/permission/resource denial is a **`Denied` observation** (DID §6A.7),
  never an Execution failure.
- A no-effect denial is a terminal `Denied` ToolInvocation record (`01`/`06`),
  including when no prior intent row exists. It never marks effect admission.
- `ExecutionStopping` is not an authority denial and is not in
  `NoEffectDenialCode`; it follows P2 quiescence.

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
- A terminal Denied invocation replays the stored closed reason code and cannot
  execute later. A later attempt uses a new action/invocation identity; an
  unconsumed exact approval remains available to one matching invocation until
  expiry, basis change or consumption.

## 6. Stop / quiescence

- After `StopExecution` (P2), no new `invoke` admission.
- The claim/intent transaction and effect-admission transaction independently
  check `executions.stop_requested_at IS NULL` together with the current lease
  fence. Their order with `StopExecution` is determined by transaction commit
  order.
- Stop before claim leaves no P4 invocation row and consumes no approval; P2
  records the AgentLoop interruption. Stop after claim while
  `effect_admission_state = NotAdmitted` writes P4 `Interrupted` without
  changing approval use. AgentLoop records ToolResult `Interrupted`, closes the
  action and cursor once, skips remaining actions early and proposes
  `Interrupted(StopRequested)`.
- In-flight invocations cancel/confirm/reconcile by `SideEffectSemantics`;
  unresolved → `OutcomeUnknown(ReconciliationRequired(invocationRefs))` (DID §3.4,
  SD §7.3). The P2 `ReconciliationSource` is implemented in `06` §4.
- After `MayHaveStarted`, do not start a new Executor call or replay during
  quiescence. Cancel, confirm or reconcile the in-flight effect; persist a
  known result once, or keep it reconciliation-pending / `OutcomeUnknown`.

## 7. SCRC v1.22 Session correlation

The decoded invocation context carries stable `callRef`. ToolRuntime continues
to own real invocation authorization/effect/settlement and returns the complete
CanonicalToolObservation; Agent Runtime, not ToolRuntime, writes the sourced
Session ToolResult. The model-visible bounded output retains ObservationRef,
ArtifactRef and truncation/epistemic status.

When Tool settlement exists but Session ToolResult is missing, recovery
idempotently appends it by invocation/result source. `OutcomeUnknown` is a
typed ToolResult but still blocks ordinary progression through the existing
unresolved-side-effect gate. No Session text can reconstruct authority.

## 8. Must Not Decide

- No authority resolver (G1).
- No ownership mutation (G4).
- No advanced sandboxing (P11).
- No provider/model-context semantics (P3).
