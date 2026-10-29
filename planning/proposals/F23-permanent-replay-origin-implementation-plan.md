# F23 P8/P6 Permanent Replay Origin — Fixed Implementation Plan

Status: **planning only; implementation authorization requested**

Planning baseline: `58aae35b08738019749ba5bba17a26f564f0cd57`

Accepted design: DID v1.46 + v1.47; accepted proposal SHA-256 `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`; supplemental P6 mechanics SHA-256 `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`

Requested token: `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION`

## Authorization and boundaries

The accepted P8 and P6 contracts are implementation-ready. This plan requests the separate implementation authorization named above. Until accepted, it authorizes no implementation work. After acceptance, scope is limited to migration `0045` (`requiresUserVersion: 44`), the P8 origin and UnboundLegacy disposition path, P6 Governance Inbox projection/routing, the P1 same-transaction route-move path, offline upgrade CLI support through schema 45, and the qualification below.

Use only fresh databases and explicitly disposable copies. The migration is an offline CLI operation. Do not open, upgrade, mutate, or use the preserved/dogfood database; do not deploy, release, or claim release readiness. Do not change `docs/design/**`, prior migrations, F23 receipt tuple comparison, Resolver-before-Gateway ordering, P10 sources, or schemas outside the accepted P8/P6/P1 route. Do not add a new Inbox kind, asynchronous route reconciliation, receipt pre-read, or an Inbox consumption/Agent path.

## Fixed implementation decisions

- Register the next ordered schema step as migration `0045`, named `retry_verification_origin_and_unbound_legacy_inbox`, with exact predecessor 44. Add it after migration 0044 in the offline ordered prefix; advance the offline/runtime schema target to 45 only when the implementation is separately authorized and qualified. No earlier migration is edited or renumbered.
- Use the accepted `retry_verification_origins` and `retry_verification_legacy_dispositions` fields, keys, constraints, and immutability triggers verbatim from P1 `04` (DID v1.46). The disposition has command/project/source Work/source Verification, fixed `UnboundLegacy` and `OriginEvidenceIncomplete`, and `created_at`; no payload or receipt bytes are added.
- Rebuild `inbox_entries` inside migration 0045 to preserve all seven existing columns and its primary key, then add `revision INTEGER NOT NULL CHECK (revision >= 1)` and `updated_at TEXT NOT NULL`. Copy every old row with `revision=1` and `updated_at=admitted_at`; restore `idx_inbox_unconsumed`. Seed 1 is the initial materialized state: the accepted transition says each actual route move increments revision, while `admitted_at` is the logical creation time and is preserved. Every new Inbox insert supplies revision 1 and `updated_at=admitted_at`; an actual route move changes `workspace_id`, increments revision exactly once and sets `updated_at` from the same P1 transaction timestamp. A no-op route reconciliation changes neither.
- Backfill is evidence-gated and transaction-atomic with DDL. Implement an offline migration callback/runner path only if the existing SQL-only migration runner cannot express the accepted typed preflight/backfill. It must use trusted P8 codecs and canonical rows; never infer from Session text, partial receipt, or pruned/duplicate events. A proved exact handoff gets one origin; an otherwise recognized successful receipt is preserved and gets one immutable UnboundLegacy disposition plus one Governance Inbox row. Unknown current recipient aborts the whole migration.
- Origin writes share the successful P1 Gateway transaction with handoff facts and receipt. Resolver reads only declared origin facts and current authorization/source scope. Gateway remains the sole receipt lookup and tuple comparison point. Inbox key is `retry-verification-unbound:<commandId>`, kind remains `Governance`, and reads re-check current human authority without consuming the item.
- Owner/Parent route changes move the same-key Inbox row in the same P1 command transaction. If the move cannot commit atomically, use the existing Gateway `TerminalRejected(AuthorityDenied)` receipt/attempt path with zero canonical Work/Workspace/Event/Inbox/disposition mutation. Rebuild uses disposition plus canonical Work/Workspace only, never Command receipt or retained Events.

### Migration 0045 DDL sketch (exact object shape)

Create the accepted origin/disposition relations and immutable guards exactly as follows (the deferred Command FK preserves the existing P8 handler-before-Gateway-receipt transaction order):

```sql
CREATE TABLE retry_verification_origins (
  command_id                       TEXT PRIMARY KEY,
  project_id                       TEXT NOT NULL REFERENCES projects(project_id),
  actor                            TEXT NOT NULL,
  source_verification_id           TEXT NOT NULL REFERENCES verifications(verification_id),
  source_work_id                   TEXT NOT NULL REFERENCES works(work_id),
  successor_verification_id        TEXT NOT NULL REFERENCES verifications(verification_id),
  successor_verifier_execution_id  TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  UNIQUE (source_verification_id),
  UNIQUE (successor_verification_id),
  UNIQUE (successor_verifier_execution_id),
  FOREIGN KEY (command_id) REFERENCES commands(command_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE retry_verification_legacy_dispositions (
  command_id             TEXT PRIMARY KEY REFERENCES commands(command_id),
  project_id             TEXT NOT NULL REFERENCES projects(project_id),
  source_work_id         TEXT NOT NULL REFERENCES works(work_id),
  source_verification_id TEXT NOT NULL REFERENCES verifications(verification_id),
  disposition            TEXT NOT NULL CHECK (disposition = 'UnboundLegacy'),
  reason_code            TEXT NOT NULL CHECK (reason_code = 'OriginEvidenceIncomplete'),
  created_at             TEXT NOT NULL
);
CREATE TRIGGER retry_verification_origins_immutable_update
BEFORE UPDATE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_origins_immutable_delete
BEFORE DELETE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_update
BEFORE UPDATE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_delete
BEFORE DELETE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;
```

The Inbox rebuild is:

```sql
ALTER TABLE inbox_entries RENAME TO inbox_entries_schema44;
CREATE TABLE inbox_entries (
  workspace_id    TEXT NOT NULL,
  entry_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  correlation_id  TEXT,
  admitted_at     TEXT NOT NULL,
  consumed_at     TEXT,
  revision        INTEGER NOT NULL CHECK (revision >= 1),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, entry_key)
);
INSERT INTO inbox_entries
  (workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
   consumed_at, revision, updated_at)
SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at,
       consumed_at, 1, admitted_at
FROM inbox_entries_schema44;
DROP TABLE inbox_entries_schema44;
CREATE INDEX idx_inbox_unconsumed ON inbox_entries(workspace_id)
  WHERE consumed_at IS NULL;
```

The actual implementation must preserve the current row count, values, primary key, and partial-index behavior exactly. The existing index follows the renamed table and is removed with it before the same named index is recreated. Verify no FK points to `inbox_entries` before finalizing this rebuild; if that inventory contradicts the schema44 source contract, stop and report instead of improvising a rebuild.

## Implementation work sequence

1. Pin and record the 44→45 offline fixture fingerprint; inventory every Inbox insert/update/query, Work/Workspace owner-change transaction, Resolver dependency, P8 RetryVerification handler, offline CLI/schema-target assertion, and exact current red reproducer.
2. Add migration 0045 and exact evidence preflight/backfill; qualify fresh schema, 44-prefix disposable upgrade, rollback-before-commit, committed re-entry, and current-authority route availability. Never run the migration against a preserved DB.
3. Add P8 successful origin write and permanent current-authorized replay route while retaining Gateway tuple-first behavior and the missing-receipt corruption branch. Add legacy UnboundLegacy classification and P6 route/read/rebuild integration.
4. Add atomic owner/Parent route moves and the ordinary Gateway typed rejection branch when route movement cannot be atomic. Populate `revision` and `updated_at` on all existing Inbox writers.
5. Extend the offline CLI to apply ordered steps 45 only, with explicit disposable target validation. Do not advance release/deployment state as part of this plan.

## Required qualification matrix

| Surface | Required cases |
|---|---|
| Fresh/upgrade | Fresh 45; exact 44→45 prefix; row-preserving Inbox rebuild; `revision=1`, `updated_at=admitted_at`; FK/integrity checks; rerun no-op; interruption rolls back all DDL/backfill and resumes cleanly |
| Origin backfill | Strict exact positive event-pair/receipt/canonical successor proof; each missing/pruned/duplicate/malformed/conflicting proof becomes preserved receipt + one disposition + one current-route Inbox row; unresolvable route aborts all |
| Replay | First public retry then same authorized exact CommandId/payload returns byte-identical receipt/IDs; changed non-source tuple reaches Gateway conflict; wrong actor/project/source, revoked authority, arbitrary CommandId deny before Gateway; origin with missing receipt gives safe corruption/no handler/writes |
| Inbox | Stable key and `Governance` kind; current root/direct-parent authorization; read does not consume; rebuild survives receipt corruption and event pruning; exact source mismatch is typed corruption; route move preserves admitted time, increments revision once, and updates time atomically; no-op is unchanged |
| Owner route command | Before/after commit crash sides; old recipient immediately denied and new current recipient reads same key; unavailable move is Gateway terminal rejection and no canonical/event/inbox/disposition mutation; same-ID replay and different-ID independent rejection |
| Runtime/public | Real daemon/public `/commands` journey including receipt tuple integrity, receipt-first ordering, current authorization, one successor chain, no duplicate Provider/Execution/Event, and safe errors; include existing P1 exact-tuple corruption suite |

Required source REDs: `planning/results/F23-retry-verification-permanent-replay.result.md` and `planning/results/F23-P6-unbound-legacy-inbox-mechanics.result.md`. Their pending tests remain RED until this separately authorized implementation is performed; this plan does not count them as qualification.

## Stop conditions and exclusions

Stop and request governance if an exact Inbox row rebuild requires new payload storage semantics, if accepted recipient derivation cannot resolve uniquely, if route-move transaction cannot share the canonical owner/Parent transaction, or if migration backfill requires an inference not explicitly permitted by DID v1.46/v1.47. No event-only replay origin, no state-only replay authority, no asynchronous reconciliation fact, no online database, no preserved fixture, no deployment/release, and no implementation before the token is accepted.
