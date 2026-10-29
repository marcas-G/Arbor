# RAI-DG-02 — Terminal Provider failure exact Work-revision hold

**Version:** v2 fixed governance proposal draft

**Status:** awaiting independent review and manual acceptance. This draft does
not modify `docs/design/**`, authorize production code, register a migration,
upgrade an existing database, or qualify the failed real S2 journey.

**Failure evidence:**
`planning/results/RAI-DG-02-real-S2-terminal-provider-failure-busy-loop.result.md`

## Decision requested

Extend the accepted RAI-DG-01 exact-Work-revision readmission gate with one
additional closed source:

```text
TerminalProviderFailureSettlement
```

This source exists only when an exact WorkEpisode Execution is durably
`Failed(ExecutionFailure("ProviderFailure:<kind>"))` and the settlement-
producing AgentLoopStep, ProviderTurn and final ProviderAttempt form one exact,
valid durable chain ending in a P3/P12 terminal non-retryable Provider failure:

```text
AuthenticationFailed | RequestRejected | ProtocolViolation
```

The source holds only the exact `(projectId, workspaceId, workId,
workRevision)` named by the ExecutionEpisodeBinding. Work remains Open. The
source produces one bounded Action Required Attention/Work Detail fact. The
only v1 release path is the existing explicitly authorized `SteerWork` that
advances the Work revision; ordinary scheduler reevaluation, restart, polling,
P10 acknowledgement, configuration reload and time passage do not retry it.

This decision preserves terminal Provider failure as useful typed evidence. It
does not convert the error into an exception crash, erase it, silently cancel
the Work, inject the raw Provider body into model context, or introduce a
blind/backoff retry loop.

Suggested manual acceptance token:

```text
ACCEPT_RAI_DG_02_TERMINAL_PROVIDER_FAILURE_HOLD_V2
```

Acceptance authorizes only the exact owner landing package below. Code,
migration activation, existing-database upgrade and release require separate
authorization after the landing review.

## Why the existing contracts do not cover it

The current system is locally correct at each boundary and globally unsafe at
their composition:

1. P3 classifies `RequestRejected` as terminal for a ProviderTurn and makes no
   transport retry.
2. The Agent driver settles the exhausted Execution `Failed`.
3. DID correctly preserves the semantic Work: `Execution Failed != Work
   Cancelled`.
4. P2/P7 then see an Open Work with no active main and no active WorkWait, so
   they admit a new Execution immediately.
5. The fresh Execution repeats the same terminal request and the cycle has no
   durable stopping fact.

Existing contracts cannot be reinterpreted:

- RAI-DG-01 has a closed `ReadmissionSourceKind` and explicitly excludes
  ordinary `Failed` settlements.
- `Completed(Blocked)` is limited to exact terminal denied-action evidence and
  a model-authored bounded help request. Provider failure has neither.
- P12 D1 is Turn-local ProviderAttempt retry; D2/D4 are Execution-local
  progress limits. A new Execution resets neither by defect nor by violation
  of those contracts.
- P10 Attention is a projection and cannot become admission authority.
- P17 already owns bounded ConversationResponse retry/NeedsAttention and must
  not be generalized into Work scheduling.

The proposal therefore amends the existing RAI gate rather than pretending an
old rule already covers the case.

## Alternatives rejected

| Option | Disposition | Reason |
|---|---|---|
| Automatically admit a fresh Work Execution with exponential backoff | Reject | Delays but does not close a deterministic terminal loop; time is not semantic recovery and restart complicates the budget. |
| Reclassify `RequestRejected` as retryable | Reject | Contradicts the P3/P12 closed taxonomy and may replay a structurally invalid request indefinitely. |
| Automatically cancel or fail the Work | Reject | Violates `Execution Failed != Work Cancelled` and bypasses human/Parent governance. |
| Synthesize a `WorkWait` | Reject | Conflates runtime failure disposition with an Agent-authored cognitive wait and invents an unjustified wake source. |
| Reuse `Completed(Blocked)` and write empty/fake denied-action refs | Reject | Corrupts the exact denial-evidence invariant and changes the meaning of Blocked. |
| Gate from a P10 Attention row | Reject | Makes an eventually consistent read model scheduler authority and lets ACK/rebuild races weaken safety. |
| Add a same-revision `RetryWork` command now | Defer | It requires a new authority, resolution ledger and concurrency contract. Existing `SteerWork(DirectionGuidance)` already advances revision without changing the normative Work contract and is sufficient for v1 explicit recovery. |
| Extend RAI-DG-01 with exact terminal Provider evidence | **Accept** | Reuses the correct exact-revision admission boundary, keeps Work Open, survives restart and has an existing explicit revision-advance release. |

## Proposed frozen semantics

### 1. Closed terminal source predicate

For canonical Work `w` at revision `r`, define
`terminalProviderFailureHeld(w,r)` only when all conditions below hold in one
consistent read:

1. Enumerate zero or more candidate Executions in the same Project and owning
   Workspace with exact WorkEpisode binding `(w,r)`. Each candidate
   `executionId` must resolve to exactly one Execution row; repeated failed
   Executions for the same Work revision are allowed historical evidence and
   do not make the source ambiguous by cardinality alone.
2. The Execution is settled `Failed(ExecutionFailure(reason))`, with exact
   reason `ProviderFailure:<kind>` and `<kind>` in the closed terminal set
   `AuthenticationFailed | RequestRejected | ProtocolViolation`.
3. Exactly one settlement-producing `agent_loop_steps` row for each candidate
   Execution is
   `SettlementProposed`, contains byte-equivalent settlement semantics, and
   binds the exact settlement-producing `providerTurnId`. The Step's
   `(logicalStepNo, repairAttempt)` is retained as source identity.
4. Exactly one ProviderTurn for that Step belongs to the same Execution and Session, binds a
   valid Manifest and Output Contract, and is durably `finish_reason=Failed`.
5. The Turn has exactly one final settled ProviderAttempt whose outcome is
   `TerminalFailure`, whose `provider_error_kind` equals `<kind>`, whose
   failure taxonomy version is recognized, and whose durable retry decision is
   `Stop` because the kind is not retry eligible.
6. ProviderTurn, Manifest and AgentLoopStep identities agree. A successful
   earlier Step/Turn in the same Execution does not disqualify the source and
   must not be mistaken for the settlement-producing Turn.

`RateLimited`, `ProviderUnavailable` and `StreamInterrupted` are never sources
for this predicate, including after retry-budget or deadline exhaustion and
regardless of the final Execution reason text. Only the three closed terminal
kinds with `TerminalFailure + Stop` qualify. `ModelOutputContractViolation`, `ContextUnsatisfiable`, tool failures,
denied actions, safety stops, unresolved effects and ConversationResponse
Episodes retain their existing contracts.

The first valid terminal source starts the hold. Repetition is neither
required nor permitted as a precondition: requiring two or three identical
failures would knowingly send additional terminal requests.

### 2. Stable bounded failure fingerprint

Compute:

```text
failureFingerprint = SHA-256(canonical-json({
  version: "terminal-provider-failure-v1",
  failureKind,
  failureTaxonomyVersion,
  resolvedModelBindingFingerprint,
  compiledRequestHash,
  outputContractRef
}))
```

All components come from the exact Manifest/Turn/Attempt chain. The
fingerprint excludes ExecutionId, ProviderTurnId, attempt timestamp, response
body, retry reason text and provider transport metadata so an accidental
historical repetition deduplicates instead of producing hundreds of user rows.
The exact source Execution/Step/Turn/Attempt identities remain available only
as internal audit bindings.

The bounded source identity returned to Runtime is:

```ts
type TerminalProviderFailureSource = {
  readonly sourceKind: "TerminalProviderFailureSettlement";
  readonly executionId: ExecutionId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptNo: number;
  readonly failureKind:
    | "AuthenticationFailed"
    | "RequestRejected"
    | "ProtocolViolation";
  readonly failureFingerprint: Sha256;
};
```

No raw settlement JSON, Manifest JSON, request/response body, Provider message,
reasoning content, credentials, prompt, path, SQL or parser text crosses this
boundary.

### 3. Admission decision

Extend RAI-DG-01 `ReadmissionSourceKind` with
`TerminalProviderFailureSettlement`. P2's
`WorkReadmissionGateStore.hasBlockingSource` derives the source from existing
durable records and returns `WorkReadmissionHeld`. P7 excludes the exact Work
revision from `current` and `runnable`. Work-bound `AdmitExecution` rechecks
the same predicate inside its existing `BEGIN IMMEDIATE` transaction.

| Current durable state | Result |
|---|---|
| Open Work `r`, terminal source bound exactly to `r` | `Noop(WorkReadmissionHeld)`; no new Execution/Provider/action/command |
| Source belongs to another Work, child, sibling, Workspace or Project | no effect on this Work; normal rules apply |
| Source revision lower than canonical current revision | immutable audit evidence only; not an active hold |
| Source revision higher than canonical revision, or binding is malformed/ambiguous | typed integrity failure; no admission |
| Non-Work Episode terminal Provider failure | outside this RAI amendment; owning episode lifecycle applies |
| Authorized `SteerWork` commits `r -> r+1` | old hold becomes stale; `r+1` is evaluated by ordinary rules |
| Restart, timer, polling, unrelated Attention ACK/rebuild, config reload, daemon replacement | hold remains |

The hold does not mutate Work lifecycle, currentWorkId, Work contract,
Dependency, Deliverable, Verification, Acceptance, Permission, Sandbox or
ResourceBoundary. It adds no timer or automatic retry.

### 4. Explicit recovery and authority

V1 introduces no new command. Recovery uses the existing exact authenticated
human/Parent `SteerWork` authority and exact expected Work revision:

- `DirectionGuidance` may state that the Provider/configuration/request path
  has been corrected and retry is intended. It advances Work revision but does
  not change the normative objective, constraints, completion expectation or
  verification mission.
- `ContractAmendment` remains a complete replacement and is used only when the
  Work contract itself changes.
- Normal or Critical severity keeps existing P6 semantics. A settled failed
  Execution is not a Stop target; no synthetic Stop is created.
- The old failure evidence remains immutable and inspectable. The derived hold
  and ActionRequired row are active only while the canonical Work is `Open` at
  the exact source revision. `SteerWork r -> r+1` is the only v1 path that
  resumes execution. An independently authorized transition to `Completed` or
  `Cancelled` also makes the retry-oriented row inactive without deleting or
  rewriting its source evidence.

An infrastructure operator may fix credentials, deployment configuration or
Provider adapter code, but that external repair alone does not authorize a new
Work Execution. An authorized human/Parent must still issue the exact-revision
Steer. This makes retry intentional and auditable. A future same-revision
operator retry/dismiss command needs separate governance and is not implied by
this package.

### 5. Typed information and user surface

P10 adds two query-derived source literals. Neither is backed by an event,
outbox, queue, projection marker or new table; P10 derives both in the same
read transaction and freshness barrier from the P2-owned proof query over the
canonical terminal chain. There is therefore no consumer ACK, offset, reset or
marker rebuild for these sources. Acknowledging other materialized Attention
rows cannot clear the admission hold or either query-derived row.

The valid-source literal is `TerminalProviderFailure` with severity
`ActionRequired`, targeted to the exact owning Workspace. Its public safe
fields are:

```text
source = TerminalProviderFailure
severity = ActionRequired
failureCode = AuthenticationFailed | RequestRejected | ProtocolViolation
dedupKey = terminal-provider-failure:<workId>:<revision>:<failureFingerprint>
summary = "The model provider rejected this Work execution. Review the provider
           configuration or request compatibility, then explicitly steer the
           Work to retry."
```

The summary is fixed and path/content-free. P10 deduplicates accidental legacy
repetition on `(projectId, workId, revision, failureFingerprint)` and selects
the earliest validated source tuple, ordered by
`(execution.admittedAt, executionId, providerTurnId, attemptNo)`, as the
internal drill-down witness. The P2 gate uses the same total ordering when its
existing `Option` result must choose one bounded witness from multiple valid
sources; the hold predicate itself is true when any source exists. A
different fingerprint may produce a distinct row, but every row targets the
same held revision and none is scheduler authority.

Work Detail shows the typed failure code, occurrence time, revision and the
existing Steer affordance pre-bound to canonical `workId + revision`. It does
not add a one-click blind retry. The immutable P3 Attempt/Turn evidence remains
the technical source; the read model is only presentation.

`occurredAt` is the exact validated final ProviderAttempt `settledAt`. A
missing, malformed or non-canonical UTC instant is an integrity failure, never
query time and never a P10 clock value.

The integrity literal is `TerminalProviderFailureIntegrity`, severity
`ActionRequired`, with fixed summary “Arbor cannot safely verify a terminal
provider-failure recovery record. Execution remains blocked; inspect the
bounded integrity code before retrying.” Its `failureCode` is the exact closed
`ReadmissionGateIntegrityFailure` reason. When the Execution's Project,
Workspace, Work and revision binding is uniquely provable, target that owning
Workspace and deduplicate by
`terminal-provider-failure-integrity:<executionId>:<logicalStepNo>:<repairAttempt>:<failureCode>`.
If even that Episode binding is missing or contradictory, target the Project
root Workspace using the uniquely proven Execution Project; if the Project is
not uniquely provable, the read fails with bounded
`ProjectionIntegrityFailure` and returns no guessed row. Integrity rows expose
only typed codes and bounded identities, never raw JSON or provider content.

This bounded typed fact is useful operational information rather than an
exception crash. It is not automatically inserted into a new Provider request:
the Provider may be rejecting that very request shape. The human's explicit
Steer supplies any safe recovery guidance to the next Work Episode.

### 6. Integrity and historical data

No new gate table or source fact table is required. The existing Execution,
AgentLoopStep, ProviderTurn, ProviderAttempt, Manifest and Episode binding form
the source ledger. The query enumerates all candidate Executions for the exact
Work tuple, then validates uniqueness and equality inside each candidate
Execution/Step/Turn/Attempt/Manifest chain; historical repetition across
different Execution identities is valid. The query must not choose `latest`,
parse Session text, inspect response bodies, or infer the Work from
`currentWorkId` or Attention target.

Extend the existing RAI integrity union with bounded reasons as needed:

```text
SourceSettlementStepMissing
SourceSettlementStepNonUnique
SourceSettlementMismatch
SourceProviderTurnMissing
SourceProviderTurnNonUnique
SourceProviderTurnMismatch
SourceProviderAttemptMissing
SourceProviderAttemptNonUnique
SourceProviderAttemptMismatch
SourceManifestMissing
SourceManifestMismatch
FailureTaxonomyUnsupported
FailureOccurrenceTimeInvalid
```

An invalid candidate returns `ReadmissionGateIntegrityFailure` and commits no
Execution. It is not silently ignored and is not attached to a guessed Work.

For historical databases, individually provable existing chains become active
derived holds without rewriting their rows. Multiple repeated chains with the
same fingerprint deduplicate in P10 but all remain audit evidence. Any
ambiguous/malformed chain fails closed and produces the query-derived bounded
integrity surface defined in §5; it is never automatically repaired or
migrated by guessing. Whether an existing user database may be upgraded
remains governed by the separate migration/upgrade qualification and is not
authorized here.

### 7. Crash and recovery

- Before the terminal Attempt, ProviderTurn `finish_reason=Failed`, and
  settlement-producing Step are each durably complete, existing P3/P9
  recovery resumes the same Turn/Execution and cannot infer a hold from any
  partial prefix.
- P2 may commit the final Execution settlement only after the exact chain is
  durable and validated. Once settlement commits, the derived source exists.
- After settlement commit, a daemon crash cannot permit a new same-revision
  admission. Startup reconciliation observes the same source before scheduler
  admission.
- Classification and authoritative admission read the source in consistent
  snapshots; the `BEGIN IMMEDIATE` recheck closes the race with concurrent
  settlement or Steer.
- A synchronized settlement/admission/Steer race linearizes by SQLite commit
  order. Before `r -> r+1`, `r` is held; after it, only `r+1` can be admitted.
  Two connections or daemons may observe candidates concurrently, but the
  transaction-time gate permits at most one new-revision Execution and zero
  same-revision admission after the terminal chain commits.

## Owner landing package

If accepted, land only these semantics in their owning documents:

1. **System Design:** Work remains Open but is Action Required and not
   automatically runnable after an exact terminal Provider failure; explicit
   authorized revision advance is required. No auto-cancel/backoff.
2. **DID:** add the terminal source to the exact Work-revision RAI invariant,
   exact Step/Turn/Attempt/Manifest binding, fingerprint, crash ordering and
   negative scope.
3. **P2:** extend `ReadmissionSourceKind`, source query, typed integrity union,
   scheduler result and transaction-time Work admission recheck.
4. **P3:** freeze the exact terminal Provider evidence chain and the
   settlement-producing Step binding; keep the Provider failure taxonomy and
   retry dispositions unchanged.
5. **P7:** consume the extended gate in the sole runnability classifier; do not
   add a WorkWait or new dependency edge.
6. **P9:** freeze restart ordering and proof of the same durable terminal
   Step/Turn/Attempt chain; no reconstruction from Provider text or a new
   request.
7. **P10:** add the bounded Action Required projection, dedup/freshness rule,
   Work Detail fields and existing Steer affordance; remain read-only.
8. **P6:** state that the existing authorized revision-advancing Steer is the
   v1 release path and preserves immutable old failure evidence.
9. **P12:** retain the closed terminal/retryable Provider taxonomy, add
   integration/acceptance coverage, and expressly reject treating telemetry,
   backoff or config reload as scheduler authority.
10. **Web/P13:** render the new P10 source and closed failure code in existing
    Attention/Work Detail surfaces and bind recovery only to the existing exact
    Steer form; add no client-side retry authority.

The landing should amend the current versions; it must not reopen the broader
RAI source inventory, Provider taxonomy, Blocked settlement, P17 retry state
machine or Work lifecycle.

## Required qualification after acceptance and implementation authorization

All state tests use fresh SQLite. Process tests use a real daemon and public
commands; crash tests use real process termination and restart. No test retries
itself to obtain green.

1. **First-failure stop:** one Work Episode receives each terminal kind;
   settle it Failed and prove zero second same-revision Execution or Provider
   request across multiple scheduler ticks.
2. **Exact S2 regression:** first conversation succeeds, first Work Turn
   succeeds with a tool action, next Turn is `RequestRejected`; prove one
   terminal Attempt, one failed Execution, one hold/Attention and no loop.
3. **Restart:** kill immediately before and after terminal Attempt settlement,
   ProviderTurn `finish_reason=Failed` commit, Step `SettlementProposed`, and
   final Execution settlement. Every partial chain produces no guessed hold
   and no new admission; recovery either completes the same chain or observes
   the hold, never a second same-revision Execution.
4. **Retryable negatives:** RateLimited, ProviderUnavailable and
   StreamInterrupted retain their existing bounded retry semantics. Exercise
   eligible retry, retry-budget exhaustion and deadline exhaustion; none
   creates this hold, regardless of the final Execution reason text.
5. **Other-category negatives:** output-contract repair, ContextUnsatisfiable,
   denied tool action, RuntimeSafetyStop, OutcomeUnknown and P17 response
   failure follow existing owners with no reclassification.
6. **Binding corruption:** missing/duplicate/conflicting Step, Turn, Attempt,
   Manifest, taxonomy and Episode facts yield typed bounded integrity failure,
   zero admission and no guessed identity.
7. **Scope:** child, parent, sibling, other Work, other revision, other
   Workspace, other Project and non-Work Episode failures do not cross-hold.
8. **Explicit release:** authorized DirectionGuidance Steer `r -> r+1`
   preserves the Work contract, failure audit and source records, removes old
   active Attention, and admits at most one `r+1` Execution. Repeat with crash
   immediately before/after Steer commit.
9. **Query-derived presentation and lifecycle:** scheduler classification,
   P10 Attention and Work Detail use one consistent canonical snapshot;
   acknowledging unrelated materialized rows, restart and query repetition
   never weaken admission. Hundreds of equivalent historical rows deduplicate
   to one current Attention. Steer, CompleteWork and CancelWork each make the
   old retry-oriented row inactive according to §4 without deleting evidence.
10. **No unsafe mutation:** assert Work stays Open, no automatic CancelWork,
    CompleteWork, Verification, Acceptance, WorkWait, timer, Permission,
    Sandbox, ResourceBoundary or provider-config mutation.
11. **Redaction:** public API, logs, result files and UI contain the closed code
    and fixed summary only; no Provider body/request, reasoning content,
    credentials, prompt, resource path or transport metadata.
12. **Underlying adapter regression:** independently fix and qualify the
    Provider request compatibility that caused missing/rejected
    `reasoning_content`. The busy-loop gate may pass while real S2 still fails;
    release requires both.
13. **Existing gates:** focused P2/P3/P6/P7/P9/P10/P12 suites,
    `pnpm check`, complete-coverage `pnpm test:functional`, package test, and
    the real S2 journey pass on one committed candidate.
14. **Settlement/admission/Steer race:** synchronize two independent SQLite
    connections and two daemons around the final terminal settlement,
    Work-bound admission recheck and Steer commit. Assert commit-order
    linearization, zero same-revision admission and at most one new-revision
    Execution.
15. **Historical repetition:** open a read-only disposable copy of the retained
    617-failure fixture, or an equivalent generated fixture with hundreds of
    exact repetitions, and prove one hold/Attention without rewriting source
    rows. Malformed variants expose only the bounded integrity surface.

## Explicit non-claims

- This proposal does not diagnose or fix the Provider adapter's
  `reasoning_content` request construction.
- It does not qualify S2, real Provider operation, Native OS sandbox, package
  delivery or existing-database upgrade.
- It does not close all `Execution Failed` readmission semantics; only the
  exact closed terminal Provider source above is governed.
- It does not add an automatic retry, a generic failure counter, a global
  circuit breaker, a Work lifecycle state, or a same-revision dismissal.
- It does not authorize edits to `docs/design/**` or production code until the
  fixed proposal is independently reviewed and explicitly accepted.
