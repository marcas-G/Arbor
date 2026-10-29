# AH14 legacy action-disposition Attention — fixed governance package

Status: **fixed proposal for manual acceptance; planning-only**

Proposed design-only acceptance token:
`ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`
Implementation requires a separate explicit authorization after owner landing
and consistency review. This package authorizes no database migration, product
code, deployment, or preserved-database operation.

## 1. Scope and frozen disposition

This package covers exactly one AH14 failure class: a legacy successful
Provider result has a uniquely bound Execution, ProviderTurn, AgentLoopStep,
and decoded action list, but the durable evidence cannot prove the disposition
of at least one decoded action. Its failure code is exactly
`LegacyActionDispositionUnproven`.

The code path must stop before adopting the legacy result as
`ProviderResultAvailable`. It leaves the Step, action ledger, Session output,
and Execution settlement unchanged. It must not issue a Provider request,
execute or replay an action, append sourced output, or create an action
Command. Other legacy failures—including missing/contradictory Execution,
ProviderTurn, Step, Manifest, decoder, or repair-attempt identity—remain on
their existing typed fail-closed path and are outside this package.

Positive adoption remains unchanged: complete successful evidence with no
actions or effect ambiguity follows the existing `ProviderResultAvailable`
adoption path and produces no AH14 Attention.

## 2. P9 immutable failure fact and stable identity

P9 owns the immutable `LegacyAdoptionEvidenceEscalated` event and
`legacy_adoption_attention_facts` relation. A fact records:

| Field | Contract |
|---|---|
| `attention_fact_id` | Deterministic `att_` identifier derived from Execution and evidence fingerprint |
| `event_id` | Unique P1 journal event identity |
| `project_id` | Exact Execution project |
| `execution_id` | Exact recovering Execution |
| `workspace_id` | Exact `executions.workspace_id` at detection |
| `provider_turn_id` | Exact uniquely bound legacy ProviderTurn |
| `logical_step_no`, `repair_attempt` | Exact uniquely bound AgentLoopStep identity |
| `failure_code` | Closed check: `LegacyActionDispositionUnproven` |
| `evidence_sha256` | Lowercase SHA-256 of the canonical v1 evidence tuple |
| `first_detected_at` | First P1 transaction-scoped clock value; immutable on retry |

`attention_fact_id` is `att_` plus lowercase SHA-256 of canonical UTF-8 JSON
for `{version:1, executionId, evidenceSha256}`. The table enforces a unique
`(execution_id, evidence_sha256)` tuple, a unique `event_id`, and the exact
project/Execution/Workspace/ProviderTurn parent bindings. An exact retry
returns the original fact and event; a conflicting payload for the same tuple
is a typed invariant failure.

The evidence tuple is a canonical JSON v1 object with these fields, in this
logical shape:

```json
{
  "version": 1,
  "executionId": "...",
  "projectId": "...",
  "workspaceId": "...",
  "episode": {"kind": "...", "ref": "...", "revision": 0},
  "step": {
    "logicalStepNo": 0,
    "repairAttempt": 0,
    "providerTurnId": "...",
    "manifestId": "...",
    "decoderVersion": "..."
  },
  "providerSuccess": {
    "attemptNo": 0,
    "evidenceVersion": "...",
    "finishReason": "...",
    "settledAt": "...",
    "canonicalEventsSha256": "..."
  },
  "actions": [
    {
      "actionIndex": 0,
      "logicalActionId": "...",
      "callRef": "...",
      "toolName": "...",
      "toolSchemaVersion": "...",
      "inputHash": "...",
      "stableActionId": "...",
      "actionVersion": "...",
      "argumentsSha256": "...",
      "disposition": {"_tag": "Missing"}
    }
  ],
  "failureCode": "LegacyActionDispositionUnproven"
}
```

For this scope, `executionId`, `projectId`, `workspaceId`, `providerTurnId`,
`logicalStepNo`, `repairAttempt`, and each decoded action's ordinal,
`logicalActionId`, `callRef`, `toolName`, `toolSchemaVersion`, and `inputHash`
are required and validated before fact creation. `actionIndex` is the
zero-based ordinal in the decoded action array and is unique within that step.
Optional source fields use the exact object `{"_tag":"Missing"}`;
JSON `null`, omission, and empty string are not interchangeable. Action rows
are sorted by `(actionIndex, logicalActionId, callRef)`. Object keys are
recursively sorted by Unicode code point, strings are NFC-normalized, arrays
retain the specified order, numbers are base-10 integers, and serialization
uses UTF-8 without insignificant whitespace. `evidence_sha256` hashes those
canonical bytes.

The tuple stores hashes and bounded canonical references only. It does not
copy Provider text, arguments, raw database errors, or host paths. The P9 event
payload is exactly `factId`, `attentionFactId`, `projectId`, `executionId`,
`targetWorkspaceId`, `providerTurnId`, `logicalStepNo`, `repairAttempt`,
`failureCode`, `evidenceSha256`, and `firstDetectedAt`; `factId` and
`attentionFactId` both equal `attention_fact_id`. Actor is `system:recovery`,
aggregate is the exact `executionId`, and the event version is 1.

## 3. P9 atomicity and recovery order

The check runs under the current unexpired Execution lease. P9 validates the
legacy successful result and action evidence first. If disposition remains
unprovable, one P1 `TransactionScope` rechecks the fence and atomically inserts
the immutable event and fact. It does not mutate the Step, action ledger,
Session, or canonical settlement. After commit, recovery returns a typed
blocked disposition and releases the current lease through the normal path.

Crash behavior is fixed:

- Before commit: neither fact nor event exists. Recovery recomputes the same
  tuple and retries; it performs no Provider/action/output work.
- After commit: both exist. Recovery finds the same fact and blocks without a
  duplicate event, Step transition, Provider request, action, or Session
  append.
- A transaction/storage failure remains fail-closed. Recovery makes no
  durable-Attention claim and does not adopt or replay the result.
- A stale/expired generation cannot read or write through this path after the
  existing lease-fencing boundary.

## 4. P10 source, target, DTO, and rebuild

P10 registers exactly the source name `LegacyAdoptionEvidenceInsufficient`
with severity `ActionRequired`. The target is the exact
`executions.workspace_id` stored on the P9 fact; the internal source binding
retains `executionId` for authorization and Work-episode freshness checks.
The public row contains:

- `source = LegacyAdoptionEvidenceInsufficient`;
- `severity = ActionRequired`;
- `targetWorkspaceId` from the immutable fact;
- `dedupKey = attentionFactId`;
- `failureCode = LegacyActionDispositionUnproven`;
- fixed summary: `Legacy action outcome cannot be proven; operator review is required.`
- `occurredAt = firstDetectedAt`.

No Provider payload, action arguments, evidence tuple, digest, path, or error
text is exposed by the public list row. P10 authorizes only a reader whose
project/Workspace scope covers the exact target.

The additive marker table `legacy_adoption_attention_rows` has a primary key
`(project_id, attention_fact_id)`, the exact `workspace_id`, and a composite
foreign key to the matching P9 fact. The consumer commits marker insertion and
offset acknowledgement together. Pre-commit crash leaves neither; post-commit
crash leaves both; replay cannot duplicate the row.

Before applying either failure or resolution, the P10 consumer verifies the
event against the immutable P9 fact row field by field. It verifies
`event_id`, `event_type`, `event_version`, `project_id`, exact
`aggregate_ref=execution_id`, `targetWorkspaceId=workspace_id`,
`factId`, `attentionFactId`, every failure/resolution hash, `correlation_ref`,
`caused_by_command_id`, `caused_by_event_id`, actor, `occurred_at`, and exact
payload key set. For a failure event, `factId == attentionFactId ==
failure.attention_fact_id` and `evidenceSha256 == failure.evidence_sha256`.
For a resolution event, `factId == resolution.resolution_fact_id`,
`attentionFactId == resolution.attention_fact_id == failure.attention_fact_id`,
`originalEvidenceSha256 == failure.evidence_sha256`, and
`resolutionEvidenceSha256 == resolution.resolution_evidence_sha256`.
A failure event has `event_id=fact.event_id`,
`event_type=LegacyAdoptionEvidenceEscalated`, `event_version=1`,
`project_id=fact.project_id`, `aggregate_ref=fact.execution_id`,
`correlation_ref=fact.attention_fact_id`, `caused_by_command_id=NULL`,
`caused_by_event_id=NULL`, actor `system:recovery`, and
`occurred_at=fact.first_detected_at`. Its payload `factId` and
`attentionFactId` both equal `fact.attention_fact_id`; every other payload
field equals its exact fact value, with `targetWorkspaceId` mapped from
`workspace_id`, `evidenceSha256` from `evidence_sha256`, and
`firstDetectedAt` from `first_detected_at`. Its exact payload key set is
`factId`, `attentionFactId`, `projectId`, `executionId`,
`targetWorkspaceId`, `providerTurnId`, `logicalStepNo`, `repairAttempt`,
`failureCode`, `evidenceSha256`, and `firstDetectedAt`.

A resolution event has `event_id=resolution.event_id`,
`event_type=LegacyAdoptionEvidenceResolved`, `event_version=1`,
`project_id=resolution.project_id`, `aggregate_ref=resolution.execution_id`,
`correlation_ref=resolution.attention_fact_id`,
`caused_by_command_id=NULL`,
`caused_by_event_id=originalFailureEventId`, actor `system:recovery`, and
`occurred_at=resolution.resolved_at`. Its exact payload key set is
`factId`, `attentionFactId`, `projectId`, `executionId`,
`targetWorkspaceId`, `providerTurnId`, `originalEvidenceSha256`,
`resolutionEvidenceSha256`, `resolutionCode`, and `resolvedAt`. Its payload
`factId` equals
`resolution.resolution_fact_id`, `attentionFactId` equals the original failure
fact ID, `targetWorkspaceId` maps to `resolution.workspace_id`,
`originalEvidenceSha256` equals the failure fact's `evidence_sha256`,
`resolutionEvidenceSha256` equals the resolution row's
`resolution_evidence_sha256`, and every other field equals the exact
corresponding resolution row value.

A missing fact, wrong event envelope, extra/missing payload field, tuple
conflict, or hash mismatch is typed corruption: no marker write/delete occurs
and the consumer offset does not advance. Validation precedes mutation; marker
insert/delete and offset acknowledgement remain one transaction, so malformed
events cannot be partially consumed.

P10 full rebuild atomically clears this marker source, snapshots retained P9
failure and resolution facts, recreates unresolved markers, and rewinds the
owned offset under the existing rebuild contract. P9 facts are the rebuild
authority, not retained P1 journal events. The P9 failure and resolution facts
are permanent in v1; P10 markers are rebuildable. No external object store or
raw Provider snapshot is added by this package.

## 5. Evidence-driven resolution

There is no human dismiss command and no timeout-based clearing. Repeated
recovery never clears the row or guesses disposition.

If new authoritative canonical evidence proves the exact disposition for the
original failure fingerprint, P9 may resume the ordinary legacy-adoption
path. The original `evidence_sha256` remains immutable. Resolution evidence
has its own `resolution_evidence_sha256` and binds to every decoded action in
the original failure tuple, one-for-one. The action array is the complete
decoded set, not merely actions whose disposition was ambiguous. Each row
includes the original ordinal and full stable identity, plus exact P4 terminal
settlement/observation evidence or a closed terminal no-effect denial. Its
canonical JSON v1 tuple is:

```json
{
  "version": 1,
  "attentionFactId": "...",
  "originalEvidenceSha256": "...",
  "executionId": "...",
  "providerTurnId": "...",
  "logicalStepNo": 0,
  "repairAttempt": 0,
  "resolutionCode": "DispositionProvenSettled",
  "actionDispositionSummarySha256": "...",
  "actions": [
    {
      "actionOrdinal": 0,
      "logicalActionId": "...",
      "callRef": "...",
      "toolName": "...",
      "toolSchemaVersion": "...",
      "inputHash": "...",
      "disposition": "Applied",
      "p4": {
        "toolInvocationId": "...",
        "actionId": "...",
        "executionId": "...",
        "logicalActionId": "...",
        "callRef": "...",
        "toolName": "...",
        "toolVersion": "...",
        "argumentsSha256": "...",
        "sideEffectSemantics": "...",
        "effectAdmissionState": "...",
        "terminalDisposition": "Success",
        "effectClass": "...",
        "settlementKind": "Success",
        "settlementVersion": "...",
        "settlementSha256": "...",
        "settledAt": "...",
        "resultRef": "...",
        "resultSha256": "...",
        "observationRef": "...",
        "observationFormatVersion": "...",
        "observationSha256": "...",
        "observationEvidenceVersion": "...",
        "observationEvidenceSha256": "..."
      }
    }
  ]
}
```

Every decoded action appears exactly once, in ascending `actionOrdinal`; the
resolution identities must equal the original failure tuple identities
`(actionIndex, logicalActionId, callRef, toolName, toolSchemaVersion,
inputHash)` one-for-one, with `actionOrdinal == actionIndex`. Both ordinals are
the zero-based position in the frozen decoded-action array. `inputHash` is
SHA-256 over canonical action input bytes under the original decoder contract.
Every P4 Action/ToolInvocation
identity, disposition/effect class, settlement/result/observation reference,
evidence version, and hash is represented. An inapplicable optional value is
exactly `{"_tag":"Missing"}`, never null, omitted, or empty. The same v1
encoding rules as the failure tuple apply: recursively sort object keys by
Unicode code point, NFC-normalize strings, preserve specified array order,
encode numbers as base-10 integers, and serialize UTF-8 without BOM or
insignificant whitespace. Define
`resolution_evidence_sha256 = lowercaseHex(SHA256(canonicalUtf8Bytes(tuple)))`.
No database-generated or wall-clock value participates in this hash.

The decoded action set must be non-empty. Compute the only permitted
`resolutionCode` from the complete ordered `actions` array:

| Complete action dispositions | `resolutionCode` |
|---|---|
| Every action is `NotAdmitted` | `DispositionProvenNotAdmitted` |
| At least one action is `Applied`, and every action is `Applied` or `NotAdmitted` | `DispositionProvenSettled` |
| Empty set or any other/missing/unknown disposition | No resolution is valid |

`actionDispositionSummary` is the canonical UTF-8 JSON array projected from
the action rows, containing only each action's ordinal, complete stable
identity (`logicalActionId`, `callRef`, `toolName`, `toolSchemaVersion`,
`inputHash`) and disposition. Its SHA-256 is
`actionDispositionSummarySha256`, included in the canonical resolution tuple
above. It contains no raw action input, Provider text, or P4 result payload.
P9 recomputes the summary hash and resolution code from the complete validated
action rows before inserting the immutable resolution fact/event; it rejects
an empty action set or a caller-supplied code that differs from the derived
code as typed corruption. `resolutionCode` and
`actionDispositionSummarySha256` are part of the canonical tuple, so both are
bound by `resolution_evidence_sha256` and the deterministic resolution fact ID.

For `disposition=Applied`, the exact immutable P4 Action and ToolInvocation
must bind the same project, Execution, ProviderTurn/Step, repair attempt,
LogicalActionId, callRef, tool name, tool schema/executor version, and input
hash as that decoded action. The terminal settlement must identify that same
ToolInvocation and include its terminal disposition (`Success` or
`ExpectedFailure`), effect class, settlement version/hash and settled time,
plus the canonical result reference/hash. The exact P4 Observation must bind
the same ToolInvocation/action and include `observationRef`,
format/evidence version and SHA-256. No cross-invocation, cross-step, or
merely similarly named evidence is admissible. `OutcomeUnknown`,
`RuntimeFailure`, a missing settlement/result/Observation, mismatched hash or
binding, or a merely present action row is not proof. Any such case leaves
Attention active.

For `disposition=NotAdmitted`, there must be an immutable exact P4 Action and
ToolInvocation settlement with `effectAdmissionState=NotAdmitted`,
`settlementKind=Denied`, `terminalDisposition=Denied`, and a reason code in
the closed P4 `TerminalNoEffectDenialCode` enum:
`InvocationAuthorityDenied`, `ApprovalRejected`, `ApprovalNotFound`,
`ApprovalMismatch`, `ApprovalExpired`, `ApprovalConsumedByOtherInvocation`,
`ResourceResolutionDenied`, `ResourceAdmissionDenied`, or
`ApprovalNoLongerAuthorized`. Historical `ApprovalRequired` is excluded as
nonterminal. The exact denial settlement and its hash/version/time must bind
the same P4 Action/ToolInvocation and decoded action identity; store the code
as `terminalNoEffectDenialCode`. An absent P4 row, missing settlement, human
assertion, restart without an observed effect, or absence of a result is not
no-effect proof. For NotAdmitted, result/Observation fields are explicit
`Missing` markers and the immutable terminal denial settlement is mandatory.

Before writing a resolution fact/event, P9 compares the resolution action set
with the original decoded set: same cardinality, exact ascending ordinal
sequence, and exact one-to-one identity match. Every action must satisfy
exactly one of the `Applied` or `NotAdmitted` evidence rules. A missing,
duplicated, reordered inconsistently, mismatched, or insufficiently evidenced
action rejects the entire resolution; P9 writes no resolution fact/event and
P10 keeps the Attention active. Partial resolution is forbidden.

The immutable resolution fact stores the canonical
`action_disposition_summary_json`, its `action_disposition_summary_sha256`,
and derived `resolution_code` alongside `resolution_evidence_sha256`. On P10
consumption/rebuild, recompute the summary SHA and derive the expected code
using the same non-empty mapping above. Require equality among the recomputed
code, immutable resolution fact's `resolution_code`, and event payload's
`resolutionCode`; require the stored summary hash to equal the summary hash
bound into the resolution tuple. Any empty/invalid summary, hash mismatch, or
code mismatch is typed corruption before marker deletion/offset advancement.

The resolution fact ID is `alr_` plus lowercase SHA-256 of canonical UTF-8
JSON bytes for exactly
`{version:1, attentionFactId, originalEvidenceSha256,
resolutionEvidenceSha256, resolutionCode}` using the canonical serializer
above. `resolutionCode` is deliberately included directly in this ID input as
well as in the resolution tuple and its hash.
`resolution_evidence_sha256` is the SHA-256 of the complete resolution tuple
defined above. An exact retry with the same original fact and same canonical
resolution tuple returns the original resolution fact/event and timestamp.
Any different tuple/hash for an already-resolved `attention_fact_id` is typed
corruption and cannot overwrite or create another resolution.
`legacy_adoption_attention_resolution_facts`
enforces a unique `attention_fact_id`, unique event ID, and the exact P9
failure-fact FK. Only after every action in the original
decoded set passes the rules above may P9 resolve the Attention. In the same
transaction as the normal Step adoption/progression, P9 writes an immutable
`LegacyAdoptionEvidenceResolved` event and
`legacy_adoption_attention_resolution_facts` row referencing the original
`attention_fact_id`, original `evidence_sha256`, exact `execution_id`,
`provider_turn_id`, resolution code, resolution-evidence SHA-256, and
`resolved_at`. A unique `attention_fact_id` permits one resolution only. The
accepted resolution codes are `DispositionProvenNotAdmitted` and
`DispositionProvenSettled`; the latter requires exact same-invocation P4
terminal evidence and cannot be inferred from external absence.

`legacy_adoption_attention_resolution_facts` has `resolution_fact_id` primary
key, unique `attention_fact_id` foreign-keyed to the failure fact, unique
`event_id`, exact project/Execution/Workspace/ProviderTurn bindings, the
original `evidence_sha256`, `resolution_evidence_sha256`, canonical bounded
`action_disposition_summary_json`, its SHA-256, derived closed
`resolution_code`, and `resolved_at`. Its deterministic ID is the five-field
formula above; no alternate formula is permitted. The resolution event payload
has exactly `factId`, `attentionFactId`, `projectId`, `executionId`,
`targetWorkspaceId`, `providerTurnId`, `originalEvidenceSha256`,
`resolutionEvidenceSha256`, `resolutionCode`, and `resolvedAt`; it contains no
raw action/Provider text. P10 validates this payload and the full event
envelope against both immutable P9 facts before deleting the marker. A bad
binding is typed corruption, leaves the marker untouched, and leaves the
consumer offset unchanged.

P10 consumes the resolution event and removes only that fact's active marker.
The immutable failure fact and resolution fact remain for audit and rebuild.
If exact authority evidence never appears, the Attention remains active. If
the evidence proves a may-have-started P4 side effect, recovery follows the
existing P4 reconciliation/OutcomeUnknown contract before it can resolve this
AH14 source.

## 6. Migration and implementation boundary

Current activated schema is 44. The migration ID for these relations is
assigned at owner-document landing as the next available version after the
then-current activated prefix. This proposal does not reserve migration 45.
The implementation authorization must separately pin the actual ID, exact
SQL hash, ordered offline-upgrade prefix, current runtime target, and fixture
baseline before code or migration qualification begins. No prior migration is
renumbered or edited.

Owner documents for the accepted package are P1 `03-transaction-model.md` and
`04-sqlite-schema.md`; P9 `02-fault-injection-matrix.md` and
`07-agent-loop-step-recovery.md`; P10 `02-attention-readmodel.md`,
`04-rebuild-atscale.md`, and `07-acceptance.md`. P4
`06-invocation-persistence-reconciliation.md` §§1–3 is a reference-only
dependency for the exact NotAdmitted/Denied/Applied terminal evidence listed
above; this package requests no P4 semantic change. P9 owns the immutable
source facts and recovery transaction; P10 owns the source mapping,
event-to-fact validation, marker/query, rebuild, and projection lifecycle; P1
owns shared SQLite and transaction contracts.

## 7. Required qualification matrix

1. Reproduce the current ambiguous-action RED from an equivalent disposable
   schema fixture. Prove the exact failing tuple and zero canonical Step/action/
   Session/settlement/provider changes before the fact transaction.
2. Verify the canonical v1 tuple, explicit Missing markers, ordering, hashes,
   deterministic ID, uniqueness, first-writer time, and conflicting-payload
   rejection. Include non-empty/all-NotAdmitted→NotAdmitted,
   mixed-or-all-Applied→Settled, empty-set rejection, and caller-supplied code
   mismatch cases.
3. Kill before and after P9 fact/event commit. Before: neither exists and the
   same key is retried. After: one immutable pair exists and recovery blocks
   without a new Provider/action/output.
4. Kill before and after P10 marker/offset commit; verify atomicity, exact
   Workspace target, `ActionRequired` row, safe summary, and replay
   deduplication.
5. Mutate each failure/resolution event envelope field independently
   (`eventId`, type, version, project, aggregate/execution, Workspace target,
   attention/fact ID, failure/original/resolution evidence hash, correlation,
   causation, actor, occurrence time, resolutionCode/action-summary binding,
   and payload key set). Each mismatch must
   return typed corruption, write no marker/clear, and leave the offset fixed.
6. Repeat recovery and restart at least twice; verify identical fact ID,
   timestamp, resolution, and one public row. Prove unauthorized Workspace
   reads do not expose the row.
7. Rebuild after pruning the original P1 event while retaining P9 facts; verify
   exactly the unresolved row is reconstructed. Resolve only against the exact
   original fact fingerprint plus matching authoritative disposition
   evidence; prove only its marker is removed while failure and resolution
   facts remain.
8. Prove no human dismiss, timeout, P4 effect uncertainty, malformed identity,
   or different evidence fingerprint can clear/adopt this failure.
9. Keep the positive AH14 equivalent fixture green at both existing process
   boundaries and repeated restart; one sourced answer and one Provider
   request, no AH14 Attention.
10. Qualify the additive migration from the then-current activated schema
   prefix, interruption/resume, foreign keys/indexes, runtime readiness,
   offline CLI, and fixture conversion. Use only fresh/test-owned or explicitly
   disposable copies; never open or upgrade the preserved database.

## 8. Acceptance boundary

Acceptance of token
`ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE` accepts only this
design package and its named owner-document landing. It does not authorize
implementation, the migration, CLI/schema-target activation, preserved
database access, deployment, or publication. Those require separate explicit
authorization after landing review.
