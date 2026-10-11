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
  recovery_binding_sha256 TEXT,
  settlement_provenance TEXT CHECK
                           (settlement_provenance IN
                             ('Ordinary','Reconciliation','LegacyHistorical')),
  selected_attempt_no    INTEGER,
  selected_fact_id       TEXT,
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Denied','Interrupted',
                            'OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')),
  settlement_json        TEXT,
  result_ref              TEXT REFERENCES artifacts(artifact_id),
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL)),
  CHECK ((settled_at IS NULL) = (settlement_provenance IS NULL)),
  CHECK (
    (settlement_provenance = 'Reconciliation'
      AND selected_attempt_no IS NOT NULL AND selected_fact_id IS NOT NULL)
    OR
    (settlement_provenance IN ('Ordinary','LegacyHistorical')
      AND selected_attempt_no IS NULL AND selected_fact_id IS NULL)
    OR
    (settlement_provenance IS NULL AND settled_at IS NULL
      AND selected_attempt_no IS NULL AND selected_fact_id IS NULL)
  ),
  CHECK (settlement_provenance <> 'Reconciliation' OR
         settlement_kind IN ('Success','ExpectedFailure','ReconciledNoEffect')),
  CHECK (settlement_provenance <> 'Reconciliation' OR
         effect_admission_state = 'MayHaveStarted'),
  CHECK (settlement_kind <> 'ReconciledNoEffect' OR
         settlement_provenance = 'Reconciliation'),
  CHECK (recovery_binding_state <> 'HistoricalSettled' OR settled_at IS NOT NULL),
  CHECK (recovery_binding_state <> 'LegacyBindingUnproven' OR settled_at IS NULL),
  CHECK ((recovery_binding_state = 'Bound') =
         (recovery_binding_sha256 IS NOT NULL)),
  FOREIGN KEY (invocation_id, recovery_binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (invocation_id, selected_attempt_no, selected_fact_id)
    REFERENCES tool_reconciliation_facts(invocation_id, attempt_no, fact_id)
    DEFERRABLE INITIALLY DEFERRED,
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
  admission_source       TEXT NOT NULL CHECK
                           (admission_source IN ('P36Backfill','P39Claim','P39Admission')),
  admission_time_precision TEXT NOT NULL CHECK
                           (admission_time_precision IN
                             ('NotAdmitted','TransactionTimestamp','UnknownLegacy')),
  PRIMARY KEY (invocation_id, attempt_no),
  FOREIGN KEY (invocation_id, binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256),
  CHECK (
    (admission_state = 'NotAdmitted' AND admitted_at IS NULL
      AND admission_time_precision = 'NotAdmitted'
      AND admission_source IN ('P36Backfill','P39Claim'))
    OR
    (admission_state = 'MayHaveStarted' AND admitted_at IS NOT NULL
      AND admission_time_precision = 'TransactionTimestamp'
      AND admission_source = 'P39Admission')
    OR
    (admission_state = 'MayHaveStarted' AND admitted_at IS NULL
      AND admission_time_precision = 'UnknownLegacy'
      AND admission_source = 'P36Backfill')
    OR
    (admission_state = 'LegacyUnknown' AND admitted_at IS NULL
      AND admission_time_precision = 'UnknownLegacy'
      AND admission_source = 'P36Backfill')
  ),
  CHECK ((profile_id IS NULL AND profile_version IS NULL AND profile_hash IS NULL
          AND profile_protocol IS NULL AND effect_key IS NULL)
      OR (profile_id IS NOT NULL AND profile_version IS NOT NULL
          AND profile_hash IS NOT NULL AND profile_protocol IS NOT NULL
          AND effect_key IS NOT NULL)),
  CHECK (profile_id IS NULL OR binding_sha256 IS NOT NULL)
);

CREATE TABLE tool_reconciliation_facts (
  fact_id                TEXT PRIMARY KEY CHECK
                           (length(fact_id) = 64 AND
                            fact_id NOT GLOB '*[^0-9a-f]*'),
  invocation_id          TEXT NOT NULL,
  attempt_no             INTEGER NOT NULL,
  binding_sha256         TEXT,
  profile_hash           TEXT,
  effect_key             TEXT,
  fact_origin            TEXT NOT NULL CHECK
                           (fact_origin IN ('ProfileReconciliation',
                                            'P36LegacyUnprofiled')),
  legacy_reason          TEXT CHECK
                           (legacy_reason IS NULL OR
                            legacy_reason = 'LegacyProfileUnavailable'),
  fact_disposition       TEXT NOT NULL CHECK
                           (fact_disposition IN ('RecoveryInput',
                                                 'PostTerminalEvidence')),
  outcome                TEXT NOT NULL CHECK
                           (outcome IN ('NotOccurred','Occurred','StillUnknown')),
  reason_code            TEXT,
  evidence_ref           TEXT,
  evidence_sha256        TEXT,
  result_ref             TEXT,
  observed_at             TEXT NOT NULL,
  FOREIGN KEY (invocation_id, attempt_no)
    REFERENCES tool_invocation_effect_attempts(invocation_id, attempt_no),
  FOREIGN KEY (invocation_id, binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256),
  FOREIGN KEY (evidence_ref) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (result_ref) REFERENCES artifacts(artifact_id),
  CHECK (
    (fact_origin = 'P36LegacyUnprofiled'
      AND outcome = 'StillUnknown'
      AND reason_code = 'ProfileUnavailable'
      AND legacy_reason = 'LegacyProfileUnavailable'
      AND binding_sha256 IS NULL AND profile_hash IS NULL AND effect_key IS NULL)
    OR
    (fact_origin = 'ProfileReconciliation'
      AND legacy_reason IS NULL
      AND binding_sha256 IS NOT NULL AND profile_hash IS NOT NULL
      AND effect_key IS NOT NULL)
  ),
  CHECK (binding_sha256 IS NULL OR length(binding_sha256) = 64),
  CHECK (profile_hash IS NULL OR length(profile_hash) > 0),
  CHECK (effect_key IS NULL OR length(trim(effect_key)) > 0),
  CHECK ((outcome = 'StillUnknown' AND reason_code IS NOT NULL)
      OR (outcome <> 'StillUnknown' AND reason_code IS NULL)),
  CHECK (outcome <> 'StillUnknown' OR reason_code IN
           ('ProfileUnavailable','EffectIdentityUnavailable',
            'ExternalSourceUnavailable','ExternalSourceNotAuthoritative',
            'EvidenceStale','EvidenceBindingMismatch','AttemptNotFinal',
            'ResultEvidenceUnavailable','ProfileVersionUnavailable')),
  CHECK (fact_disposition <> 'PostTerminalEvidence' OR
         (outcome = 'StillUnknown' AND reason_code = 'EvidenceBindingMismatch')),
  CHECK ((outcome = 'Occurred' AND result_ref IS NOT NULL)
      OR (outcome <> 'Occurred' AND result_ref IS NULL)),
  CHECK ((evidence_ref IS NULL) = (evidence_sha256 IS NULL)),
  CHECK (evidence_sha256 IS NULL OR
         (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (outcome <> 'NotOccurred' OR evidence_ref IS NOT NULL)
);

CREATE INDEX idx_effect_attempts_unsettled
  ON tool_invocation_effect_attempts(invocation_id, admission_state);
CREATE INDEX idx_reconciliation_facts_invocation
  ON tool_reconciliation_facts(invocation_id, attempt_no, observed_at);
CREATE UNIQUE INDEX reconciliation_facts_invocation_ref
  ON tool_reconciliation_facts(invocation_id, fact_id);
CREATE UNIQUE INDEX reconciliation_facts_attempt_ref
  ON tool_reconciliation_facts(invocation_id, attempt_no, fact_id);
CREATE UNIQUE INDEX reconciliation_facts_exact_redelivery
  ON tool_reconciliation_facts(
    invocation_id, attempt_no, fact_origin, outcome, fact_disposition,
    ifnull(binding_sha256, ''), ifnull(profile_hash, ''), ifnull(effect_key, ''),
    ifnull(reason_code, ''), ifnull(legacy_reason, ''),
    ifnull(evidence_ref, ''), ifnull(evidence_sha256, ''), ifnull(result_ref, '')
  );

-- Facts and accepted bindings are immutable. Corrections append a new fact;
-- consumers classify inconsistent facts as StillUnknown/proof conflict.
CREATE TRIGGER recovery_binding_no_update
BEFORE UPDATE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;
CREATE TRIGGER recovery_binding_no_delete
BEFORE DELETE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;
CREATE TRIGGER tool_invocation_binding_immutable
BEFORE UPDATE OF recovery_binding_state, recovery_binding_sha256 ON tool_invocations
WHEN NEW.recovery_binding_state IS NOT OLD.recovery_binding_state
  OR NEW.recovery_binding_sha256 IS NOT OLD.recovery_binding_sha256
BEGIN SELECT RAISE(ABORT, 'recovery binding state is immutable'); END;
CREATE TRIGGER tool_invocation_settlement_no_rewrite
BEFORE UPDATE OF settled_at, settlement_kind, settlement_json,
                 result_ref, settlement_provenance,
                 selected_attempt_no, selected_fact_id ON tool_invocations
WHEN OLD.settled_at IS NOT NULL AND (
     NEW.settled_at IS NOT OLD.settled_at
  OR NEW.settlement_kind IS NOT OLD.settlement_kind
  OR NEW.settlement_json IS NOT OLD.settlement_json
  OR NEW.result_ref IS NOT OLD.result_ref
  OR NEW.settlement_provenance IS NOT OLD.settlement_provenance
  OR NEW.selected_attempt_no IS NOT OLD.selected_attempt_no
  OR NEW.selected_fact_id IS NOT OLD.selected_fact_id)
BEGIN SELECT RAISE(ABORT, 'terminal settlement is immutable'); END;
CREATE TRIGGER tool_invocation_admission_monotone
BEFORE UPDATE OF effect_admission_state ON tool_invocations
WHEN OLD.effect_admission_state <> NEW.effect_admission_state
 AND NOT (OLD.effect_admission_state = 'NotAdmitted'
          AND NEW.effect_admission_state = 'MayHaveStarted')
BEGIN SELECT RAISE(ABORT, 'invocation admission cannot move backwards'); END;
CREATE TRIGGER effect_attempt_admission_monotone
BEFORE UPDATE OF admission_state ON tool_invocation_effect_attempts
WHEN OLD.admission_state <> NEW.admission_state
 AND NOT (OLD.admission_state = 'NotAdmitted'
          AND NEW.admission_state = 'MayHaveStarted')
BEGIN SELECT RAISE(ABORT, 'attempt admission cannot move backwards'); END;
CREATE TRIGGER effect_attempt_identity_immutable
BEFORE UPDATE ON tool_invocation_effect_attempts
WHEN NEW.invocation_id IS NOT OLD.invocation_id
  OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.tool_definition_hash IS NOT OLD.tool_definition_hash
  OR NEW.side_effect_semantics IS NOT OLD.side_effect_semantics
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.profile_version IS NOT OLD.profile_version
  OR NEW.profile_hash IS NOT OLD.profile_hash
  OR NEW.profile_protocol IS NOT OLD.profile_protocol
  OR NEW.effect_key IS NOT OLD.effect_key
  OR NEW.binding_sha256 IS NOT OLD.binding_sha256
BEGIN SELECT RAISE(ABORT, 'effect attempt identity is immutable'); END;
CREATE TRIGGER reconciliation_fact_disposition_matches_terminal
BEFORE INSERT ON tool_reconciliation_facts
WHEN (NEW.fact_disposition = 'RecoveryInput'
      AND EXISTS (SELECT 1 FROM tool_invocations i
                   WHERE i.invocation_id = NEW.invocation_id
                     AND i.settled_at IS NOT NULL))
  OR (NEW.fact_disposition = 'PostTerminalEvidence'
      AND NOT EXISTS (SELECT 1 FROM tool_invocations i
                       WHERE i.invocation_id = NEW.invocation_id
                         AND i.settled_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'fact disposition does not match terminal state'); END;
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

Physical reference/consistency rules are explicit: `tool_invocations.result_ref`
and reconciliation fact `evidence_ref`/`result_ref` are P4 `ArtifactRef`s and
reference `artifacts(artifact_id)`. The invocation persists
`settlement_provenance`, `selected_attempt_no`, and `selected_fact_id`:
`Ordinary` terminal results have null selected fields; `LegacyHistorical`
preserves settled P36 history with no retroactive fact; every P4
reconciliation-produced terminal `Success`, `ExpectedFailure`, or
`ReconciledNoEffect` must be `Reconciliation` and hold a non-null selected
attempt/fact. A deferred composite FK
`(invocation_id,selected_attempt_no,selected_fact_id)` points to the same
immutable reconciliation fact. The P4 settlement transaction additionally
requires `Occurred` for reconciliation-derived Success/ExpectedFailure and
`NotOccurred` for ReconciledNoEffect; SQLite DDL cannot express that cross-row
union check by itself. Before selecting, the P4 transaction requires exactly
one non-conflicting authoritative `RecoveryInput` fact for that invocation and
attempt. Multiple distinct facts/proofs for an attempt are ambiguous and remain
StillUnknown; none is selected for terminal settlement. This selection is
invocation-unique; a second/ambiguous fact cannot replace it.

Attempt/fact binding references use the composite `(invocation_id,
binding_sha256)` FK, not a digest-only FK. For `recovery_binding_state='Bound'`,
the invocation's non-null digest plus deferred composite FK requires a matching
immutable binding row at transaction commit; the binding row itself requires
the invocation FK. Attempt/fact composite FKs must match that same invocation.
P4 validates the canonical JSON digest using the existing canonicalizer because
SQLite has no repository hash function. These deferred FKs permit claim to
insert invocation, binding, attempt and approval-consumption facts in one
transaction while making a missing/mismatched binding fail at commit.

Terminal P4 settlement is immutable: its trigger rejects any later change to
settled time/kind/payload/result/provenance/selected attempt/selected fact. A new contradictory proof
after terminal is appended only as `fact_disposition='PostTerminalEvidence'`;
it cannot become a `RecoveryInput`, replace the selected terminal fact, undo P4
settlement, roll back P3 ToolResult/Action/cursor, or cause replay. If that
late contradiction is confirmed against the selected fact, the appended fact
is `StillUnknown/EvidenceBindingMismatch`; identical redelivery returns the
existing fact, while the contradictory fact is retained separately. P4 does
not change `selected_fact_id` or any terminal settlement field, and P3
does not reverse Action/ToolResult/cursor. If that late contradiction must
create new user-visible Attention, D0A does not define that post-terminal
notification; it is a separate P9/P10 Design Gap. This proposal does not invent
a second event or mutate terminal truth.

Terminal replay qualification is receipt-first: the same P4 invocation and
same selected attempt/fact returns the existing settlement and reconstructs the
same P3 ToolResult/Action/cursor; it may not select a second fact or rewrite
the selected fact. A different fact after terminal is only appended as
`PostTerminalEvidence`, never treated as a second settlement proposal.
`StillUnknown` is not a terminal reconciliation settlement of the P4
invocation: per D0A the invocation remains `MayHaveStarted`/unsettled, P9
records the escalation, and any Execution `OutcomeUnknown` is not a
replacement terminal ToolInvocation fact-selection result.

Legacy unprofiled StillUnknown facts use the closed physical
`legacy_reason='LegacyProfileUnavailable'` marker and null binding/profile/
effect-key columns, while the P4/P3 canonical `reason_code` remains D0A's
already accepted `ProfileUnavailable`. This preserves the precise migration
provenance without extending the accepted reason union. Adding a public
`LegacyProfileUnavailable` reason code instead is a mutually exclusive
alternative that changes D0A's closed P4/P3 union and requires separate
governance acceptance; this proposal recommends the existing-code mapping.

The fact ID is proposed as lowercase hex SHA-256 over the repository's
canonical JSON encoding of `(invocationId, attemptNo, factOrigin,
bindingSha256|null, profileHash|null, effectKey|null, outcome, reasonCode,
legacyReason|null, evidenceHash|null, resultRef|null, factDisposition)`. The
expression unique index above treats
nullable values as empty only for exact redelivery-key comparison; the primary
fact ID remains the content identity. Two non-identical authoritative proofs
for one attempt are both preserved and interpreted as a conflict/StillUnknown; they cannot be
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
- Every attempt records `admission_source` and `admission_time_precision`.
  P39 admission writes the timestamp captured by the admission transaction
  with `TransactionTimestamp` (not a claim of the precise SQLite COMMIT wall
  time);
  NotAdmitted writes null with `NotAdmitted`; P36 backfill writes null with
  `UnknownLegacy` for MayHaveStarted/LegacyUnknown. `intent_at` is never copied
  into `admitted_at` or used as an approximation of effect admission.
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
  they also receive `settlement_provenance='LegacyHistorical'` and null
  `selected_attempt_no`/`selected_fact_id`; P39 does not invent retrospective
  reconciliation facts for them.
- Unsettled P36 MayHaveStarted/LegacyUnknown rows lacking a complete persisted
  binding receive `recovery_binding_state='LegacyBindingUnproven'`. Active
  NotAdmitted rows without binding are rejected by the pre-upgrade gate below.
  New P39 rows are `Bound` only when the same claim transaction
  verifies/inserts their immutable binding.
- Unsettled MayHaveStarted/LegacyUnknown without a matching exact historical
  profile remains fail-closed StillUnknown/no execution, as D0A requires. A
  `P36LegacyUnprofiled` fact stores null binding/profile/effect key,
  `legacy_reason='LegacyProfileUnavailable'`, and the already-accepted P4
  canonical `reason_code='ProfileUnavailable'`; no fake identity hash/key is
  persisted.
- Historical NotAdmitted shell@2 with no P39-persisted complete binding is
  rejected at the pre-upgrade gate below, leaving P3 cursor/Action and all
  P36/P38 rows untouched. Never reconstruct binding from Session text or
  silently substitute shell@3.

### Selected disposition: preserve unproven legacy rows, never auto-reenter

P39 adds the closed `recovery_binding_state` marker to the rebuilt invocation
row. New P39 invocations must be `Bound` and have the exact immutable binding
row before claim/approval consumption can commit. Every P36 settled invocation
is marked `HistoricalSettled`; every P36 unsettled MayHaveStarted/LegacyUnknown
row with no persisted complete RecoveryBinding is marked
`LegacyBindingUnproven`. Unsettled NotAdmitted rows are rejected before
migration by the gate below. Migrated row values, settlement/result refs, P38
approval association/consumption, and P3 Action/Step/cursor are preserved. No
source identity/profile/approval revision is fabricated and the approval is
neither refunded nor transferred.

An unsettled `LegacyBindingUnproven` MayHaveStarted/LegacyUnknown invocation
is not eligible for automatic claim, executor admission, or retry, even if a
later current catalog happens to match. It remains an auditable unresolved row
with its original invocation ID; P3 does not advance or create a replacement
invocation. The existing D0A `StillUnknown` recovery path emits the exact P9
`ReconciliationEscalated` fact/event and P10 `ActionRequired` projection.

### P39 CLI sidecar-audit contract and permanent legacy-DB isolation

P39-targeting maintenance/migration startup requires the operator-specified
`--migration-block-report-db <absolute-local-path>` before constructing either
SQLite client. There is no default. The path must not resolve to the primary
DB, its WAL/SHM sidecars, another configured storage file, a relative path,
OS temp location, network/UNC share, symlink/reparse path, or unqualified
volume. Compare normalized paths and, when both files exist, filesystem file
identity (device/inode or Windows volume+file ID) to reject hardlink/alias
collisions; require sidecar link-count one and fail closed if distinct file
identity/link count cannot be established. The
operator-protected parent directory must exist and have no untrusted writers.

An existing sidecar is opened read-only first. Validate exact P39
`application_id`, `user_version`, table/index/trigger shape, and schema digest
before any WAL/config/schema write; unknown schema fails before primary DB open.
A nonexistent sidecar is created with exclusive-create semantics and
initialized transactionally. A pre-existing zero-byte/empty SQLite file may be
initialized only if it has no user objects, `application_id=0`, and
`user_version=0`; any other unknown/unrelated file is never overwritten or
repurposed. After opening read-write, verify the actual database file identity
still matches the prevalidated distinct path before setting WAL or writing.
Typed errors use exit `78`: missing option `P39_REPORT_DB_REQUIRED`, invalid
path/alias `P39_REPORT_DB_PATH_INVALID`, unknown schema
`P39_REPORT_DB_SCHEMA_UNSUPPORTED`, pragma readback mismatch
`P39_REPORT_DB_PRAGMA_MISMATCH`, sidecar I/O failure
`P39_REPORT_DB_IO_FAILURE`, and same report key with different bytes
`P39_REPORT_KEY_CONFLICT`. Diagnostics contain only stable codes, never paths
or DB row contents. If sidecar COMMIT outcome cannot be resolved by reopen and
query, use `P39_REPORT_COMMIT_UNRESOLVED`; never continue to P39 migration.
If the P36 primary DB does not already use P1's required WAL mode and the
preflight-only connection cannot verify it without changing persistent state,
fail with `P39_PRIMARY_JOURNAL_MODE_UNSUPPORTED` before any P37/P38/P39
migration.

The sidecar is an operator-owned SQLite audit DB using the same P1 SQLite
adapter/Node VFS as Arbor, not a JSON file or BlobStore. Initialize/verify
`PRAGMA journal_mode=WAL` (readback must equal `wal`),
`PRAGMA synchronous=FULL` (readback must equal `2`), foreign keys and bounded
busy timeout on every connection. Use reserved sidecar identity
`application_id=0x41523739` and sidecar `user_version=1`. The proposed table is:

```sql
CREATE TABLE p39_migration_block_reports (
  report_key        TEXT PRIMARY KEY CHECK
                      (length(report_key) = 64 AND report_key NOT GLOB '*[^0-9a-f]*'),
  content_hash      TEXT NOT NULL UNIQUE CHECK
                      (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  report_json       TEXT NOT NULL
);

CREATE TRIGGER p39_report_no_update
BEFORE UPDATE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is immutable'); END;
CREATE TRIGGER p39_report_no_delete
BEFORE DELETE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is retained'); END;
```

`report_key = SHA256(canonicalJSON({schema, targetUserVersion,
databaseFingerprint}))`; `content_hash` is SHA-256 of the exact canonical UTF-8
report JSON excluding that field. Reports have no timestamp, DB path, command or
argument, resource path or authority secret. A sidecar with a different schema
is not migrated or overwritten; stop with `P39_REPORT_DB_SCHEMA_UNSUPPORTED`.
For a new sidecar only, create schema/version in one SQLite transaction; after
restart, accept it only if the exact identity/version/object set verifies.

The report row contains stable schema/kind, observed/target version, SHA-256
fingerprint of the canonical P36 blocker-state projection, sorted exact
`blockedInvocationIds`, and content hash. Fingerprint inputs available before
P37/P38 are limited to observed `user_version` and P36 invocation ID, execution
ID, side-effect semantics, admission state, unsettled marker and approval ID.
Do not persist raw P4 command/argument/resource or principal data.
Re-evaluation of an unchanged DB snapshot yields the same `report_key`, exact
JSON bytes and `content_hash`.

#### Main/sidecar transaction and lock order

1. Parse/validate the CLI sidecar path and open/verify the sidecar schema before
   opening the primary DB. Validate sidecar `journal_mode=WAL` and
   `synchronous=FULL` by readback, then close/release that validation handle.
   Never use the sidecar file as the primary DB.
2. Enter deployment maintenance mode: all existing writers/daemons for the
   primary DB are stopped and remain stopped until migration either finishes
   or exits isolated. Without this operator precondition, fail before main DB
   mutation; SQLite lock alone covers only each transaction.
3. Before applying any pending P37, P38 or P39 migration, if current
   `user_version` is 36–38, open the primary with the P1 SQLite adapter while
   suppressing automatic journal-mode changes (`disableWAL=true` on this
   preflight-only connection), read back `PRAGMA journal_mode`, and fail closed
   without mutation unless it is already `wal`. Then begin primary
   `BEGIN IMMEDIATE`; read current version and detect all P36 unsettled
   `NotAdmitted` invocation IDs, computing the stable fingerprint from that
   same snapshot. Connection-local busy_timeout/foreign_keys/synchronous
   settings are allowed; no primary schema/page/user_version/application-row
   write is allowed. SQLite may create/manage WAL/SHM lock sidecars while
   opening/locking an already-WAL DB; those are SQLite runtime metadata, not a
   committed P36/P37/P38 migration.
   For `user_version < 36`, P36 schema is absent and old rows are converted to
   `LegacyUnknown`; normal ordered migration proceeds. For version 39, P39 is
   already applied.
4. If no blockers exist, rollback/close the read-only preflight transaction
   and proceed with the ordered P37→P38→P39 migration transactions while
   deployment maintenance mode continues to exclude all other writers. No
   sidecar report row is added. The primary lock is not claimed to span these
   distinct ordered migration transactions; writer quiescence is the required
   no-TOCTOU precondition.
5. If blockers exist, before any pending P37/P38/P39 DDL and while still
   holding the primary `BEGIN IMMEDIATE`, begin
   a sidecar `BEGIN IMMEDIATE`. Select by `report_key`: absent → insert exact
   JSON and content hash; identical row → idempotent no-op; same key with a
   different hash/bytes → `P39_REPORT_KEY_CONFLICT`, do not replace it. Commit
   sidecar and read the row back by key; verify exact bytes and both hashes.
6. After sidecar success/readback, rollback primary transaction and close both
   clients. Since preflight ran before all pending P37/P38/P39 migrations, the
   original observed committed schema/data/approval/P3 cursor/user_version
   remain unchanged. SQLite may update transient WAL/SHM lock metadata for its
   existing WAL mode. Exit `P39_LEGACY_DB_ISOLATED` / 78. No P39 service
   runtime is launched.

All processes use the same lock order, primary DB then sidecar, and path equality
is rejected to avoid self-deadlock. If sidecar commit outcome is uncertain,
keep the primary write reservation, reopen/query the sidecar by stable key and
hash, then: exact persisted row → treat as success and rollback/isolate primary;
no row → retry the identical sidecar transaction within bounded policy; row
with different bytes, inaccessible/corrupt DB, or unresolved commit outcome →
rollback primary and fail closed with a typed nonzero error. On process restart,
the same unchanged primary snapshot recomputes the same key and verifies the
same sidecar row; it never assumes a lost response means no commit.

#### Sidecar durability, Windows and retention

SQLite WAL `synchronous=FULL` commits the sidecar WAL through the configured
SQLite VFS `xSync` path. The durability claim is conditional on the local
filesystem, OS and device honoring SQLite locking/flush semantics; SQLite itself
warns that broken OS/device sync behavior can violate power-loss durability.
Keep the sidecar DB and any SQLite-managed `-wal`/`-shm` files together; never
manually delete/rename/copy only the main sidecar file while a WAL may contain
committed rows. The named deployment operator is responsible for access
control, backup and retention. Archive through SQLite's backup API (which
captures a consistent committed snapshot), not file-copying only the main DB.
The application never rotates, deletes or truncates report history.

This sidecar design supports a Windows local-disk path only after qualification
of the actual `@effect/sql-sqlite-node`/Node VFS path, filesystem and hardware.
Release gate requires repeated report commit/readback/restart, process kills at
each sidecar transaction boundary, injected disk-full/access-denied/flush and
busy failures, and VM hard-power-off/reopen/integrity checks on each supported
Windows local filesystem. `WAL` + `FULL` is not a promise against hardware or
VFS that lies about flushes. Until this matrix passes, Windows and all network
or unknown filesystems return `P39_REPORT_DURABILITY_UNSUPPORTED` before the
primary DB is opened. Primary sources:
[SQLite WAL](https://www.sqlite.org/wal.html),
[SQLite PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous),
[SQLite atomic commit assumptions](https://www.sqlite.org/atomiccommit.html),
[Effect SQLite Node driver](https://github.com/Effect-TS/effect/tree/main/packages/sql/sqlite-node),
[Node SQLite](https://nodejs.org/api/sqlite.html),
[Windows `FlushFileBuffers`](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

#### Permanent legacy-DB isolation

After sidecar commit/readback, the P39 maintenance command exits
`P39_LEGACY_DB_ISOLATED` / 78. That exact primary DB is permanently excluded
from P39 until a separate future governance decision: no binding is fabricated,
approval refunded/transferred, row deleted, attempt retried, or replacement
ToolInvocation created. P39-enabled service runtime is not started against that
DB. The primary committed schema/data/user_version and P36/P38/P3 canonical
state remain unchanged by the P39 block. This does not close human recovery
work for the DB.

Release readiness is reported by DB cohort: unaffected/fresh databases may
qualify after this sidecar and SQLite/OS durability matrix; any DB with an
active P36 NotAdmitted row is permanently isolated and is not counted as
upgraded/released. This remains the physical safety consequence of D0A's rule
that exact historical shell@2 re-entry requires a complete binding; it adds no
automatic old-row recovery semantics.

The later accepted owner landing must put the sidecar CLI/migration contract in
P1 `04-sqlite-schema.md` §5 and `06-recovery-matrix.md` §5, process startup and
operator CLI behavior in P14 `02-conversation-execution.md` and `05-acceptance.md`,
and the AH7 legacy/no-dispatch gate in P9 `07-agent-loop-step-recovery.md`. No
owner document is edited by this proposal.

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
-- P39 CLI validates --migration-block-report-db and sidecar identity/schema/
-- WAL/FULL before constructing/opening the primary SQLite client.
-- In deployment maintenance mode, for primary user_version 36..38:
-- Open preflight with disableWAL=true; assert journal_mode is already wal so
-- inspection does not mutate the primary DB's persistent journal mode.
BEGIN IMMEDIATE;
-- Read only: observe version and P36 unsettled NotAdmitted rows/fingerprint.
-- If blocked, write/readback the report in sidecar BEGIN IMMEDIATE, then
-- ROLLBACK/close primary and sidecar and exit P39_LEGACY_DB_ISOLATED.
-- Otherwise ROLLBACK/close this preflight transaction; do not write main DB.
-- Keep every other writer stopped while the ordered migration runner executes.

-- Using a new migration connection after P37/P38 commit at user_version 38:
PRAGMA foreign_keys = OFF; -- before P39 table-rebuild transaction
BEGIN IMMEDIATE;
-- Create tool_invocations_p39; copy each P36 row preserving existing values.
-- Create recovery-binding/attempt/fact tables, indexes and triggers.
-- Backfill attempt0/admission provenance and historical settlement markers;
-- do not infer source bindings, profiles, facts or admission times.
PRAGMA foreign_key_check; -- fail transaction if any row is returned
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
| Any unsettled P36 NotAdmitted row | Preflight refuses before schema/user_version write; after rollback/close emits stable structured report with DB fingerprint and sorted IDs; same DB retains committed P36 state/P38 approval/P3 Action/cursor; report and DB are retained and that DB is permanently excluded from P39 until separate governance |
| Unsettled P36 MayHaveStarted or LegacyUnknown without profile/binding/effect key | Upgrade commits with `LegacyBindingUnproven` marker and nullable attempt identity; a `StillUnknown(ProfileUnavailable)` fact may be stored with `legacy_reason=LegacyProfileUnavailable`; P9/P10 use accepted ReconciliationEscalated path |
| Duplicate invocation IDs, broken P36 foreign keys, malformed canonical binding/fact hash, or unsupported profile metadata in a new claim | Migration aborts before version bump, or runtime claim rejects atomically; no partial binding/attempt/approval consumption |
| Orphan legacy invocation result_ref or non-Artifact evidence/result ref | FK preflight/`foreign_key_check` aborts before version bump with exact source row IDs; no ref rewriting or guessed target |
| Claim committed, process killed immediately after commit | Same invocation, consumed approval, binding and attempt 0 visible; retry is idempotent, no new approval consumption |
| Admission transaction killed before/after COMMIT | Before: attempt remains NotAdmitted and executor count 0; after: MayHaveStarted and recovery reconciles, never blind-starts |
| Fact insert / settlement / P9 event before and after their transaction commit | Before: no partial fact/settlement/event; after: exact unique durable result/event replayed without second effect or approval consumption |
| Duplicate identical proof delivery | Deterministic fact ID/unique key returns existing exact fact; no duplicate canonical result/event |
| Different/conflicting/late proof for same attempt | Append evidence without overwrite; classify conflict as StillUnknown, keep execution gate/Attention, no automatic replay |
| Contradictory evidence arrives after terminal P4/P3 settlement | Append immutable `PostTerminalEvidence`; terminal P4 result and P3 ToolResult/Action/cursor remain unchanged; no retroactive replay/rollback. If user-visible escalation is required and existing P9 event cannot represent it, stop for P9/P10 governance |
| Attempt 0 authoritative NotOccurred, full gate still valid, no Stop | At most attempt 1 admission; attempt number and effect key are exact, same invocation identity, approval not consumed twice |
| NotOccurred after Stop, changed authority/resource/approval, or attempt 1 | Settle accepted ReconciledNoEffect/Interrupted-or-typed mapping from D0A; do not admit another attempt |
| StillUnknown or old attempt not final | Persist unresolved fact/Attention under current fence; no new effect; late terminal accounting is allowed only by current fence |
| P10 rebuild while source event retained / after P1 pruning | Rebuild reproduces accepted D0A ActionRequired row/offset within retention horizon; after prune, no indefinite Attention promise |
| Migration transaction failure at each DDL/backfill stage | Transaction rollback leaves old schema, rows, P38 approvals, and `user_version=38` intact |
| Same blocked schema-38 DB retried / process restarts | Same report content hash is recognized without rewrite; process still returns P39_LEGACY_DB_ISOLATED and never enters service runtime. P36 DB/user_version stays unchanged |
| Same report key exists with different content | `P39_REPORT_KEY_CONFLICT`; preserve the existing immutable sidecar row, do not update/delete, and do not run P39 DDL |
| Unblocked schema-38 DB migrates then P39 startup repeats | First migration commits user_version 39; later invocation is runner no-op; P39 CLI report path validation still precedes DB open |

Retention follows the accepted D0A boundary: P39 binding, attempts and facts
must remain while an invocation can be replayed, reconciled, settled, audited,
or referenced by P9/P10. This supplement does not authorize pruning or add a
retention duration. Any eventual compaction must preserve the accepted replay,
event-rebuild and audit guarantees and needs a separate owner contract if it
changes them.

## Open review gate

The physical design remains blocked on independent review of the new exact
preflight/legacy disposition, whether the accepted P3/P38 source can provide
canonical binding at the P39 point in the ordered migration sequence, and
whether the existing D0A `ProfileUnavailable` public reason plus physical
`LegacyProfileUnavailable` provenance is sufficient (the alternative expands
the closed P4/P3 union and requires separate governance). A contradictory fact
arriving after terminal P4/P3 state remains append-only audit evidence and
cannot roll back that state; any new post-terminal Attention event requires
separate P9/P10 governance. The new CLI/sidecar contract also requires review
of its P1/P14/P9 ownership, P39 preflight ordering before P37/P38, main→sidecar
lock order/maintenance writer-quiescence precondition, sidecar schema/key/
retention, and Windows local-VFS power-loss qualification (network/unknown
filesystems remain blocked). Reconciliation-derived terminal
Success/ExpectedFailure/ReconciledNoEffect must agree with the exact selected
same-attempt fact; P36 historical terminal rows remain unselected. Until these
questions are closed, there must be no owner-document
landing, P39 migration implementation, test implementation, or release claim.
This draft cannot be used to infer that the green
`C:\Arbor@f80` tree contains P36/P37/P38/P39, or that `db929` contains
P37/P38/P39.
