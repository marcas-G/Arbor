# F18 Verification v2 Consumer and Read-model Convergence — Governance Draft

Status: **DESIGN GAP / manual decision required**  
Date: 2026-10-21  
Reproduction baseline: `fcc2e64287ef2be73301631e0d4322cd3c9e8c9b`

## 1. Observed failure

The public F18 journey creates a child Workspace with an initial Work, lets the
child claim completion, runs an independent Verifier, and expects the Parent to
receive and accept the verified child result.

The production-process reproduction proves all facts before delivery are
correct:

- the child owns the expected `FileTree` boundary;
- the Verifier `read` invocation resolves that boundary and reads
  `proof.txt` as `FUNCTIONAL_VERIFIED`;
- one ToolObservation Evidence row is committed against the exact terminal
  invocation/result;
- the canonical Verification concludes `Pass`;
- `verifications.criteria_results` contains the complete required criterion
  with verdict `Pass` and the exact Evidence ID;
- the `VerificationConcluded` v2 event contains the same mission, ordered
  criterion result, verdict, evidence and `Available` snapshot status.

Nevertheless, no `child-result:<verificationId>:<revision>` Parent Inbox entry
is admitted. F18 times out before Parent Acceptance.

## 2. Common root cause

The accepted VCS contract (DID v1.48; P8 `01` / `04`) requires every new
ordinary Verification conclusion to emit `VerificationConcluded` event version
2. The older frozen P1 `05` section 3 still says the reader ceiling is globally
version 1. Production `packages/application/src/consumer-loop.ts` implements
that older global ceiling literally.

As a result, every generic consumer quarantines the valid event before its
event-type handler runs. In the reproduction, the `workflow-signals` consumer
advances past the event and writes:

```text
consumer_id = workflow-signals
sequence    = <VerificationConcluded sequence>
reason      = unsupported eventVersion 2
```

The same sequence is quarantined by the other generic consumers. The workflow
consumer therefore never executes its already-correct
`deliverVerificationConcluded` path and cannot admit or wake the Parent.

A second stale implementation is visible on the same journey:
`packages/projection-runtime/src/views/verification.ts` still hard-codes every
criterion verdict to `Unknown`, based on the superseded assumption that P8 did
not persist criterion snapshots. P46 and the accepted P8 contract now do
persist them. Thus the public view reports aggregate `Pass` with required
criterion `Unknown`, even though canonical storage proves criterion `Pass`.

This is not a Verifier, resource-boundary, sandbox, provider, or fixture
failure. Treating `Unknown` as `Pass`, skipping the criterion, or weakening
Acceptance would conceal the defect and is prohibited.

## 3. Design contradiction requiring governance

Two frozen statements cannot both govern new writes:

1. P1 `05` section 3: the reader supports only `eventVersion <= 1`, and any
   higher version is poison.
2. DID v1.48 / P8 `01`: new `VerificationConcluded` writes are exactly event
   version 2 and must drive downstream delivery/recovery.

Raising one global integer ceiling to 2 is unsafe: it would silently accept
version 2 of every event type, including types for which no v2 decoder or
semantics exist. Keeping the ceiling at 1 makes every valid new Verification
conclusion undeliverable. The owning P1 event-reader contract therefore needs
an explicit event-type/version capability rule.

## 4. Recommended fixed decision (Option A, revision 2)

### F18-V2-1 — exact P1 writer and reader type/version tables

The authoritative key is the pair `(eventType, eventVersion)`, never a global
numeric ceiling. `EVENT_CATALOG` remains the closed type registry.

| Pair class | Writer | Reader |
|---|---|---|
| `VerificationConcluded`, version 2 | **required and supported for every new write** | supported with the strict VCS v2 decoder |
| `VerificationConcluded`, version 1 | forbidden for new writes; historical bytes are read-only | supported with the existing strict historical v1 decoder |
| each explicitly listed non-Verification type below, version 1 | supported and the only legal new-write version | supported with its existing v1 decoder |
| an event type absent from `EVENT_CATALOG`, including unknown type version 1 | writer defect before append | poison: dead-letter + offset advance |
| any registered type paired with a version not listed above, including arbitrary non-Verification v2 and all v3 | writer defect before append | poison: dead-letter + offset advance |

The writer validates the exact pair before journal sequence allocation or any
event insert. Thus **only** `VerificationConcluded` may be newly written as v2;
all other new writes remain exactly v1. The reader first validates membership
in the exact table and then invokes the decoder for that pair. It must not
decode a v2 payload with a v1 decoder, ignore an unknown type v1, or accept a
pair merely because its version is numerically below a maximum.

The complete non-Verification v1 key set at this decision is the following 56
explicit names (not a wildcard/default clause):

```text
ProjectCreated
ProjectPolicyChanged
ProjectRenamed
ProjectClosed
WorkspaceCreated
WorkspaceResourceActivationChanged
ResponsibilityChanged
ResourceBoundaryChanged
ResourceOwnershipChanged
WorkspacePolicyChanged
WorkspaceRetired
WorkspaceLineageRecorded
PrimarySessionReplaced
WorkAssigned
CurrentWorkChanged
WorkRefined
WorkCompleted
WorkCancelled
WorkSteered
WorkBlockerResolved
WorkBlockerSuperseded
DependencyDeclared
DependencySatisfied
DependencyContractRevised
DependencyWithdrawn
DependencyMarkedUnfulfillable
DeadlockAttentionRequested
ReconciliationEscalated
AssignWorkTargetBindingEscalated
DeliverReplayEscalated
ToolObservationReplayEvidenceEscalated
SubmittedDecisionBindingEscalated
SandboxProviderUnavailable
LegacyAdoptionEvidenceEscalated
LegacyAdoptionEvidenceResolved
DeliverableProduced
MessageSent
VerificationStarted
WorkOutcomeAccepted
ExecutionAdmitted
ExecutionStopRequested
ExecutionSettled
PermissionChanged
SandboxPolicyGrantIssued
SandboxPolicyDecisionRecorded
DecisionRecorded
EnvironmentChanged
WorktreeCreated
WorktreeRetired
HumanInterventionApplied
HumanMessageSubmitted
ConversationResponseResumed
ConversationResponseCancelled
ControlApprovalResolved
ExecutableApprovalRequested
ExecutableApprovalResolved
```

Together with the one explicit `VerificationConcluded` row, those names are
the 57 keys of the current `EVENT_CATALOG`. Build qualification compares both
key sets for exact equality. A future catalog addition has no default version:
the build fails until governance adds an explicit pair row.

The same shared predicate/table must govern the Application `pollOnce`
consumer loop, the SQLite generic consumer runner, the independent raw-journal
`runAttentionPollOnce` reader used by `p10-rebuild:attention`, every rebuild/
replay reader and architecture tests. No raw reader may retain a separate
`eventVersionRaw > 1` decision. CC-3 remains unchanged for every unsupported
pair. The registered catalog and this version table must be exhaustively equal:
adding a new event type without an explicit writer/reader row is a build/test
failure.

### F18-V2-2 — strict v2 source and reliable receipt binding

Before live handling or historical reconciliation, a
`VerificationConcluded` v2 row must strictly decode and prove all of:

- event envelope Project, sequence, EventId, aggregateRef and
  `causedByCommandId`;
- payload Verification/Work/revision/verdict, complete mission and ordered
  criteria snapshot, Evidence IDs, summary ref, reason and snapshot status;
- canonical Verification byte-equivalence for all VCS-owned fields;
- canonical Work Project and owner Workspace identity;
- a durable Committed command receipt for `causedByCommandId` in the same
  Project.

For an ordinary conclusion, that receipt is schema v2. Equality is the
following exact projection, not whole-object equality across unlike shapes:

- row/event/result agree on Verification identity, verdict, summary ref,
  mission snapshot, ordered criteria results, snapshot status and conclusion
  reason;
- event Work ID/revision and Evidence IDs equal the canonical row;
- result `state` is exactly `Concluded`;
- result `channel1Release` is exactly the canonical Work ID/revision;
- result `wakeSignals` is exactly `[]` for `Pass`, and for `Fail`/`Unknown`
  is exactly one `VerificationReturned` signal targeting the canonical owner
  Workspace with exact Verification/Work/revision/verdict detail.

The registered strict ConcludeVerification v2 result decoder runs before that
projection check. No additional or reordered receipt-only signal is accepted.
For the accepted G5 exception, the exact `retry_verification_origins` row identifies the source
Verification and the outer `RetryVerification` receipt remains strict v1; its
canonical/event binding must prove
`Unknown`/`Orphaned`/`NotApplicableOrphaned`/empty results and its exact
successor IDs. Missing, TerminalRejected, malformed, wrong-Project, wrong
schema, duplicate or mismatched receipt evidence is Attention; reconciliation
must not rerun `ConcludeVerification`, `RetryVerification`, the Verifier, or
the Provider.

#### Absent-reason wire correction and bounded compatibility

The accepted VCS value for an absent reason is explicit JSON `null` in row,
event and result/receipt. Every new v2 writer after this landing must emit the
property `conclusionReason: null`; omission and empty string are rejected
before append/receipt commit. `Orphaned` remains the only non-null value.

Existing buggy v2 bytes are not rewritten. The activation migration captures
for each already-existing Project the exact committed journal high-water before
enabling the corrected writer. A pre-activation ordinary v2 conclusion is
eligible for the one compatibility disposition only when all of the following
are simultaneously true:

```text
event sequence <= captured Project high-water
event conclusionReason is exactly ""
canonical conclusion_reason is SQL NULL
schema-v2 Committed result omits conclusionReason entirely
snapshotStatus is Available and the conclusion is not Orphaned
every other row/event/result/receipt projection field matches exactly
```

This is typed `LegacyAbsentReasonV2` evidence, not normalization or an upcast.
The empty string and omitted property remain in their historical bytes and the
reconciliation source digest binds them. The ordinary corrected v2 decoder
rejects those legacy bytes as malformed; after quarantine, only the historical
reconciler may validate this compatibility tuple and treat its semantic reason
as absent for effect selection. A post-high-water empty/omitted reason, a
partial legacy tuple, `NotApplicableOrphaned`, or any other mismatch is
Attention. Projects created after activation have no legacy eligibility. The
high-water rows are protected immutable migration facts included in source
validation and reconciliation digests.

Consumers that do not own `VerificationConcluded` semantics may ignore the
supported pair after common journal/projection apply. The workflow-signal
consumer alone delivers the existing wake/Inbox effects. Criterion bytes do
not grant authority.

### F18-V2-3 — complete verdict/ownership effect matrix

Live consumption and recovery must produce exactly the same existing effects:

| Verdict / owner | Verification channel 1 | Owner re-evaluation | Parent Inbox | Parent re-evaluation |
|---|---|---|---|---|
| `Pass`, child Workspace | clear exact `VerificationChanged(workId, revision)` waits | none | exact child-result row | `InputArrived` after Inbox commit |
| `Pass`, Root Workspace | clear exact wait | none | none | none |
| `Fail`, child or Root | clear exact wait | `VerificationReturned` | none | none |
| `Unknown`, child or Root, including G5 Orphaned | clear exact wait | `VerificationReturned` | none | none |

The Parent row for child `Pass` is immutable and exact:

```text
recipientWorkspaceId = reconciliation-bound direct Parent Workspace
entryKey              = child-result:<verificationId>:<targetWorkRevision>
kind                  = Message
summary               = Child result ready for Work <workId> revision <targetWorkRevision>
correlationId         = null
admittedAt            = VerificationConcluded.occurredAt
```

Before insert/no-op, recovery queries all rows carrying that entry key. Zero
rows permits one insert. Exactly one row is accepted only when recipient,
kind, key, summary, null correlation and admittedAt all match byte-for-byte;
its consumed/unconsumed state is preserved. A row at another recipient,
multiple rows, or any field mismatch is a fail-closed Attention. Recovery does
not move, overwrite, unconsume or reinterpret an existing Inbox row.

### F18-V2-4 — durable historical reconciliation state machine

Changing the reader table cannot heal a database whose workflow offset already
advanced past a valid v2 event. Startup recovery therefore scans only exact
`workflow-signals` dead letters whose reason is either the old global-gate
value `unsupported eventVersion 2` or the corrected reader value
`malformed event payload`, and whose raw journal row is
`VerificationConcluded` v2. The latter is eligible for
`LegacyAbsentReasonV2` only under the captured high-water rule above; every
other malformed v2 becomes Attention. Other dead letters are out of scope.
Offsets are never reset and dead-letter rows are never deleted or rewritten.

The durable identity exists even when the raw event is malformed and is the
exact dead-letter tuple:

```text
(consumerId="workflow-signals", projectId, eventSequence)
```

After successful decode, the reconciliation row additionally freezes EventId,
source command ID, Verification ID, Work ID/revision, verdict, owner Workspace,
direct Parent (or null), source/event/receipt digest and an effect-plan digest.
A partial uniqueness constraint covers `(projectId,eventId)` whenever EventId
is non-null; any second tuple for the same event is corruption. A validation
failure before EventId is provable writes the same identity directly as
`Attention`, never as `Pending`.

States are exactly:

```text
Pending
VerificationWakeDelivered
ParentInboxCommitted       // child Pass only
ParentWakeDelivered        // child Pass only
Completed
Attention
```

`Pass` Root and every `Fail`/`Unknown` path move from
`VerificationWakeDelivered` directly to `Completed`. No unused phase may be
fabricated. `Attention` and `Completed` are terminal.

Each nonterminal row has a lease owner, generation and expiry. Claim/takeover
is one compare-and-set transaction; every phase transition requires the exact
current generation. Two daemons therefore cannot advance the same phase.
Expired takeover rereads and revalidates the dead letter, event, reliable
receipt, canonical Verification/Work/Workspace route, frozen digests and every
already-durable effect before continuing. Route or source drift is Attention,
not a new binding.

Ordering and crash semantics are fixed:

1. insert/claim `Pending` only after complete source validation;
2. run the existing idempotent Verification wake, then commit
   `VerificationWakeDelivered`; a crash before the effect retries it, and a
   crash after the effect but before disposition repeats the same idempotent
   clear/reevaluation;
3. for child `Pass`, atomically insert-or-validate the exact Inbox row and CAS
   `ParentInboxCommitted` in one database transaction;
4. only after that commit, issue the idempotent Parent `InputArrived`
   reevaluation, then commit `ParentWakeDelivered`;
5. commit `Completed` last.

No disposition is committed before its owned effect. A crash after a phase
commit skips that effect on restart. A crash after an idempotent scheduler
effect but before phase commit may repeat the reevaluation, which is already
defined as re-derivation without model polling. Existing exact consumed Inbox
is not re-admitted or re-woken when the durable state proves
`ParentWakeDelivered`/`Completed`; if the state is only
`VerificationWakeDelivered`, the exact row is validated and the Parent wake is
delivered once more under the idempotent contract before advancing.

An ordinary lost lease/CAS race is not Attention: the stale owner stops and the
current owner continues. Missing/malformed/ambiguous source, canonical or
receipt mismatch, Inbox conflict, impossible state/phase, digest drift,
generation regression, or a terminal row whose required durable Inbox fact is
absent commits `Attention` and its durable Attention fact in one transaction.
It emits no new Inbox/wake and never reconstructs from Work text.

The Attention contract is fixed here rather than deferred:

```text
sourceKind       F18VerificationSignalReconciliation
sourceIdentity   workflow-signals:<projectId>:<eventSequence>
attentionFactId  sha256("f18-v2-reconciliation-attention-v1\0" + sourceIdentity)
dedupKey         f18-verification-v2-reconciliation:<projectId>:<eventSequence>
targetWorkspace  exact Project.rootWorkspaceId
severity         ActionRequired
public source    F18VerificationSignalReconciliation
public summary   A verified result delivery could not be reconciled; recovery is paused.
public time      firstDetectedAt
```

Failure code is one of
`DeadLetterBindingMismatch | EventEnvelopeMalformed | UnsupportedSourcePair |
EventDecodeFailed | ReceiptMissing | ReceiptMismatch | CanonicalMismatch |
RouteMismatch | InboxConflict | StateCorruption | GenerationRegression`.
The safe summary contains only source kind, ProjectId, event sequence and
failure code; it never includes payload, criterion/user text, paths, receipt
bytes or secrets. The append-only fact freezes fact ID, source identity,
nullable EventId, failure code, evidence digest, target Root Workspace and
first-detected time.

The internal safe diagnostic summary is not the public summary. P10 always
projects the single fixed public sentence above, exposes the exact closed
failure code in `AttentionRow.failureCode`, exposes `firstDetectedAt` as the
row occurrence time, uses `attentionFactId` as dedup key, and renders
`severity=ActionRequired`. All failure codes share that fixed summary; there
is no per-code free text. Subtree bubbling counts one ActionRequired row and
copies no context upward.

The same transaction writes/updates the reconciliation row to terminal
`Attention`, inserts the append-only fact, and inserts one retained P10
admission-queue row keyed by `(projectId, attentionFactId)`. This queue is the
live outbox; no new DomainEvent is invented, and the malformed source event is
not reused as a projection trigger.

The existing P10 poll cycle scans this queue on every bounded poll/startup
cycle, independently of the journal offset. A daemon claims a Pending or
expired queue row by lease/generation CAS, rereads the exact fact,
reconciliation identity and Root target, then in one transaction inserts or
byte-validates the P10 marker and changes the queue row to `Projected` under
the same generation. The marker points to the immutable fact, not the event.
A crash before that transaction commits leaves both marker and queue state
unchanged; a crash after commit leaves both durable. A crash after claim but
before projection is recovered by lease expiry. Competing daemons cannot
project different rows; a stale generation cannot settle the queue.

P10's ordinary read joins marker to fact and immediately exposes the fixed
public row. P10 rebuild enumerates the fact table, deterministically recreates
or validates every marker, and marks any matching queue row `Projected` in the
same rebuild transaction. Thus a committed Attention is visible through the
live queue without waiting for full rebuild, while rebuild remains an
independent recovery path. Queue payload carries only fact identity and has no
authority, model wake or canonical repair meaning.

Duplicate fact/queue/projector delivery is a no-op only when every immutable
field matches; conflict is persistence corruption and must leave no false
public row. Attention never auto-clears and has no model wake or repair
authority. If the Project or exact Root Workspace cannot be proven, startup
fails closed with typed persistence corruption before claiming reconciliation;
it must not route to an arbitrary Workspace.

The physical DDL and next migration number require a separately reviewed
implementation package, but that package may not change the identities,
fields, mapping or lifecycle frozen above. This proposal authorizes no
existing-database mutation.

Other consumers have no owned effect for `VerificationConcluded`; their
historical version-2 dead letters remain audit facts and receive no invented
replay.

### F18-V2-5 — public Verification criterion projection

The Verification read model must project canonical snapshot availability
without inference:

| Canonical snapshot status | Public `criteriaResults` |
|---|---|
| `Pending` | mission criteria with verdict `Unknown` |
| `Available` | exact stored `criteriaResults` verdicts, preserving mission order |
| `NotApplicableOrphaned` | exact stored empty list |
| `UnavailableLegacy` | mission criteria with verdict `Unknown` |

For `Available`, the read model must verify that stored results are non-null,
complete, ordered and criterion-identical before projecting. Corrupt state is
a typed read failure, not an `Unknown` fallback. Evidence IDs remain exposed by
the existing evidence surface; the read model does not synthesize them.

This rule applies to the per-Work Verification view and every concluded
Verification rendering. An Open Workspace-detail Verification remains
`Pending` and therefore continues to show `Unknown` criteria.

### F18-V2-6 — Acceptance semantics remain unchanged

Parent Acceptance still requires the exact canonical current-revision
Verification `Pass` and its established result reference. Public display does
not grant completion authority. A required `Unknown` criterion continues to
aggregate to `Unknown`; this package never coerces it to `Pass`.

## 5. Required implementation evidence after acceptance

1. Exhaustive writer tests: every current catalog type has one exact writer
   row; only `VerificationConcluded` writes v2; it cannot write v1; every other
   type writes only v1; unknown type and unsupported pair fail before append.
2. Exhaustive reader tests: `VerificationConcluded` v1/v2 accepted by their
   distinct strict decoders; unknown type v1, arbitrary other v2, malformed
   supported payload and every v3 are atomically CC-3 quarantined with offset
   advance.
3. Consumer-loop tests proving v2 reaches workflow delivery while an unrelated
   v2 remains poison; SQLite runner, rebuild and the raw
   `runAttentionPollOnce` path use the same pair table and yield the same
   unsupported-pair disposition.
4. Full live and reconciliation matrix for child/Root × Pass/Fail/Unknown,
   including G5 receipt v1, ordinary receipt v2, exact channel-1 clears,
   owner/Parent reevaluation and proof that no extra Inbox is created. Receipt
   tests bind exact `channel1Release` and the verdict-specific `wakeSignals`.
5. Inbox tests for absent, exact unconsumed, exact consumed, wrong recipient,
   wrong kind/summary/correlation/admittedAt and duplicate-key rows. Every
   conflict must become durable Attention without mutation.
6. State-machine tests for every transition, invalid phase, digest drift,
   lease expiry/takeover and synchronized two-daemon CAS. Kill/restart both
   before and after every side effect and every disposition commit; prove
   unique Inbox, no Provider/Verifier/command replay, retained dead letter and
   unchanged consumer offset. Expected lost-lease CAS stops without Attention;
   generation regression creates the exact Attention fact.
7. Attention tests for every fixed failure code, pre-decode failure with null
   EventId, exact Root routing, fact/dedup identity, atomic state+fact commit,
   `ActionRequired` severity, fixed public summary/failureCode/time, projector
   retained live-queue admission, claim/takeover CAS, queue+marker atomic
   commit, projector crash/restart, full rebuild and immutable-field conflict.
8. Projection tests for all four snapshot statuses. `Available` must expose
   exact Pass/Fail/Unknown criterion values; null, malformed, incomplete,
   reordered, mission-mismatched, duplicate or evidence-mismatched
   `Available` snapshots are typed read failures rather than `Unknown`.
9. The real public F18 journey: exact criterion `Pass`, Parent ready-result
   Inbox, Parent `accept_result`, Acceptance and child Work completion.
10. Adjacent Verification/Acceptance, `pnpm typecheck`, Biome, architecture,
   focused process restart and the default functional gate.
11. Reason-wire tests: every new ordinary v2 row/event/result contains explicit
    null; omission/empty string cannot be written; G5 remains exact Orphaned.
    Migration captures immutable per-Project high-water. Only the complete
    pre-high-water empty/null/omitted legacy tuple reconciles; post-high-water,
    partial, G5 and fresh-Project variants become the exact Attention.

## 6. Explicit non-solutions

- Do not raise a global numeric ceiling to 2.
- Do not treat `Unknown` as `Pass` or hide the criterion.
- Do not infer criterion verdicts from the aggregate verdict or Evidence
  existence.
- Do not reset all consumer offsets or delete dead letters without an accepted
  migration/recovery contract.
- Do not re-run Provider or Verifier work to compensate for a delivery-reader
  defect.
- Do not edit `docs/design/**` before manual acceptance of a fixed landing
  package.

## 7. Requested decision token

```text
ACCEPT_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_OPTION_A
```

Acceptance authorizes only exact design landing and post-landing review. Code,
migration, existing-database reconciliation and release qualification require
a separate implementation authorization.
