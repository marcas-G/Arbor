# Native Process Mode — Durable Pre-Effect Denial Supplement V2

Status: **FIXED GOVERNANCE SUPPLEMENT / pending manual acceptance; no design
landing or implementation authority**  
Date: 2026-10-26  
Proposal token: `ACCEPT_NATIVE_PROCESS_MODE_DURABLE_NO_EFFECT_V2`  
Supplement to: `ACCEPT_NATIVE_OS_SANDBOX_FIRST_RELEASE_BOUNDARY_V1`  
Base proposal raw SHA-256:
`8A5FC8FED5DCED9B6E944397675738F94B43591B23F85869A2D5FA96D6CB32E8`

## Decision requested

Accept the following single P4/P10 contract for a process-capable action whose
exact P4 invocation is already durable but remains `NotAdmitted` when the
daemon starts in first-release `Disabled` mode or in
`NativeOsSupportedOnly` without its exact qualified tuple:

1. Extend the closed P4 `NoEffectDenialCode` vocabulary with exactly
   `ProcessExecutionDisabled` and `NativeOsTupleUnavailable`.
2. Before any transition to `MayHaveStarted`, P4 atomically terminalizes that
   same invocation as `Denied(reasonCode)` while retaining
   `effectAdmissionState=NotAdmitted`. The settlement has no P40 Observation,
   P40 evidence fields, Artifact/result reference, Sandbox open, executor run,
   provider capability/run call, or TrustedLocal fallback.
3. Project a sanitized public unavailable Attention/status from the exact
   denial joined to its exact Execution and P3 action identity. This is a
   read-only P10/API projection, not a provider attempt or a persisted
   provider-unavailable fact.
4. Add one forward-only additive migration that changes only the existing P40
   `Denied` reason-code allowlists to include the two new closed codes. It
   changes no table, column, historical row, event, queue, marker, or
   authority source.

This is a narrow supersession of the base proposal's no-migration statement:
only the persistence of these two new closed `Denied.reasonCode` values is
covered. It does not add process-mode state, provider-attempt state, or any
other schema or persistence semantics.

This supplement is deliberately limited to an already durable exact P4
invocation at `NotAdmitted`. It does not change the accepted V1 rule that a new
shell action received while Disabled is rejected before P4 invocation intent
or process spawn. It does not alter the Native T3 qualification boundary.

## 1. Closed denial vocabulary and reason selection

The closed `NoEffectDenialCode` becomes exactly:

```ts
type NoEffectDenialCode =
  | "InvocationAuthorityDenied"
  | "ApprovalRequired"
  | "ApprovalRejected"
  | "ApprovalNotFound"
  | "ApprovalMismatch"
  | "ApprovalExpired"
  | "ApprovalConsumedByOtherInvocation"
  | "ResourceResolutionDenied"
  | "ResourceAdmissionDenied"
  | "ApprovalNoLongerAuthorized"
  | "ProcessExecutionDisabled"
  | "NativeOsTupleUnavailable";
```

The runtime selects the code from the immutable startup snapshot and exact
tuple verification result:

| Effective startup mode | Exact qualified tuple | Denial code |
|---|---:|---|
| `Disabled` | irrelevant | `ProcessExecutionDisabled` |
| `NativeOsSupportedOnly` | unavailable, missing, stale, or mismatched | `NativeOsTupleUnavailable` |

No provider-supplied text, local error string, profile guess, or fallback
provider may choose or alter either code. These codes are not
`SandboxProviderUnavailable` outcomes: no Native provider attempt occurred.

## 2. Exact durable terminalization

The rule applies only when all of the following are true:

- the exact `ToolInvocationId` row already exists and is unsettled;
- its immutable P4 intent identifies a process-capable executor;
- its durable `effectAdmissionState` is exactly `NotAdmitted`;
- the current P3 action and P4 invocation still bind the same
  `ExecutionId`, Workspace, ProviderTurn, logical step, repair attempt,
  `LogicalActionId`, action index, `callRef`, tool name/version, canonical
  arguments, and approval identity; and
- the current Worker lease/fencing triple is valid in the same transaction
  that commits the denial.

Before P4 changes the invocation or its P39 effect-attempt row to
`MayHaveStarted`, the owning transaction conditionally writes the exact
mode-specific `Denied` terminal settlement. The durable post-image is:

```text
effect_admission_state = NotAdmitted
settlement_kind         = Denied
settlement_json         = { _tag: Denied, reasonCode: exact closed code }
settled_at              = canonical transaction time
result_ref              = NULL
P40 Observation         = absent
all P40 evidence fields  = NULL
```

Approval history is not undone or reassigned. If this same invocation already
consumed an executable approval when its intent was claimed, that approval
remains consumed by this exact invocation. This denial does not consume a new
approval and cannot authorize a different invocation.

The terminal P3 result is sourced from the exact P4 denial and uses the
existing `Denied` / terminal-rejection progression. Exact replay returns the
same denial without effect admission. The denied invocation is never retried
or rebound when mode or qualification changes; a later attempt requires a new
model action, `ToolInvocationId`, and normal approval/admission checks.

If the invocation is `MayHaveStarted` or `LegacyUnknown`, or any exact
identity/fence check fails, this denial rule does not apply. P4 must retain the
existing side-effect recovery, interruption, or fail-closed ownership path;
it must not infer no effect from Disabled mode, process absence, a missing
provider call, or a restart.

## 3. Attention and public status

P10/API derives one read-only source, `ProcessExecutionUnavailable`, only
from the exact terminal P4 denial above and its exact joined Execution/P3
action identity. The derived item is scoped to that Execution and target
Workspace, and follows existing active-Execution/Stop freshness rules. It is
not derived from model text, shell arguments, a wake, current defaults, or a
provider-unavailable fact.

The projection requires an exact one-to-one join from the P4 invocation to
the P3 action through its RecoveryBinding/action identity; it validates the
closed reason code, terminal `Denied` settlement, `NotAdmitted` state, and
canonical `settled_at`. A missing or conflicting join emits no derived
unavailable Attention and uses the existing typed projection-integrity path.
Its stable `attentionFactId` is lowercase SHA-256 over canonical UTF-8 JSON
with exactly these ordered keys:
`version, executionId, workspaceId, invocationId, providerTurnId,
logicalStepNo, repairAttempt, logicalActionId, actionIndex, callRef,
reasonCode`, where `version=1`. `occurredAt` is the immutable P4
`settled_at`; no current clock or synthesized timestamp is used.

The public projection exposes only the safe status, the exact closed reason
code, and existing public Execution/action references. Its fixed summaries
are:

- `Process execution is disabled for this daemon; the action was not started.`
- `No qualified Native OS process tuple is available; the action was not started.`

The projection omits command text, paths, environment, raw policy/provider
errors, helper locations, evidence digests, and capability details. It must
not manufacture a provider identity, provider version, probe result, process
attempt, `SandboxProviderUnavailableFactV1`, or P40 Observation. Once the
Execution settles or is Stopped, this active Attention projection disappears;
the immutable P4 denial remains ordinary history.

## 4. Replay, crash, and legacy rows

- Crash before the denial transaction commits: the row remains
  `NotAdmitted`; restart repeats the exact guarded decision under a fresh valid
  Worker fence. No effect/provider call is permitted on either side.
- Crash after the denial transaction commits: restart reads and returns the
  same terminal Denied settlement; it performs no admission, provider probe,
  Sandbox open, executor run, or alternate-provider attempt.
- A concurrent Native requalification or mode change cannot turn this exact
  terminal invocation into an executable one. It can affect only a new action.
- Existing terminal settlements, including historical `Denied` rows, remain
  unchanged. Existing unsettled exact process rows at `NotAdmitted` may use
  this rule when resumed. Existing `MayHaveStarted` and `LegacyUnknown` rows
  are never rewritten as no-effect denials.
- Missing or ambiguous P3/P4 identity is not reconstructed from Session text,
  tool output, or a similarly named action. It follows existing fail-closed
  recovery and Attention behavior.

## 5. Persistence boundary

The current P40 insert/update triggers enumerate allowed Denied reason codes;
they do not accept arbitrary strings merely because the application codec is
closed. Therefore the new codes require one migration that transactionally
rebuilds or replaces only those two guards, preserving every existing
predicate and every current allowed code, including `ApprovalRejected`, then
adding `ProcessExecutionDisabled` and `NativeOsTupleUnavailable` to both
allowlists. The migration performs no DML, table/column change, event write,
or historical-row rewrite. It is additive and restart-safe under the existing
serialized migration runner.

At the current migration head 52, the planned migration is 0053. If the
separately governed S3 implementation advances the head to 53 first, recheck
the actual head and assign 0054; do not reserve or infer a number without
that check. If the head changes for any other reason, choose the next
sequential version only after the same read-only head check. The migration
name and predicates must be fixed in the authorized phase contract before
implementation.

No migration inserts or updates `tool_invocations`, rewrites old settlement
JSON, changes prior event payloads, or backfills Attention. The P4 denial and
P10 Attention remain derived from the existing exact P4, Execution, and P3
rows. The one migration advances schema version solely because the two
existing trigger allowlists are versioned schema behavior.

## 6. Required qualification if accepted

The implementation review must include:

1. Closed-code codec vectors and deterministic Denied projection/replay for
   both reason codes; unknown codes continue to fail closed.
2. SQLite proof that the denial transaction leaves the exact invocation
   `NotAdmitted`, `Denied`, settled, with `result_ref` and every P40 evidence
   column NULL, and creates no P39 admitted effect attempt.
3. Before/after-commit process-crash qualification for each code, proving the
   same P3/P4 identities, no `MayHaveStarted` transition, no provider
   capability/run call, no Sandbox/executor/TrustedLocal call, and exact
   terminal replay after restart.
4. Negative cases for `MayHaveStarted`, `LegacyUnknown`, stale fencing,
   conflicting invocation/action payload, already settled invocation, and
   concurrent settlement; none may be reclassified as no-effect.
5. Public process/API qualification showing the sanitized unavailable
   Attention/status is tied to the exact denial and disappears on Execution
   settlement/Stop, without a provider-unavailable fact or synthetic provider
   attempt. Separately retain the accepted new-call pre-intent Disabled
   rejection and shell-absence qualification.
6. Migration qualification from the then-current head proving that only the
   P40 Denied insert/update guards change; all old predicates and allowed
   reason codes remain, both new values are accepted only with
   `NotAdmitted`/Denied/NULL result and P40 evidence, unknown values remain
   rejected, and no historical rows/events are rewritten. Verify transactional
   crash/restart behavior and the recorded schema-version advance.

Targeted unit, public-process, and crash tests are evidence for these exact
cases only. Full functional, package, clean-clone, and any applicable exact
host gates remain separate release qualifications under the accepted Native
first-release proposal.

## 7. Acceptance boundary

If accepted, this exact supplement may be landed in the owning design
documents after manual governance review. Acceptance does not authorize code
implementation, migration registration/execution, existing-database access or
upgrade, deployment, Native support claims, or release. Those remain subject
to the applicable implementation authorization, independent post-landing
review, and accepted exact-host gates. No semantics beyond this file's exact
package may be inferred from its acceptance.
