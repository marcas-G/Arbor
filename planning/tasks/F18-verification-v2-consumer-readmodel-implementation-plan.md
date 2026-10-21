# F18 Verification v2 Consumer and Read-model Convergence — SHA-pinned Implementation Plan

Status: **planning only; manual acceptance and implementation authorization requested**  
Date: 2026-10-21  
Implementation baseline: `fcc2e64287ef2be73301631e0d4322cd3c9e8c9b`

## 1. Fixed inputs

- Governance proposal:
  `planning/proposals/F18-verification-v2-consumer-and-readmodel-convergence-draft.md`
- Proposal SHA-256:
  `C6C41E96C5A59B46810DB9FA7A998DDBC5887B93D75ADF3606E0CA25E351EC73`
- RED evidence:
  `planning/results/F18-verification-v2-consumer-readmodel-red.result.md`
- Evidence SHA-256:
  `0FA66DDC6D4D97932855C11E459A86E2C0365C7228C85FAF5727BE85E638B49B`
- Required design token:
  `ACCEPT_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_OPTION_A`
- Required implementation token:
  `AUTHORIZE_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_IMPLEMENTATION`

The user may provide both tokens once. Their ordering remains mandatory:
acceptance first authorizes only exact owner-document landing; implementation
authorization becomes effective only after that landing has an independent
B0/B1/B2=`0/0/0` review. A failed landing review stops all code work.

## 2. Non-negotiable boundaries

- Do not raise a global event-version ceiling.
- Do not accept unknown type v1 or an unregistered type/version pair.
- Do not rewrite historical journal, receipt, dead-letter or consumer-offset
  bytes.
- Do not turn criterion `Unknown` into `Pass`, infer a criterion from aggregate
  verdict/Evidence existence, or widen Acceptance authority.
- Do not replay ConcludeVerification, RetryVerification, Verifier, Provider or
  a model turn during historical reconciliation.
- Do not reset consumer offsets or delete dead letters.
- Do not run migration 0051 against the current online/preserved database.
  Implementation qualification uses fresh databases and disposable consistent
  copies only until a later release/upgrade decision.
- A mismatch becomes the fixed Root-targeted ActionRequired Attention; it is
  never silently skipped, repaired from Work text, or moved to another target.

## 3. Ordered implementation DAG

```text
F18-00 exact design landing + independent review
  → F18-01 exact event type/version registry and strict codecs
  → F18-02 corrected VerificationConcluded v2 writer/receipt
  → F18-03 schema 0051 + stores + activation high-water
  → F18-04 all reader paths and live workflow dispatch
  → F18-05 historical reconciliation + P10 live Attention queue
  → F18-06 Verification criterion read model
  → F18-07 layered qualification and public F18
  → F18-08 full gates, evidence, upgrade/runbook
```

No later wave may be used to claim an earlier wave passed.

## 4. F18-00 — owner-document landing

Apply only the accepted proposal to the documents that own each semantic:

- P1 `05`: exact 57-key writer/reader pair table, unknown-pair poison, no
  numeric ceiling, writer validation before sequence allocation;
- P8 `01`/`04`: explicit-null reason for new v2, exact ordinary receipt
  projection, G5 exception and bounded `LegacyAbsentReasonV2` compatibility;
- P9 consumer/recovery implementation document: durable reconciliation
  identity, lease/generation phases, crash boundaries and no replay authority;
- P10 `02` and rebuild contract: fixed F18 fact/source, Root target,
  ActionRequired public row, retained queue live admission and fact rebuild;
- P13 `03`: four-state criterion projection and corrupt-Available typed failure;
- DID governance/version summary plus acceptance/landing record.

Record the accepted proposal/evidence hashes. Run an independent consistency
review against P1/P8/P9/P10/P13 and the DID. Required result is
B0/B1/B2=`0/0/0`; otherwise stop and return to manual governance.

## 5. F18-01 — exact version registry and decoders

Add one provider-neutral domain registry whose keys are exactly the current 57
`EVENT_CATALOG` names:

- `VerificationConcluded`: writer `{2}`, reader `{1,2}`;
- each explicitly frozen other name: writer `{1}`, reader `{1}`;
- no default row.

Expose separate checks for new-write pair and stored-reader pair plus strict
versioned payload decoding. Architecture tests compare registry keys and
`EVENT_CATALOG` keys in both directions and fail on additions/removals.

Wire the writer check into every durable/in-memory journal append before
sequence allocation or insert. Wire the reader check and matching decoder into:

- Application `pollOnce`;
- SQLite `runConsumerBatch`;
- raw `runAttentionPollOnce`;
- journal raw decoding;
- rebuild/replay readers and test doubles.

Unsupported pairs take the existing atomic CC-3 dead-letter+offset path.
Unknown type v1 is unsupported. Valid `VerificationConcluded` v2 must reach
ordinary projection and workflow handlers; unrelated consumers may ignore it
only after successful common apply.

## 6. F18-02 — corrected v2 conclusion bytes

Change new ordinary v2 output so canonical row, event and schema-v2 result/
receipt all carry the property `conclusionReason: null`. Empty string and
omission fail before commit. G5 continues to carry exact `Orphaned`.

The strict result codec and replay validator bind:

- common Verification identity/verdict/summary/mission/criteria/status/reason;
- event Work/revision/Evidence against the canonical row;
- result state `Concluded`;
- exact `channel1Release` Work/revision;
- exact verdict-specific `wakeSignals` from the accepted matrix.

Do not relabel or rewrite any existing v1/v2 bytes. Ordinary command replay
must continue returning its original receipt after exact validation.

## 7. F18-03 — schema 0051 and persistence

Reserve migration **0051**, `requiresUserVersion: 50`, name
`verification_v2_consumer_reconciliation`. If the integration owner finds any
other registered 0051 at landing time, stop for migration rebase review; do
not renumber locally or overwrite it.

Migration 0051 creates five physical stores:

1. `verification_conclusion_v2_activation_highwaters`
   - `project_id` primary key;
   - immutable `max_event_sequence`, `captured_at` and fact digest;
   - one row for each Project existing at migration commit; later Projects get
     no legacy compatibility row.
2. `verification_signal_reconciliations`
   - primary key `(consumer_id, project_id, event_sequence)` with consumer
     fixed to `workflow-signals`;
   - nullable verified Event/command/Verification/Work/route identities;
   - verdict, source/effect digests, exact phase, failure code;
   - lease owner/generation/expiry and timestamps;
   - partial unique `(project_id,event_id)` for non-null EventId.
3. `verification_signal_reconciliation_attention_facts`
   - append-only stable fact ID/source identity/failure/evidence digest;
   - exact Root target and first-detected time;
   - FK/identity binding to the reconciliation row.
4. `verification_signal_reconciliation_attention_queue`
   - primary key `(project_id,attention_fact_id)`;
   - `Pending|Projected`, lease owner/generation/expiry;
   - FK to the immutable fact.
5. `verification_signal_reconciliation_attention_rows`
   - P10 marker keyed by `attention_fact_id`, FK to the fact;
   - no duplicated mutable summary/target authority.

CHECK constraints enforce state/phase nullable fields and terminal states.
Triggers or store-level guarded writes reject updates to high-water/fact
identity. Migration captures high-water in the same offline transaction after
preflight, creates no reconciliation facts, and does not touch offsets,
deadletters, events, receipts or Inbox.

Update current migration registry, offline upgrade CLI and schema-51 startup
gate. Qualify clean 50→51, rollback, re-entry, invalid/colliding schema,
high-water exactness, FK/integrity and disposable-copy startup. No live DB.

## 8. F18-04 — current event delivery

Update WorkflowSignal v2 decoding to require the corrected exact payload and
use the existing effect matrix:

- every verdict: exact channel-1 wait release;
- Fail/Unknown: owner `VerificationReturned` reevaluation;
- child Pass: exact Parent Inbox row, commit, then Parent `InputArrived`;
- Root Pass: no Parent effect.

Refactor live and recovery paths to share pure source validation, effect-plan
derivation, exact Inbox-row validation and public Attention mapping. Do not
share a mutation transaction across components whose existing scheduler ports
own independent transactions; retain idempotent after-effect dispositions.

## 9. F18-05 — historical reconciliation and P10 live admission

Before daemon readiness/new Agent dispatch, and then in bounded periodic
sweeps, scan only workflow dead letters for:

- `unsupported eventVersion 2`; or
- `malformed event payload` with raw `VerificationConcluded` v2.

Validate exact deadletter/event/Project/canonical/receipt/route bytes. The
second reason may use `LegacyAbsentReasonV2` only under the immutable Project
high-water and exact empty/null/omitted tuple. Create `Pending` only after full
proof; pre-proof failures go directly to atomic Attention state+fact+queue.

Implement the accepted phase machine with generation-fenced CAS. Run each
effect before committing its disposition. Retry only idempotent effects after
crash. Parent Inbox admission and `ParentInboxCommitted` are one transaction;
Parent wake follows that commit. Preserve exact consumed Inbox rows and reject
every wrong recipient/kind/key/summary/correlation/time or duplicate row.

The P10 poll scans the retained queue independently of journal offsets. It
claims by lease/generation, atomically writes/validates marker plus `Projected`,
and exposes the fixed Root-targeted ActionRequired row by marker→fact join.
Rebuild enumerates facts and converges marker+queue in one transaction.

Add explicit qualification probes at every effect/disposition boundary and
tests for synchronized two-daemon competition, lease expiry/takeover, stale
generation, process kill before/after every commit, Attention conflicts,
unchanged offset/deadletter and absence of Provider/Verifier/command replay.

## 10. F18-06 — exact criterion read model

Replace the obsolete hard-coded concluded `Unknown` projection:

- Pending → mission criteria as Unknown;
- Available → exact stored ordered criterion verdicts;
- NotApplicableOrphaned → exact empty list;
- UnavailableLegacy → mission criteria as Unknown.

Strictly validate `Available` completeness/order/mission fields/Evidence
ownership before rendering. Null, malformed, duplicate, reordered,
mission-mismatched or evidence-mismatched Available state yields typed
projection failure. It never falls back to Unknown. Workspace-detail Open
Verification remains Pending/Unknown.

## 11. F18-07 — layered functional qualification

Run in this order and stop at the first failed layer:

1. **L1 domain/codecs:** exhaustive 57-key registry, writer/reader pairs,
   explicit-null reason, G5, result projection, four-state read mapping.
2. **L2 stores/migration:** 0051 DDL/guards/high-water, state/fact/queue/marker,
   exact Inbox conflicts, immutable facts and typed corruption.
3. **L3 application:** generic poll, raw Attention poll, workflow matrix,
   legacy compatibility, P10 queue/rebuild, receipt/canonical mismatches.
4. **Process crash:** every reconciliation and P10 queue boundary, two daemons,
   restart and no duplicate side effect.
5. **Public F18:** real daemon/HTTP provider/filesystem child flow; public
   criterion `Pass`; Parent ready Inbox; `accept_result`; Acceptance; child
   Work Completed.
6. **Adjacent journeys:** recovery-verdicts Fail/Unknown/G5, Verification/
   Acceptance public/browser cases, consumer poison/rebuild, P10 Attention and
   schema-upgrade qualification.

No narrow PASS is reported as full closure.

## 12. F18-08 — full convergence and delivery evidence

After focused layers pass on one clean candidate HEAD:

```text
pnpm check
pnpm test:functional
```

Then repeat F18 from a clean checkout and run one disposable schema-50→51
upgrade/restart. Record commands, exact HEAD, counts, durations, omitted tests,
database disposition and hashes in
`planning/results/F18-verification-v2-consumer-readmodel-implementation.result.md`.
Update the module/acceptance matrix and operator runbook: public symptom,
Attention meaning, offline upgrade, restart behavior and recovery audit. Do
not claim release readiness while any full gate, crash boundary, landing
review, migration qualification or required user flow remains unproven.

## 13. Stop conditions

Stop and raise a new Design Gap if implementation needs to:

- accept another event pair;
- change the verdict/ownership effect matrix;
- infer/rewrite old reason or criterion bytes beyond the exact high-water
  compatibility tuple;
- reset offsets/delete deadletters;
- change Attention source/severity/target/summary/failure code/lifecycle;
- add an Acceptance shortcut or treat Unknown as Pass;
- run the migration on a preserved/online database.

The implementation is complete only when F18 and every required adjacent/full
gate are green and the current candidate contains no unresolved discrepancy.
