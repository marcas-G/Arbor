# VCS — Verification evidence time and conclusion snapshot fixed package

Status: **Fixed proposal prepared for manual governance; not accepted.**
Implementation: **Not authorized by this proposal.**
Required acceptance token: `ACCEPT_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT`

## 1. Scope and frozen baseline

This proposal resolves only the P8 `RecordVerificationEvidence` replay-time
source and durable `ConcludeVerification` snapshot gap, including their AH10
receipt-first recovery rules. It does not change P8 verdict aggregation,
criterion requirements, evidence authority, verification ownership, human
orphan governance, or Provider semantics.

P8 `04-evidence-binding.md` already freezes `CriterionResult`, requires a
concluded Verification to preserve its mission and per-criterion result
snapshot, and binds ToolObservation Evidence to the exact Runtime-owned
`(toolInvocationId, observationRef, executionId, callRef)` tuple. The isolated
RED evidence and owner review are:

- `planning/results/verification-evidence-replay-and-snapshot-governance.review.md`
- `tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts`
- `tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts`

The failures are independent: per-call `clock.now()` changes the
RecordVerificationEvidence fingerprint on retry, while the committed
ConcludeVerification does not durably retain the `criteriaResults` value.

## 2. Fixed semantic decisions proposed for acceptance

### 2.1 RecordVerificationEvidence `recordedAt`

`recordedAt` is the timestamp selected by Runtime when it first durably writes
the exact P9 `AgentLoopStepAction` ActionIntent for the logical
`RecordVerificationEvidence` action. Runtime passes the ActionIntent's
persisted `updatedAt` value as `recordedAt`; it does not call the clock again
inside the handler or on a later owner generation.

For a still-Pending ActionIntent, recovery reads and reuses that exact stored
value. P9 must preserve the first-intent `updatedAt` while an Action remains
Pending; a transition that leaves the Action Pending may not replace it. Once
the action result is committed, the durable Evidence row and command receipt
are authoritative and recovery must converge them rather than invoke the
handler again. No Evidence-specific timestamp column is proposed: the P9
ActionIntent is the durable owner of this Runtime-selected time. If the
implementation cannot prove that an existing Pending Action's `updatedAt`
still denotes its original intent time, it must fail closed rather than select
a new time.

The model never authors `recordedAt`. The timestamp remains a canonical UTC
ISO string. For the same logical action, owner generation and retry do not
change the serialized Evidence payload or semantic request fingerprint.

### 2.2 ConcludeVerification snapshot and exact result

At StartVerification, persist the complete immutable `missionSnapshot` used by
that Verification. At ConcludeVerification, Runtime validates and stores the
complete `criteriaResults` snapshot against that mission:

- exactly one result exists for every mission criterion, with no extras or
  duplicates;
- each result copies the exact criterion ID, requirement text and `required`
  flag from `missionSnapshot`;
- result order is the mission's criterion order; each result's `evidenceRefs`
  is a duplicate-free lexicographically sorted list of Evidence IDs belonging
  to that exact Verification and criterion;
- every criterion has its required evidence, and the overall verdict equals
  the already-frozen deterministic aggregation over required criteria;
- optional criteria remain in the persisted snapshot and are not silently
  omitted; they do not alter the frozen required-criterion aggregation;
- the content-addressed `summaryRef` is byte-verified before commit.

The existing P8 G5 Orphaned conclusion is a precise exception, not a change to
G5: when and only when the conclusion is `Unknown` with reason `Orphaned`,
Runtime stores no criterion verdicts or evidence refs. Its canonical
`criteriaResults` is the empty list, and the snapshot status is
`NotApplicableOrphaned`. This exception also applies to the existing
`RetryVerification` path that concludes an orphaned Verification. `Passed`,
`Failed`, and `Unknown` for any other reason require the complete criterion
snapshot and use `Available`.

For ordinary ConcludeVerification, one canonical snapshot value is written
atomically to the Verification row, the v2 committed result/receipt, and the
v2 `VerificationConcluded` event. Those records carry byte-for-byte the same
`missionSnapshot`, `criteriaResults`, verdict, `summaryRef`, snapshot status,
and conclusion reason; they cannot be independently reconstructed or
normalized after commit.

The existing G5 `RetryVerification` composite path is the narrow receipt
exception: retain the outer `RetryVerificationResult`/receipt schema v1 and
all existing IDs and state semantics; do not create an internal
ConcludeVerification receipt or expand the outer receipt to v2. In its existing
single transaction, the canonical Verification row and v2
`VerificationConcluded` event carry the same `NotApplicableOrphaned`,
`Unknown`, `Orphaned`, and empty `criteriaResults`. The unchanged outer v1
receipt binds that canonical row/event through its existing
`orphanedVerificationId`, `workId`, and successor IDs; it does not copy the
snapshot. Exact replay returns the original v1 receipt and first verifies the
row/event still match that binding and canonical Orphaned representation.
There is no intermediate `Available` snapshot or fabricated per-criterion
result.

Because the existing v1 event/result shape has no `criteriaResults`, new
writes use `VerificationConcluded` event version 2 and ConcludeVerification
handler/result schema version 2, carrying snapshot status and conclusion reason
(nullable only when the command contract has no reason). The outer
`RetryVerificationResult`/receipt remains its existing strict v1 schema,
including for its G5 Orphaned branch; no inner Conclude receipt is generated.
Existing v1 event and receipt decoders remain strict and read-only. A v1
committed receipt is never relabeled as v2 or silently augmented with inferred
values.

### 2.3 Snapshot status and historical rows

Persist an explicit snapshot status with exactly these meanings:

| Status | State and stored values |
|---|---|
| `Pending` | Open Verification with a proven immutable `missionSnapshot`; no `criteriaResults` yet |
| `Available` | New Concluded Verification with the exact mission and complete criteria result snapshot |
| `NotApplicableOrphaned` | New conclusion only when verdict is `Unknown` and reason is exactly `Orphaned`; the complete mission snapshot is retained and `criteriaResults` is empty |
| `UnavailableLegacy` | Any pre-migration Concluded row, retained as historical evidence without an inferred or backfilled criterion snapshot |

Storage constraints must make `NotApplicableOrphaned` equivalent to the exact
`Unknown`/`Orphaned`/empty-list combination. No other reason or verdict may use
it. `Available` must have a complete criteria snapshot and may not represent
an Orphaned conclusion; `Pending` is open only; migrated pre-existing
conclusions remain `UnavailableLegacy`.

`UnavailableLegacy` preserves existing verdict, evidence rows, summary reference,
events and receipts, but has no fabricated `criteriaResults`. It is an explicit
read result, not `Pass`, `Unknown`, an empty array, or permission to infer from
the overall verdict or from Evidence existence. The empty list for
`NotApplicableOrphaned` is different: it is a newly committed, explicitly
proven G5 exception and is accompanied in its canonical row and event by its
exact status and `Orphaned` reason. For RetryVerification, the outer v1 receipt
retains only its existing identity/successor binding fields and exact replay
must verify the row/event rather than copy the snapshot into that receipt.

For a pre-migration Open row, migration may set `Pending` and backfill
`missionSnapshot` only from the existing `verifications.mission_snapshot`
column, treated as the sole canonical source of the complete snapshot. Before
any schema or row write, preflight must strictly decode that JSON with the
current mission-snapshot codec and prove its Verification identity, exact Work
identity/revision binding, and association with the corresponding durable
`VerificationStarted` event. The event's existing `missionDigest` is only a
weak consistency check; it does not prove the complete snapshot and must never
be used to reconstruct, replace, or normalize its criteria, risk, or ordering.
If the row snapshot is absent, malformed, or cannot be identity-associated,
migration preflight aborts before any DDL or data write. It must not reconstruct
the snapshot from `missionDigest`, mutable current Work, or other partial
sources. Every pre-migration Concluded row becomes `UnavailableLegacy` without
canonical-row rewrite or criterion-result backfill. Defining a new
canonical full-snapshot digest, if needed, is a separate governance question
and is outside this package.

## 3. AH10 receipt-first binding

The LogicalActionId remains stable across owner generations. Each owner
generation receives its own immutable command identity; operational retries
of that exact immutable request reuse the same CommandId and fingerprint.
Before any new-generation command:

1. read and strictly decode all known prior-generation receipts using the
   trusted registered handler/result schema;
2. a matching Committed receipt converges only when the Evidence row or
   Verification row/event/result proves the exact same action, source binding,
   snapshot, status, reason, `criteriaResults`, and `summaryRef`; for
   `NotApplicableOrphaned`, that includes exact `Unknown`, `Orphaned`, and an
   empty criteria list. For the outer v1 RetryVerification receipt, validate
   its existing `orphanedVerificationId`, `workId`, and successor-ID binding
   against the canonical row and event, return the exact original receipt, and
   do not add snapshot fields or an inner receipt. Do not call the handler or
   append duplicate facts;
3. `TerminalRejected(FencingRejected)` permits a current-generation command
   only while the logical action remains Pending, the P8 ControlBasis is
   current, and no unresolved P4 effect exists;
4. any other terminal rejection is final for that logical action;
5. missing, malformed, unsupported-version or conflicting receipts/evidence
   fail closed with no Observation, new command, row repair, provider replay,
   or invented snapshot.

RecordVerificationEvidence additionally proves the P8-bound Evidence row and
exact ToolObservation source tuple before replay is considered successful.
ConcludeVerification proves that the persisted row, v2 event and committed
result carry the same complete snapshot, status/reason, and `summaryRef`.
RetryVerification's G5 Orphaned branch must produce the same atomic
row/event `NotApplicableOrphaned` representation; its unchanged outer v1
receipt binds those records and receipt-first replay validates that binding
and returns the exact receipt. SettleExecution
recovery remains the ordinary P9/P1 path after the action result is
durable; this proposal adds no new settlement authority.

## 4. Historical replay and migration boundary

Existing v1 commands, receipts and events remain immutable. Preserve their
original `recordedAt`, verdict, summaryRef, evidence rows and serialized result
as historical evidence. Mark every pre-migration concluded row
`UnavailableLegacy`; do not infer or backfill criterion results, including for
an old Orphaned conclusion. Never
derive individual verdicts from the aggregate verdict, Evidence presence,
current Work mission or prose in a Session.

The implementation package must assign the next available migration ID from
the actual registered predecessor at implementation time; this fixed proposal
does not reserve or guess a migration number. The additive migration must
include exact predecessor checks, status/JSON consistency constraints,
disposable prefix fixtures, no-op re-entry, and an abort-before-write case for
an unprovable active Open Verification. It must not edit an earlier migration
or rewrite existing command/event bytes.

## 5. Owner-document landing

After explicit acceptance, land only the accepted package in the documents
that own these contracts, then perform an independent hash/consistency review:

- `docs/design/implementation/P8/04-evidence-binding.md`: immutable mission
  and criterion snapshot semantics, status values, and `recordedAt` meaning;
- `docs/design/implementation/P8/01-verification-commands.md`: Runtime time
  binding, v2 Conclude result/event payload, exact receipt replay and version
  compatibility, including the `RetryVerification` Orphaned same-transaction
  exception, unchanged outer result/receipt v1 shape, binding IDs, and v2 event
  status/reason fields (without an internal Conclude receipt);
- `docs/design/implementation/P1/04-sqlite-schema.md`: snapshot/status/reason
  storage shape, consistency constraints, and migration ordering;
- `docs/design/implementation/P1/07-agent-loop-step-command-identity.md`:
  the exact P9 ActionIntent time source and generation-scoped P8 command
  attempts;
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md`:
  receipt-first P8 action recovery, immutable Pending-intent time and
  fail-closed inconsistent-evidence behavior.

No owner document is changed by this proposal. Acceptance is design/governance
only. Implementation, migration registration, fixture mutation and release
qualification require a separate explicit implementation authorization after
the owner-document landing review.

## 6. Acceptance matrix required after separate implementation authorization

### RecordVerificationEvidence

- first intent captures one timestamp; model-authored timestamp is impossible;
- crash before command commit followed by generation takeover reuses that
  intent timestamp, stable payload and expected new-generation CommandId;
- crash after Evidence/Committed receipt but before Action Observation
  converges the exact single Evidence row with no second command or Provider
  request;
- negative: changed evidence payload, different logical action/criterion,
  mismatched Evidence ID, wrong Verifier Execution, or a ToolObservation whose
  `(toolInvocationId, observationRef, executionId, callRef)` differs fails
  closed;
- negative: non-FencingRejected receipt does not retry; unsupported prior
  schema or malformed receipt is PersistenceCorruption/fail-closed;
- exact retries have byte-identical semantic fingerprints and Evidence rows;
  `recordedAt` does not change across owner generations.

### ConcludeVerification

- all criteria/verdict/evidence combinations satisfy P8's frozen aggregate;
- `Unknown`/`Orphaned` through both ConcludeVerification and RetryVerification
  atomically stores `NotApplicableOrphaned`, exact reason `Orphaned`, and an
  empty `criteriaResults` list on the canonical row/event; reject any criterion
  verdict or evidence ref in this exception, and reject this status for every
  other verdict/reason. For RetryVerification retain its exact outer v1
  receipt shape and existing `orphanedVerificationId`, `workId`, and successor
  IDs, with no snapshot copy and no internal Conclude receipt;
- strict RetryVerification v1 decoder rejects missing, extra, malformed, or
  unsupported fields/version and preserves all existing IDs/state semantics;
  exact replay returns the byte-identical committed v1 receipt only after
  verifying its bound canonical row/event are unchanged;
- corrupted, missing, mismatched, or duplicate canonical row/event state on
  RetryVerification replay fails closed and never repairs or appends a new
  conclusion;
- Passed, Failed, and Unknown with any non-Orphaned reason retain and validate
  the complete mission and criteria snapshot with status `Available`;
- reject missing, extra, duplicate, reordered/rewritten mission criterion,
  duplicate or cross-Verification Evidence refs, wrong aggregate verdict,
  absent or byte-mismatched summaryRef;
- ordinary ConcludeVerification row, v2 event and v2 committed result/receipt contain identical canonical
  mission snapshot, ordered criteriaResults, verdict, summaryRef, status and
  conclusion reason (including an explicit null where the command has none);
- for G5 RetryVerification, only row and v2 event carry the identical
  `NotApplicableOrphaned`/`Unknown`/`Orphaned`/empty-list snapshot; the existing
  outer v1 receipt carries only its ID binding, and exact replay validates row
  and event before returning that unchanged receipt;
- crash before command transaction commits leaves no partial conclusion;
  crash after commit before action Observation/settlement converges the same
  receipt/snapshot and emits one conclusion event and wake;
- old v1 committed receipts/events remain strict v1 and historical concluded
  rows surface `UnavailableLegacy`, with no inferred criterion values.
- RetryVerification's G5 Orphaned path has before/after-commit crash, strict
  v1 receipt-shape, exact replay, and corrupted/missing/mismatched row-event
  fail-closed coverage; only one atomic row/event set and the outer v1 receipt
  are visible, with no fabricated criterion result or inner Conclude receipt.

### Migration and isolation

- Open rows become `Pending` only from a strictly decoded existing
  `verifications.mission_snapshot` whose Verification identity, exact Work
  revision binding, and corresponding `VerificationStarted` event association
  validate; the event's goal/count `missionDigest` is weak consistency only
  and cannot reconstruct or overwrite snapshot content. Missing, malformed,
  or unassociated row snapshots abort preflight before any DDL/data write;
- every pre-migration concluded row becomes `UnavailableLegacy`; no legacy
  conclusion, including Orphaned, is upgraded by inference or backfill;
- rerun/no-op, predecessor mismatch, FK/integrity, crash rollback and legacy
  receipt/event decode are tested on disposable SQLite databases;
- real two-daemon AH10 matrix covers both controls before/after FencingRejected
  commit, committed receipt with Action Pending, exact/changed/missing durable
  facts, provider no-replay, unique evidence/conclusion facts, and subsequent
  Action Observation/SettleExecution recovery.

## 7. Non-claims

This package is not accepted, is not a design-document landing, does not
authorize implementation or migration registration, and is not test or release
evidence. Full AH10/P8 status remains open until the accepted package is landed,
separately authorized, implemented, and qualified on an exact committed SHA.
