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
  reconciliation_fact_id TEXT,
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Denied','Interrupted',
                            'OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')),
  settlement_json        TEXT,
  result_ref              TEXT REFERENCES artifacts(artifact_id),
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL)),
  CHECK (recovery_binding_state <> 'HistoricalSettled' OR settled_at IS NOT NULL),
  CHECK (recovery_binding_state <> 'LegacyBindingUnproven' OR settled_at IS NULL),
  CHECK ((recovery_binding_state = 'Bound') =
         (recovery_binding_sha256 IS NOT NULL)),
  FOREIGN KEY (invocation_id, recovery_binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (invocation_id, reconciliation_fact_id)
    REFERENCES tool_reconciliation_facts(invocation_id, fact_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((settlement_kind = 'ReconciledNoEffect') =
         (reconciliation_fact_id IS NOT NULL)),
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
                 result_ref, reconciliation_fact_id ON tool_invocations
WHEN OLD.settled_at IS NOT NULL AND (
     NEW.settled_at IS NOT OLD.settled_at
  OR NEW.settlement_kind IS NOT OLD.settlement_kind
  OR NEW.settlement_json IS NOT OLD.settlement_json
  OR NEW.result_ref IS NOT OLD.result_ref
  OR NEW.reconciliation_fact_id IS NOT OLD.reconciliation_fact_id)
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
reference `artifacts(artifact_id)`; P4 `ReconciledNoEffect` stores its exact
`reconciliation_fact_id` as a deferred FK to `tool_reconciliation_facts(fact_id)`.
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
settled time/kind/payload/result/fact reference. A new contradictory proof
after terminal is appended only as `fact_disposition='PostTerminalEvidence'`;
it cannot become a `RecoveryInput`, replace the selected terminal fact, undo P4
settlement, roll back P3 ToolResult/Action/cursor, or cause replay. If that
late contradiction is confirmed against the selected fact, the appended fact
is `StillUnknown/EvidenceBindingMismatch`; identical redelivery returns the
existing fact, while the contradictory fact is retained separately. P4 does
not change `reconciliation_fact_id` or any terminal settlement field, and P3
does not reverse Action/ToolResult/cursor. If that late contradiction must
create new user-visible Attention, D0A does not define that post-terminal
notification; it is a separate P9/P10 Design Gap. This proposal does not invent
a second event or mutate terminal truth.

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
  unsettled P36 MayHaveStarted/LegacyUnknown rows lacking a complete persisted
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

### P39 CLI report contract and permanent legacy-DB isolation

The P39-enabled migration/startup path requires the operator to pass
`--migration-block-report <absolute-path>` before the SQLite client is
constructed. The option is scoped to a P39-targeting binary; older binaries do
not need it. There is no default. Missing/invalid destination or unsupported
durability fails before any DB open/read with typed
`P39_BLOCK_REPORT_PATH_REQUIRED`, `P39_BLOCK_REPORT_PATH_INVALID`, or
`P39_REPORT_DURABILITY_UNSUPPORTED`, process exit code `78`, and no report
because no report sink was validly designated.

The operator must choose an existing directory on a qualified durable local
volume. Reject relative paths, OS temp locations (`/tmp`, `%TEMP%`, and their
resolved aliases), network/UNC destinations, symlink/reparse-point path
components, a target equal to the DB/WAL/SHM path, and a missing parent
directory. The tool never creates parent directories or overwrites an
unrelated file. On POSIX, resolve and pin the existing parent directory once,
perform temp/create/publish relative to that directory handle, require the
operator-protected directory to be on a qualified same-volume filesystem, and
use a basename only (no separators or `..`). The deployment operator owns the
directory ACL; the report file is created owner-only. The path and raw
database path are never placed in report content.

If the database is already at `user_version=39` or is a fresh/unaffected DB,
the migration proceeds normally after the preflight. Otherwise P39 takes one
`BEGIN IMMEDIATE` consistent SQLite snapshot, reads `user_version` and all P36
unsettled `NotAdmitted` invocation IDs plus only the P36/P38/P3 identity/state
fields needed to fingerprint that blocked set, and performs no writes. If the
set is non-empty, it rolls back and closes the DB before publishing a report.
The transaction performs no DDL/DML and does not bump `user_version`; SQLite
may transiently open/manage WAL/SHM lock sidecars, but no P36 schema, committed
row, approval, or P3 cursor state changes.
The stable JSON has no timestamp, resource path, command, argument, authority
secret or raw SQLite error:

```json
{
  "schema": "arbor.p39-legacy-db-isolation.v1",
  "kind": "P39LegacyUnboundNotAdmitted",
  "observedUserVersion": 38,
  "targetUserVersion": 39,
  "databaseFingerprint": "lowercase sha256",
  "blockedInvocationIds": ["sorted exact IDs"],
  "contentHash": "lowercase sha256 of canonical JSON without this field"
}
```

`databaseFingerprint` is SHA-256 over the existing canonical JSON encoding of
`{observedUserVersion, sorted blocker rows}` where each row contains only
invocation ID, execution ID, admission state, unsettled marker, approval ID
and consumed-by invocation identity, plus P3 Step/Action/cursor identity/state;
this fingerprints the affected DB state without exporting tool arguments,
resource paths or principal secrets. Canonical key/array ordering makes
complete report bytes and `contentHash` identical when the same DB state is
reported again. Typed stderr diagnostics contain only stable error/exit codes;
they never echo report or database paths.

On supported POSIX local filesystems, publication happens only after
rollback/connection close, in the target's own directory/volume: create a
unique temp file with exclusive create and owner-only permissions; write all
exact UTF-8 JSON bytes; fsync the file; atomically publish without replacement
using `renameat2(RENAME_NOREPLACE)` or a qualified equivalent (same-directory
hard-link the already-fsynced inode to the final name, then unlink the temp
name); finally fsync the parent directory. If the target
already contains byte-identical report content, treat publication as idempotent
and do not rewrite it. If it contains different bytes, fail with
`P39_REPORT_TARGET_CONFLICT`; never overwrite or delete it. Any write/sync/
publish failure yields typed `P39_REPORT_PERSIST_FAILED` and nonzero exit `78`;
the P36 DB remains unchanged and P39 startup is blocked. The deployment
operator owns durable retention and cleanup of report files; the application
never rotates, replaces, or deletes them.

#### Platform durability support

P39 v1 report publication is enabled only on a qualified local filesystem where
file fsync, atomic no-replace publication and directory fsync are all
implemented and verified. The current Node `fs` interface describes sync as
OS/device-specific and does not provide a documented no-replace rename plus
directory-fsync contract on Windows. Win32 `MoveFileExW(MOVEFILE_WRITE_THROUGH)`
documents write-through completion, including a copy/delete case, and NTFS
write-through handles flush metadata; that documentation alone does not prove
the full required atomic no-replace + containing-directory durability bundle.
Therefore the proposal deliberately blocks P39 startup on Windows with
`P39_REPORT_DURABILITY_UNSUPPORTED` / exit 78 before DB open, until an accepted
platform implementation and power-loss qualification prove the complete
contract. No “best effort” report or stderr-only fallback permits migration.
Network filesystems and unqualified filesystems are also blocked. This
conservative Windows block follows the official API boundary: Node documents
`FileHandle.sync()` as OS/device-specific; Win32 `MoveFileExW(MOVEFILE_WRITE_THROUGH)`
describes flushed completion including the copy/delete case, and
`CreateFile(FILE_FLAG_WRITE_THROUGH)` documents metadata flush on NTFS, but
those statements do not establish the whole atomic-no-replace + parent-directory
fsync contract required here. References:
[Node.js `fs`](https://nodejs.org/api/fs.html),
[Microsoft `MoveFileExW`](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexa),
[Microsoft `CreateFile`](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilea).

#### Isolation disposition

After a preflight hit, report publication succeeds and the process exits with
typed `P39_LEGACY_DB_ISOLATED` / exit 78. That exact DB is permanently isolated
from P39: it is not upgraded, no P39 binary is launched against it, and its
committed schema/data/user_version, P36 invocation/P38 approval/P3
Action/Step/cursor remain as-is. No binding is fabricated, approval refunded/transferred, row
deleted, old attempt retried, or replacement ToolInvocation created. The
database and report remain under operator custody until a separate future
governance decision authorizes a human disposition. The deployment operator
who selected the report path owns access control, backup/retention and any
later cleanup of both original DB and report; the application never rotates,
replaces or deletes either. This does **not** close human recovery work for
that DB.

Release readiness is reported by DB cohort: fresh/unaffected DBs may qualify
for P39 on a supported platform with the report option; any DB with an active
P36 NotAdmitted row remains explicitly isolated and is not counted as
upgraded/released. This is the physical safety consequence of D0A’s rule that
exact historical shell@2 re-entry requires a complete binding; it adds no
automatic old-row recovery semantics.

The later accepted owner landing must place the CLI/migration gate in P1
`04-sqlite-schema.md` §5 and `06-recovery-matrix.md` §5, process-startup
failure/CLI behavior in P14 `02-conversation-execution.md` and `05-acceptance.md`,
and the exact P36 NotAdmitted no-dispatch/legacy gate in P9
`07-agent-loop-step-recovery.md`. No owner document is edited by this draft.

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
-- P39 CLI validates --migration-block-report, the absolute target, and
-- platform durability before constructing/opening the SQLite client.
PRAGMA foreign_keys = OFF; -- before transaction; required only for table rebuild
BEGIN IMMEDIATE;
-- Assert current user_version is 38 and required P36/P38 tables exist.
-- Read-only preflight under this write reservation: collect version,
-- consistent fingerprint, and unsettled P36 NotAdmitted IDs. If non-empty,
-- ROLLBACK, close SQLite, publish the stable JSON report through the durable
-- no-replace protocol, then return P39_LEGACY_DB_ISOLATED / exit 78. Do not
-- execute DDL or change user_version for this permanently isolated DB.
-- If empty, continue directly in this same transaction (no lock gap).
-- Create tool_invocations_p39 with the P39 settlement CHECK; copy every P36
-- row byte-for-byte for its existing values, then replace the old table.
-- Create binding/attempt/fact tables, indexes and immutability triggers.
-- INSERT one attempt-0 row per copied invocation using its exact P36 admission
-- state; leave sourceBinding/profile/effectKey null rather than infer them.
-- Set recovery_binding_state=HistoricalSettled for settled P36 rows and
-- LegacyBindingUnproven for unsettled MayHaveStarted/LegacyUnknown rows.
-- Backfill admission_source=P36Backfill; NotAdmitted precision=NotAdmitted;
-- MayHaveStarted/LegacyUnknown precision=UnknownLegacy, admitted_at=NULL.
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
| Same report path holds different earlier report | `P39_REPORT_TARGET_CONFLICT`, no overwrite/delete and no P39 DDL; operator retains prior report and must choose a new explicit path for a distinct report |
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
separate P9/P10 governance. The new CLI/report contract also requires review of
its P1/P14/P9 ownership, POSIX durable no-replace publication qualification,
operator retention responsibility, and the explicit Windows/network-filesystem
block. Until these questions are closed, there must be no owner-document
landing, P39 migration implementation, test implementation, or release claim.
This draft cannot be used to infer that the green
`C:\Arbor@f80` tree contains P36/P37/P38/P39, or that `db929` contains
P37/P38/P39.
