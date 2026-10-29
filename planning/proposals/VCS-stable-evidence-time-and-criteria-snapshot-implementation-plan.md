# VCS Stable Evidence Time and Criteria Snapshot — Fixed Implementation Plan

Status: **planning only; implementation authorization requested**

Planning baseline: `58aae35b08738019749ba5bba17a26f564f0cd57`

Accepted design: DID v1.48; proposal SHA-256 `B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56`

Requested token: `AUTHORIZE_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT_IMPLEMENTATION`

## Authorization and boundaries

This plan requests a separate implementation authorization. Scope is migration `0046` (`requiresUserVersion: 45`), P8 verification persistence/commands, P9 receipt-first recovery, the exact required schema/runtime targets, disposable migration fixtures, and the qualification matrix below. It depends on migration 0045 and the P6/P8/P1 implementation in plan A. No work starts before the token is accepted.

Use fresh databases and disposable copies only. Offline CLI may apply the ordered 44→45→46 prefix; do not upgrade a preserved/dogfood DB, deploy, release, or claim release readiness. Do not edit `docs/design/**`, prior migrations, P8 aggregation/evidence authority, G5 semantics, P4 behavior, or historical v1 event/receipt bytes. Do not add a full-snapshot digest or a schema-version fallback.

## Fixed implementation decisions

- Migration identity is `0046`, `requiresUserVersion: 45`, name `verification_evidence_snapshot`; append after 0045 and advance the offline/runtime schema target to 46 only within the authorized implementation and its qualification.
- Add nullable `criteria_results TEXT` and `snapshot_status TEXT NOT NULL DEFAULT 'Pending' CHECK (snapshot_status IN ('Pending','Available','NotApplicableOrphaned','UnavailableLegacy'))` to `verifications`. Keep existing `mission_snapshot`, `verdict`, `summary_ref`, `conclusion_reason` and all IDs unchanged.
- Preserve `criteria_results IS NULL` for `Pending` and `UnavailableLegacy`; serialize `[]` only for the newly proved `NotApplicableOrphaned` G5 case. New ordinary conclusions store the complete ordered snapshot and `Available`. Before schema writes, strictly preflight every Open row against the exact verification/work/revision and its `VerificationStarted` event; `missionDigest` is only weak consistency. Abort the entire migration before DDL/data writes if any Open row cannot be proved. Mark every pre-migration Concluded row `UnavailableLegacy`; do not rewrite verdict, event, receipt, summary, Evidence, or mission snapshot and do not infer criteria.
- Enforce allowed status and row-shape combinations in SQLite insert/update guards and validate complete typed snapshot semantics in P8 persistence/runtime. Required combinations: `Pending`=Open/null criteria; `Available`=Concluded/non-null complete criteria and not Orphaned; `NotApplicableOrphaned`=Concluded/Unknown/Orphaned/`[]`; `UnavailableLegacy`=Concluded/null criteria. Existing `conclusion_reason` domain constraint remains unchanged.
- `RecordVerificationEvidence.recordedAt` is the persisted first-intent P9 `ActionIntent.updatedAt`. Preserve that instant whenever the same action remains Pending and across owner-generation takeover. If it cannot be proven to be the original intent value, fail closed; never call a replacement clock source in the handler.
- New ordinary `ConcludeVerification` writes use result/receipt v2 and `VerificationConcluded` v2 with byte-identical mission snapshot, ordered criteria results, verdict, summary reference, status and reason across row/event/result. RetryVerification's G5 outer result/receipt remains strict v1 with the same existing IDs and no inner Conclude receipt; its row/event use v2 `Unknown`/`Orphaned`/`NotApplicableOrphaned`/empty criteria, and exact replay validates that row/event binding before returning the exact original v1 receipt.
- AH10 recovery decodes prior-generation receipts using the registered strict schema before issuing a new command. Exact durable row/event/evidence convergence returns the prior receipt with no handler invocation or duplicate fact. Missing, malformed, unsupported or conflicting evidence fails closed without Observation, repair, Provider replay, or invented snapshot.

### Migration 0046 DDL and initialization sketch

```sql
ALTER TABLE verifications
  ADD COLUMN criteria_results TEXT;
ALTER TABLE verifications
  ADD COLUMN snapshot_status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (snapshot_status IN
      ('Pending','Available','NotApplicableOrphaned','UnavailableLegacy'));
UPDATE verifications
   SET snapshot_status = 'UnavailableLegacy'
 WHERE state = 'Concluded';
```

The preflight runs in the offline migration transaction before any DDL. The new row-shape guards reject all combinations outside the four accepted states above. The active Open rows remain `Pending` only after preflight proved and retained their already-stored `mission_snapshot`; no snapshot is reconstructed from events. The nullable criterion JSON is intentional: `NULL` means unavailable/not yet produced, while `[]` is reserved for the explicit new G5 Orphaned case. Runtime codecs enforce completeness, order, exact copied criteria, evidence ownership, deterministic verdict aggregation, and summary byte verification; SQLite does not become a second criterion evaluator.

## Implementation work sequence

1. Capture isolated REDs in `tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts` and `tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts`; inventory result/event codecs, P9 ActionIntent write/update, P8 handlers, history readers and current migration 45 fixture.
2. Implement migration 0046 with read-only complete preflight before DDL, then atomic DDL/backfill; qualify clean 45→46, invalid Open-row abort-before-write, Concluded-to-UnavailableLegacy, rollback, re-entry and FK/integrity.
3. Extend domain/store/codecs to preserve mission and criteria snapshots and enforce four statuses. Implement P8 v2 ordinary writes while maintaining strict v1 decode and unchanged v1 historical data; preserve G5 outer receipt v1.
4. Bind `recordedAt` to persisted first-intent timestamp and preserve it across Pending transitions/takeover. Implement receipt-first P9 convergence for evidence, ordinary conclusion and G5 replay.
5. Extend offline CLI to the ordered prefix through 46; update runtime schema/readiness target only under this token. Keep all qualification in fresh/disposable storage.

## Required qualification matrix

| Surface | Required cases |
|---|---|
| Migration | 45→46 disposable upgrade; Open valid strict snapshot proof; missing/malformed/wrong identity/Work revision/event association aborts before DDL or data mutation; digest never used to reconstruct; every old conclusion becomes `UnavailableLegacy` with unchanged canonical bytes; rollback/re-entry/FK/integrity |
| Status storage | All four valid status/state/value combinations; reject every invalid pairing, including non-Orphaned `NotApplicableOrphaned`, nonempty orphan criteria, Open Available, concluded Pending, Available Orphaned, and criteria JSON malformed |
| Evidence time | First intent writes exact immutable `updatedAt`; same-action retry and owner-generation takeover keep identical serialized request/fingerprint; crash before command reuses timestamp; unknown/replaced intent timestamp fails closed without clock selection |
| Ordinary conclusion | Complete ordered results copy every mission criterion exactly, require exact verification/criterion Evidence refs, preserve optional criteria, fixed required aggregation, byte-verified summary; row/event/result v2 exact equality; corruption/missing/mismatch produces no partial write |
| G5 RetryVerification | Strict outer v1 result/receipt and IDs unchanged; canonical row/event v2 exactly Unknown+Orphaned+NotApplicableOrphaned+[]; replay checks binding and returns original receipt; no inner receipt or duplicated successor/event |
| Historical | Strict v1 event/result/receipt decode unchanged; no relabeling or inferred criteria; historical result/summary/evidence bytes unchanged |
| AH10 crash/replay | Prior Committed receipt before Action observation converges from exact row/evidence; both crash boundaries for evidence and conclusion; G5 canonical binding; no duplicate Command/row/event, no handler/Provider replay; invalid/unsupported prior receipt fails closed without Observation |
| Regression/public | Both pending real-process REDs turn green; run P8 handler/result/event, P9 receipt-first recovery, P1 migration, public retry route, and existing P8/P6 suites as one scoped qualification on the authorized candidate |

No broad `pnpm check` or release gate is implied by these focused cases; the implementation owner must report exact commands, candidate SHA, counts and any omitted suite in the eventual result.

## Stop conditions and exclusions

Stop if an Open row cannot be proved from `mission_snapshot` plus exact canonical identity and `VerificationStarted`, if the first-intent timestamp source is not the exact durable P9 field, or if any implementation requires inferring historical results, changing G5, widening replay authority, rewriting v1 bytes, or adding a full-snapshot digest. No live/preserved DB, deployment, publication, migration before authorization, or implementation before token acceptance.
