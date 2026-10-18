# P4 — 02 Tool Runtime Pipeline

**Authority:** SD v1.14 §6.5/§6.6/§6.7/§8.4; DID v1.39 §7.6/§6A.7.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.
Accepted EA-DG-01 amendment: proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`; see
`planning/results/EA-DG-01-governance-acceptance.md`.

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

For a new approval-required intent with no approved record or the exact
request still Pending, step 4 returns `ToolRuntimeOutcome.ApprovalRequired`
with the trusted resolved intent and stops before Resource Admission,
invocation claim, ToolInvocation settlement, Sandbox or Executor. The
Application adds P3 action identity and issues/reads the exact Pending record;
the action remains Pending. ApprovalRequired is not a CanonicalToolObservation
or new Denied settlement.

## 2. `ToolRuntimePort.invoke`

```ts
interface ToolRuntimePortService {
  readonly invoke: (
    intent: ToolIntent,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolRuntimeOutcome, ToolRuntimeError>;
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
   `InvocationApproval` match (`03` §3–§4). Whether approval is required is
   evaluated **per intent** by the tool's policy predicate (e.g. `shell`
   destructive classification), not by a static per-tool flag. If required
   and no exact record exists, or the exact record is Pending, P4 returns the
   nonterminal `ApprovalRequired` handoff with the resolved trusted intent. It
   writes no P4 intent/settlement, no ToolResult and no terminal Denied; the
   Application issues/deduplicates the Pending request and durably pauses the
   same action. A new write never uses `Denied(ApprovalRequired)`. The old
   reason remains decoder/replay compatibility only. Rejected/Expired rows
   become the corresponding typed no-effect Denied result; a Stop-cancelled
  row follows P2 Interrupted/quiescence semantics. Because current authority
  is resolved at step 3 first, an authority denial takes precedence over the
  row's Rejected/Expired result and still leaves an unconsumed approval unused.
5. **Resource admission** — validate-only ownership check (`05` §3).
6. **Fenced invocation claim** — for an approved call, persist the exact intent
   and conditionally consume the exact Executable approval at the supplied
   Approved revision in one transaction after checking the full Worker fence
   and `stop_requested_at IS NULL`. A
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
- Historical `Denied(ApprovalRequired)` rows replay as their stored terminal
  result and remain terminal; no migration or re-entry promotes them into a
  Pending request.

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

## Accepted AH7-DG-02 recovery semantics (DID v1.40)

P4 recovery preserves the distinction between claim, effect admission, external
effect and settlement:

```text
NotAdmitted + no committed effect admission → fresh P4 claim/gates; no reconciliation
MayHaveStarted + unsettled                 → exact profile reconciliation before any replay
P4 terminal settlement                    → replay canonical result only; no reconcile/Executor
```

`NotOccurred`, `Occurred` and `StillUnknown` are proof outcomes from the exact
versioned P4 profile, bound to invocation, attempt, effect key, RecoveryBinding,
authority/approval/resource revisions and external source watermark. An
eventually-consistent miss or unavailable source is `StillUnknown`, never
`NotOccurred`. Only final authoritative `NotOccurred` can enable one replay
(attempt 1) of the same ToolInvocation/ProviderTurn/LogicalAction/callRef,
after a single fenced transaction rechecks full current authority, approval,
workspace/project policy and verifier/control basis, resource state, lease and
`stop_requested_at IS NULL`. `Occurred` may settle
only with reconstructable canonical outcome and bounded observation/result.
`StillUnknown` keeps the invocation unsettled and forbids Executor admission.

Stop blocks new effect-attempt admission but does not erase known reality or
block accounting. A current complete, unexpired Worker fence may append the
reconciliation fact, settle a known result, or write the existing P9 escalation
after Stop. A stale generation may not write. NonIdempotent shell v3 and
historical unprofiled shell v2 never blind-replay. `ReconciledNoEffect` is
reserved for MayHaveStarted plus a selected authoritative NotOccurred fact; it
does not use `Denied` or change `effect_admission_state`.

## Accepted AH7-DG-01 / P39-P40 terminal RNO replay (DID v1.41)

P40 `ReconciledNoEffect` uses the same accepted v1 bounded Observation envelope
as the five DG01 evidence tags. P4 first writes the exact canonical
`text`/`truncated`, closed RNO reason, selected P39 fact ref, and P4 Artifact
ref in the observation bytes, then commits the P40 version/body/hash with the
P39 terminal settlement/selected fact in the same transaction. P39 proof
`evidence_ref` is not the terminal result Artifact; a NotOccurred fact's
`result_ref` stays NULL.

Every P4 terminal-evidence read, including same-invocation early return and
same-ID CAS loser, passes the full current Worker fence/expiry before reading
the invocation. A valid loser returns only the winner's exact verified RNO
Observation, selected fact and Artifact binding; it never returns a local
candidate, chooses a different fact, rewrites terminal data, re-reconciles or
re-executes. A stale generation is `LeaseFencingRejected` without reading the
winner or generating replay Attention. A valid-fence P39 binding/selected-fact
conflict fails closed; a valid P39 RNO row with missing P40 evidence is
`Missing` and enters RecoveryBlocked/P9/P10 without ToolResult or P3 cursor
projection. P4 Artifact bytes cannot reconstruct that missing Observation.

P39-only `user_version=39` is not Runtime-startable/releasable. The cumulative
P36→P37→P38→P39→P40 chain must commit 40 before service start; P39 sidecar and
preflight remain unchanged. The runtime decoder must include the accepted RNO
branch before opening version 40.

## Accepted Native OS Sandbox pipeline

For executable calls, CommandGateway exact approval and sandbox policy remain
independent checks. Before spawn, P4 binds the current `SandboxHandle`, exact
Execution/Episode policy, effective profile/provider digest, admitted mount
read/write roots, work mount, environment allowlist, network policy and
walltime/output/process/memory/CPU controls to one `SandboxProcessPort` call.
Provider capability is probed before execution. Missing or unverifiable
required enforcement returns typed unavailable/Attention and performs no
spawn; it never falls back to `TrustedLocal`. The invocation owns the whole
descendant process tree and close/stop cleans that tree without deleting the
P11-owned Worktree.
