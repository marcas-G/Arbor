# AH7-DG-02 P39 physical-schema supplement (DRAFT)

Status: **supplemental physical-schema proposal only; not independently
accepted, not implemented, and not implementation-authorized**.

This supplement is subordinate to the accepted logical package
`AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md` at SHA-256
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`.
It selects a physical SQLite representation for those already-fixed concepts;
it does not change their meanings. If independent review finds a new business
decision is required, this supplement must be revised and accepted before any
owner-document landing or migration implementation.

## Baseline and ordering

The source checkout for this proposal is `db929654128b8e864d3733b95088f4edda0e4c43`.
It contains P35/P36 and is wired through P36. The separate green integration
candidate `C:\Arbor@f80` contains P35 only. P37 (AH10 Deliver) and P38
(Executable approval) are not integrated in this `db929` checkout. The only
reserved sequence is P36 → P37 → P38 → P39
`ah7_reconciliation_attempts`; P39 depends directly on P36 and P38, while P37
is required as the ordered `user_version` prefix. This proposal describes a
future P39 after that prefix; it does not assert that P39 or its prerequisites
are available in either current baseline. P39 must not be independently
implemented, shipped, or deployed ahead of P37/P38.

## Chosen physical representation

Use three append-preserving structures, all in the one SQLite P39 transaction:

1. A 1:1 immutable `tool_invocation_recovery_bindings` row stores a versioned
   canonical JSON encoding and SHA-256 digest of the exact RecoveryBinding.
   Canonical JSON is selected over duplicated scalar columns because the
   accepted binding is an exact versioned tuple and adding every tuple member
   as a separate mutable column would create parallel sources of truth. The
   runtime must canonicalize with the repository's existing canonical JSON
   codec; this document does not define a new JSON canonicalization algorithm.
2. `tool_invocation_effect_attempts` stores each admission attempt, keyed by
   `(invocation_id, attempt_no)`. The initial call is attempt 0; the sole
   permitted automatic retry is attempt 1. The row snapshots exact definition,
   profile, effect key, binding digest, and admission transition. Existing P36
   invocations receive a conservative attempt-0 row copied from the P36
   admission state; no profile, effect key, or source binding is fabricated.
3. `tool_reconciliation_facts` stores append-only, immutable proof outcomes
   scoped to one attempt. A deterministic fact ID makes exact redelivery
   idempotent; a different proof for the same attempt is retained as a distinct
   fact and is a proof conflict (StillUnknown), never an update that erases
   earlier evidence.

The P36 `tool_invocations` table is rebuilt only to extend its closed
`settlement_kind` set with `ReconciledNoEffect`, preserving all existing
columns, foreign keys, constraints, rows, and indexes. The top-level admission
state remains monotone: `NotAdmitted → MayHaveStarted`; legacy rows retain
`LegacyUnknown`. Per-attempt admission is also monotone. P39 must not permit a
Denied settlement for MayHaveStarted/LegacyUnknown or transition those states
back to NotAdmitted.

## Proposed schema contract and example SQL

The SQL below is an illustrative shape for independent review, not an
executable migration file. Names, types, and constraints are the proposed
P39-owned schema; migration code remains unauthorized.

```sql
-- Existing P36 tool_invocations is rebuilt in the same transaction so the
-- canonical P4 settlement union can add ReconciledNoEffect.
CREATE TABLE tool_invocations_p39 (
  invocation_id          TEXT PRIMARY KEY,
  execution_id           TEXT NOT NULL REFERENCES executions(execution_id),
  workspace_id           TEXT NOT NULL REFERENCES workspaces(workspace_id),
  tool_name              TEXT NOT NULL,
  tool_version           TEXT NOT NULL,
  side_effect_semantics  TEXT NOT NULL CHECK
                           (side_effect_semantics IN
                             ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  arguments_json         TEXT NOT NULL,
  resolved_regions_json  TEXT NOT NULL,
  approval_id            TEXT,
  effect_admission_state TEXT NOT NULL CHECK
                           (effect_admission_state IN
                             ('NotAdmitted','MayHaveStarted','LegacyUnknown')),
  recovery_binding_state TEXT NOT NULL CHECK
                           (recovery_binding_state IN
                             ('Bound','LegacyBindingUnproven','HistoricalSettled')),
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Denied','Interrupted',
                            'OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')),
  settlement_json        TEXT,
  result_ref              TEXT,
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL)),
  CHECK (recovery_binding_state <> 'HistoricalSettled' OR settled_at IS NOT NULL),
  CHECK (recovery_binding_state <> 'LegacyBindingUnproven' OR settled_at IS NULL),
  CHECK (settlement_kind <> 'Denied' OR
         (effect_admission_state = 'NotAdmitted' AND result_ref IS NULL)),
  CHECK (settlement_kind <> 'ReconciledNoEffect' OR
         (effect_admission_state = 'MayHaveStarted' AND result_ref IS NOT NULL))
);

CREATE TABLE tool_invocation_recovery_bindings (
  invocation_id          TEXT PRIMARY KEY
                           REFERENCES tool_invocations(invocation_id),
  binding_version        INTEGER NOT NULL CHECK (binding_version = 1),
  canonical_binding_json TEXT NOT NULL,
  binding_sha256         TEXT NOT NULL CHECK
                           (length(binding_sha256) = 64 AND
                            binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at             TEXT NOT NULL,
  UNIQUE (invocation_id, binding_sha256)
);

CREATE TABLE tool_invocation_effect_attempts (
  invocation_id          TEXT NOT NULL
                           REFERENCES tool_invocations(invocation_id),
  attempt_no             INTEGER NOT NULL CHECK (attempt_no IN (0,1)),
  admission_state        TEXT NOT NULL CHECK
                           (admission_state IN ('NotAdmitted','MayHaveStarted',
                                                'LegacyUnknown')),
  tool_definition_hash   TEXT,
  side_effect_semantics  TEXT NOT NULL CHECK
                           (side_effect_semantics IN
                             ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  profile_id             TEXT,
  profile_version        TEXT,
  profile_hash           TEXT,
  profile_protocol       TEXT,
  effect_key             TEXT,
  binding_sha256         TEXT,
  admitted_at            TEXT,
  PRIMARY KEY (invocation_id, attempt_no),
  FOREIGN KEY (invocation_id, binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256),
  CHECK ((admission_state = 'MayHaveStarted') = (admitted_at IS NOT NULL)),
  CHECK ((profile_id IS NULL AND profile_version IS NULL AND profile_hash IS NULL
          AND profile_protocol IS NULL AND effect_key IS NULL)
      OR (profile_id IS NOT NULL AND profile_version IS NOT NULL
          AND profile_hash IS NOT NULL AND profile_protocol IS NOT NULL
          AND effect_key IS NOT NULL))
);

CREATE TABLE tool_reconciliation_facts (
  fact_id                TEXT PRIMARY KEY CHECK
                           (length(fact_id) = 64 AND
                            fact_id NOT GLOB '*[^0-9a-f]*'),
  invocation_id          TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  binding_sha256         TEXT NOT NULL,
  profile_hash           TEXT NOT NULL,
  effect_key             TEXT NOT NULL,
  outcome                TEXT NOT NULL CHECK
                           (outcome IN ('NotOccurred','Occurred','StillUnknown')),
  reason_code            TEXT,
  evidence_ref           TEXT,
  evidence_sha256        TEXT,
  result_ref             TEXT,
  observed_at             TEXT NOT NULL,
  FOREIGN KEY (invocation_id, attempt_no)
    REFERENCES tool_invocation_effect_attempts(invocation_id, attempt_no),
  CHECK ((outcome = 'StillUnknown' AND reason_code IS NOT NULL)
      OR (outcome <> 'StillUnknown' AND reason_code IS NULL)),
  CHECK (outcome <> 'StillUnknown' OR reason_code IN
           ('ProfileUnavailable','EffectIdentityUnavailable',
            'ExternalSourceUnavailable','ExternalSourceNotAuthoritative',
            'EvidenceStale','EvidenceBindingMismatch','AttemptNotFinal',
            'ResultEvidenceUnavailable','ProfileVersionUnavailable')),
  CHECK ((outcome = 'Occurred' AND result_ref IS NOT NULL)
      OR (outcome <> 'Occurred' AND result_ref IS NULL)),
  CHECK ((evidence_ref IS NULL) = (evidence_sha256 IS NULL)),
  CHECK (outcome <> 'NotOccurred' OR evidence_ref IS NOT NULL)
);

CREATE INDEX idx_effect_attempts_unsettled
  ON tool_invocation_effect_attempts(invocation_id, admission_state);
CREATE INDEX idx_reconciliation_facts_invocation
  ON tool_reconciliation_facts(invocation_id, attempt_no, observed_at);
CREATE UNIQUE INDEX reconciliation_facts_exact_redelivery
  ON tool_reconciliation_facts(
    invocation_id, attempt_no, profile_hash, outcome,
    ifnull(reason_code, ''), ifnull(evidence_sha256, ''), ifnull(result_ref, '')
  );

-- Facts and accepted bindings are immutable. Corrections append a new fact;
-- consumers classify inconsistent facts as StillUnknown/proof conflict.
CREATE TRIGGER recovery_binding_no_update
BEFORE UPDATE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;
CREATE TRIGGER recovery_binding_no_delete
BEFORE DELETE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;
CREATE TRIGGER reconciliation_fact_no_update
BEFORE UPDATE ON tool_reconciliation_facts
BEGIN SELECT RAISE(ABORT, 'reconciliation fact is append-only'); END;
CREATE TRIGGER reconciliation_fact_no_delete
BEFORE DELETE ON tool_reconciliation_facts
BEGIN SELECT RAISE(ABORT, 'reconciliation fact is append-only'); END;
```

No cross-table constraint may imply `NotOccurred` or `Occurred` from
absence/presence alone. P4 transactions enforce that the selected fact matches
the attempt's exact binding/profile/effect key, and that the fact outcome and
settlement variant agree. The closed `ReconciledNoEffect` reason-code check on
the rebuilt invocation table is exactly
`AuthoritySnapshotChanged`, `ResourceSnapshotChanged`,
`ApprovalNoLongerAuthorized`, `StopRequested`, or `ReplayLimitReached`.

The fact ID is proposed as lowercase hex SHA-256 over the repository's
canonical JSON encoding of `(invocationId, attemptNo, profileHash, outcome,
reasonCode, evidenceHash, resultRef)`. The expression unique index above treats
nullable values as empty only for exact redelivery-key comparison; the primary
fact ID remains the content identity. Two non-identical authoritative proofs for one attempt are
both preserved and interpreted as a conflict/StillUnknown; they cannot be
silently upserted over one another. P9 event and P10 projection identities
remain the accepted D0A identities and are not duplicated as P39 mutable
columns.

### RecoveryBinding fields persisted in canonical JSON

The JSON is an immutable exact encoding of the accepted tuple, not a new source
of authority. It must include:

- P3 Runtime-owned `providerTurnId`, `executionId`, `logicalStepNo`,
  `repairAttempt`, `logicalActionId`, `actionIndex`, and pinned `callRef`;
- exact P4 invocation/definition identity (`invocationId`, tool name/version,
  definition hash, side-effect semantics), canonical arguments digest, and
  resolved resource/target identity and version snapshot;
- exact approval ID when applicable plus approval revision, authenticated
  subject identity, action/args digest, target/basis digest, expiry snapshot,
  and consumed-by invocation identity/revision recorded by the P38 trusted
  approval ledger;
- profile ID/version/hash/protocol version and stable `effectKey` for
  Reconcilable profiles; explicit nulls for fields not applicable to a
  NonIdempotent tool;
- exact binding schema version and digest algorithm label.

P3 owns creation of its source identities; Application transports them; P4
owns validation and persistence of the complete binding; P38 owns approval
revision/subject truth. P39 stores the values and digests but does not mint or
infer any identity. Approval fields are sourced from the trusted P38 ledger in
the claim-and-consume CAS, not from model output or caller-provided JSON.

## Admission, facts, fence, and crash transaction boundaries

- Claim creates/claims the invocation, stores/verifies the source binding,
  validates current P38 approval subject/revision and consumes once, and
  creates attempt 0 `NotAdmitted` in one fenced transaction. Existing consumed
  approval is recognized only for the same exact invocation/binding; it is
  never consumed again.
- Effect admission changes exactly one attempt from `NotAdmitted` to
  `MayHaveStarted` in a later transaction. That transaction checks the
  complete current worker lease triple, `stop_requested_at IS NULL`, current
  grant/policy/verifier/resource revisions, approval binding, definition and
  profile digest, and attempt number. No executor starts unless this commit is
  confirmed. A crash before commit is NotAdmitted; a crash after commit is
  MayHaveStarted even if the executor did not yet visibly run.
- Reconciliation facts append under the current complete lease fence, even
  after Stop, because Stop blocks only new attempt admission. P9 escalation,
  terminal P4 settlement and P3 canonical result/Action/cursor use the D0A
  existing transaction/lease boundaries. A stale generation cannot append a
  fact, select a fact, settle, or advance P3.
- If an external system cannot fence/cancel an old attempt or establish its
  finality, absence of an observed effect remains StillUnknown; a later result
  is appended as evidence and never reclassifies a previously selected proof
  by UPDATE. Conflicting late evidence keeps the recovery gate closed and
  follows the accepted ReconciliationEscalated path.

## Legacy P36 row treatment

P39 backfills exactly one attempt-0 row for each existing P36 invocation:

- `NotAdmitted` stays `NotAdmitted`; `MayHaveStarted` stays
  `MayHaveStarted`; `LegacyUnknown` stays `LegacyUnknown`.
- Do not infer profile, effect key, RecoveryBinding, attempt history, approval
  revision, P3 identities, or external outcome from Session text, command
  text, current catalog state, or result absence.
- Settled P36 records retain their exact settlement/result refs. The new
  `ReconciledNoEffect` variant is not backfilled onto any historical row.
- Settled P36 rows receive `recovery_binding_state='HistoricalSettled'`;
  every unsettled P36 row lacking a complete persisted binding receives
  `recovery_binding_state='LegacyBindingUnproven'`. New P39 rows are `Bound`
  only when the same claim transaction verifies/inserts their immutable
  binding.
- Unsettled MayHaveStarted/LegacyUnknown without a matching exact historical
  profile remains fail-closed StillUnknown/no execution, as D0A requires.
- Historical NotAdmitted shell@2 with no P39-persisted complete binding is
  marked `LegacyBindingUnproven` and is not automatically re-entered. P3's
  current cursor, Action and durable identity remain unchanged; P4 does not
  graft a later binding onto the legacy row as an automatic recovery shortcut.
  Any future human disposition must use an already-authorized exact record
  operation; absent such a contract, the row remains unresolved and release is
  blocked. Never reconstruct binding from Session text or silently substitute
  shell@3.

### Selected disposition: preserve unproven legacy rows, never auto-reenter

P39 adds the closed `recovery_binding_state` marker to the rebuilt invocation
row. New P39 invocations must be `Bound` and have the exact immutable binding
row before claim/approval consumption can commit. Every P36 settled invocation
is marked `HistoricalSettled`; every P36 unsettled invocation with no persisted
complete RecoveryBinding is marked `LegacyBindingUnproven`, including
NotAdmitted, MayHaveStarted, and LegacyUnknown. The row, original admission
state, settlement/result refs, P38 approval association/consumption, and P3
Action/Step/cursor are copied unchanged. No source identity/profile/approval
revision is fabricated and the approval is neither refunded nor transferred.

An unsettled `LegacyBindingUnproven` invocation is not eligible for automatic
claim, executor admission, or retry, even if a later current catalog happens to
match. It remains an auditable unresolved row with its original invocation ID;
P3 does not advance or create a replacement invocation. Only an already
accepted P9 manual/legacy-evidence Attention and human-recovery path may
resolve it. P4 must not manufacture a `Denied`, `Interrupted`, or
`ReconciledNoEffect` result because none is entailed by this physical marker.
The original consumed approval remains bound to the old invocation until an
already-authorized terminal disposition exists; no new approval is silently
attached.

### Attention and release-stop condition

P9 `07` currently states that insufficient legacy evidence requires durable
Attention, but the accepted DG02 mapping does not name `LegacyBindingUnproven`
as a P9 source or define its exact fact identity and P10 projection. It cannot
use `ReconciliationEscalated`: that source is reserved for unresolved external
effects and this row is NotAdmitted/no-effect. This supplement therefore does
**not** invent a source, event, or reason code. Before P39 can be released with
any active `LegacyBindingUnproven` row, an independent owner review must
confirm an already-frozen P9/P10 legacy-evidence route covers this exact row
and can surface it to a human. If not, this is a new P9/P10 Design Gap; stop
owner landing/release and obtain that governance decision. The schema migration
itself may run transactionally while preserving such rows, but the application
release must remain blocked until every active row is surfaced and has an
authorized human disposition. No active row may be deleted, auto-settled,
converted into another ToolInvocation, or silently skipped to make the release
gate pass.

This selected fail-closed disposition is the direct safety consequence of the
accepted D0A rule “exact historical shell@2 re-entry only with a complete
binding.” An absent binding is not a complete binding; refusing automatic
re-entry does not change D0A or infer effect success/failure.

The attempt-table SQL intentionally does not require every row labeled
`Reconcilable` to have a profile: P36 history can legitimately contain
unprofiled `MayHaveStarted`/`LegacyUnknown` rows, and exact shell@2
`NotAdmitted` history has no reconciliation profile. P4 must require the full
profile/effect-key/binding tuple in the effect-admission transaction for any
new profile-backed Reconcilable attempt. Unprofiled historical rows remain
representable only so recovery can fail closed as StillUnknown; they are never
admissible merely because the SQL row exists.

## Upgrade, failure rollback, and retention matrix

P39 upgrade runs only after `user_version=38`, with foreign-key validation and
the invocation rebuild, legacy attempt backfill, binding/fact table creation,
indexes and triggers in one transaction. Set `user_version=39` only as part of
that successful transaction. There is no post-commit down migration: P39 facts
are durable evidence and downgrade would destroy recovery history.

Illustrative SQLite migration envelope (the inner statements are the schema
shape above; this is not checked-in migration code):

```sql
PRAGMA foreign_keys = OFF; -- before transaction; required only for table rebuild
BEGIN IMMEDIATE;
-- Assert current user_version is 38 and required P36/P38 tables exist.
-- Create tool_invocations_p39 with the P39 settlement CHECK; copy every P36
-- row byte-for-byte for its existing values, then replace the old table.
-- Create binding/attempt/fact tables, indexes and immutability triggers.
-- INSERT one attempt-0 row per copied invocation using its exact P36 admission
-- state; leave sourceBinding/profile/effectKey null rather than infer them.
-- Set recovery_binding_state=HistoricalSettled for settled P36 rows and
-- LegacyBindingUnproven for unsettled rows without a persisted exact binding.
PRAGMA foreign_key_check;
PRAGMA user_version = 39;
COMMIT;
PRAGMA foreign_keys = ON;
```

Any pre-commit error executes `ROLLBACK`, then restores foreign-key enforcement;
the prior schema, P38 approval records and `user_version=38` remain intact. The
real migration must check the `foreign_key_check` result before setting the
version and must not treat this abbreviated envelope as sufficient migration
implementation or review evidence.

| Fixture/state at upgrade | Expected result |
|---|---|
| Valid P38 DB, no unsettled P36 invocations | Upgrade commits; P36 rows and approval ledger unchanged; empty new proof tables |
| Settled success/failure/denial/interruption/outcome-unknown rows | Upgrade commits; exact old settlement and result refs preserved; attempt 0 copied without inventing a fact |
| Unsettled P36 NotAdmitted | Upgrade commits with NotAdmitted attempt 0 and null binding/profile; later reentry is conditional on exact P3 source binding and P38 ledger verification |
| Unsettled P36 MayHaveStarted or LegacyUnknown | Upgrade commits without fabricated profile/fact; recovery remains StillUnknown/fail-closed |
| Duplicate invocation IDs, broken P36 foreign keys, malformed canonical binding/fact hash, or unsupported profile metadata in a new claim | Migration aborts before version bump, or runtime claim rejects atomically; no partial binding/attempt/approval consumption |
| Claim committed, process killed immediately after commit | Same invocation, consumed approval, binding and attempt 0 visible; retry is idempotent, no new approval consumption |
| Admission transaction killed before/after COMMIT | Before: attempt remains NotAdmitted and executor count 0; after: MayHaveStarted and recovery reconciles, never blind-starts |
| Fact insert / settlement / P9 event before and after their transaction commit | Before: no partial fact/settlement/event; after: exact unique durable result/event replayed without second effect or approval consumption |
| Duplicate identical proof delivery | Deterministic fact ID/unique key returns existing exact fact; no duplicate canonical result/event |
| Different/conflicting/late proof for same attempt | Append evidence without overwrite; classify conflict as StillUnknown, keep execution gate/Attention, no automatic replay |
| Attempt 0 authoritative NotOccurred, full gate still valid, no Stop | At most attempt 1 admission; attempt number and effect key are exact, same invocation identity, approval not consumed twice |
| NotOccurred after Stop, changed authority/resource/approval, or attempt 1 | Settle accepted ReconciledNoEffect/Interrupted-or-typed mapping from D0A; do not admit another attempt |
| StillUnknown or old attempt not final | Persist unresolved fact/Attention under current fence; no new effect; late terminal accounting is allowed only by current fence |
| P10 rebuild while source event retained / after P1 pruning | Rebuild reproduces accepted D0A ActionRequired row/offset within retention horizon; after prune, no indefinite Attention promise |
| Migration transaction failure at each DDL/backfill stage | Transaction rollback leaves old schema, rows, P38 approvals, and `user_version=38` intact |

Retention follows the accepted D0A boundary: P39 binding, attempts and facts
must remain while an invocation can be replayed, reconciled, settled, audited,
or referenced by P9/P10. This supplement does not authorize pruning or add a
retention duration. Any eventual compaction must preserve the accepted replay,
event-rebuild and audit guarantees and needs a separate owner contract if it
changes them.

## Open review gate

The physical design is intentionally blocked on independent review of the
legacy NotAdmitted rollout disposition above, whether the canonical JSON
binding can be sourced exactly from P3/P38 at the P39 point in the migration
sequence, and whether all result/evidence refs have repository-owned FK target
tables before this SQL shape is frozen. Until those questions are closed,
there must be no owner-document landing, P39 migration implementation, test
implementation, or release claim. This draft cannot be used to infer that the
green `C:\Arbor@f80` tree contains P36/P37/P38/P39, or that `db929` contains
P37/P38/P39.
