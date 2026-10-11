# AH7-DG-01 / P39-P40 `ReconciledNoEffect` Compatibility Matrix

Status: **DRAFT companion matrix to the P39/P40 compatibility addendum**

## 1. Closed P40 terminal-tag cases

| Settlement/tag | P39/P40 row predicate | Observation evidence | Ref / Artifact | Replay or legacy disposition |
|---|---|---|---|---|
| `Success` | Existing P4 tag and terminal CAS | Accepted DG01 v1 full envelope, ≤16,384 UTF-8 bytes | row `result_ref` equals observation `resultRef`; valid Artifact metadata required when non-NULL | Exact first text/truncated; no executor on replay |
| `ExpectedFailure` | Existing P4 tag and terminal CAS | Accepted DG01 v1 full envelope | `result_ref=NULL`; no Artifact | Exact Failed text/truncated; legacy non-NULL ref=`UnexpectedResultRef` |
| `Interrupted` | Existing P4 tag and terminal CAS | Accepted DG01 v1 full envelope `{_tag:"Interrupted"}` | `result_ref=NULL`; no Artifact | Existing P3 Interrupted projection; legacy non-NULL ref=`UnexpectedResultRef` |
| `OutcomeUnknown` | Existing P4 tag and terminal CAS | Accepted DG01 v1 full envelope; ordered refs 1–8, each ≤128 UTF-8 bytes | `result_ref=NULL`; no Artifact | Existing P3 ReconciliationPending/OutcomeUnknown mapping; over-limit new refs remain unsettled |
| `RuntimeFailure` | Existing P4 tag and terminal CAS | Accepted DG01 v1 full envelope; cause ≤1,024 UTF-8 bytes after accepted first-write closure | `result_ref=NULL`; no Artifact | Exact Failed text/truncated; legacy oversized cause=`Malformed` |
| DG03 `Denied` | `settlement_kind='Denied'`; `effect_admission_state='NotAdmitted'`; closed DG03 reasonCode; `projectionVersion=1` | All three P40 evidence columns NULL; no CanonicalToolObservation envelope | `result_ref=NULL`; no Artifact | Existing deterministic code→Denied projection. Never ExpectedFailure; no DG01 missing-evidence escalation |
| P39 `ReconciledNoEffect` (new after P40) | `MayHaveStarted`; P39 `settlement_provenance='Reconciliation'`; `recovery_binding_state='Bound'`; selected attempt/fact both set and composite FK exact | Same P40 v1 envelope with `_tag`, closed P39 reasonCode, exact selected `reconciliationFactRef`, `{text,truncated}`, and `resultRef` | P39 selected `NotOccurred` fact has `result_ref=NULL` + non-NULL proof `evidence_ref/hash`; P4 row `result_ref` is a separate non-NULL ArtifactRef equal to Observation `resultRef` | Exact stored bounded text/truncated and same P3 sourced projection; never Denied/ExpectedFailure |
| P39 `ReconciledNoEffect` (legacy row predating P40 evidence) | Preserve P39 terminal, selected fact, proof, artifact and all P39 columns unchanged | Evidence remains NULL; no migration backfill | Preserve row ArtifactRef/selected fact; never rewrite either | Valid current generation: `Missing`→RecoveryBlocked/P9 fact/P10 Attention for a still-Pending P3 action; no ToolResult/Observation/Action/cursor write and no re-reconcile/re-execute |

P39 `ReconciledNoEffect` reason codes are exactly
`AuthoritySnapshotChanged`, `ResourceSnapshotChanged`,
`ApprovalNoLongerAuthorized`, `StopRequested`, and `ReplayLimitReached`.
They remain distinct from P39 reconciliation fact `outcome='NotOccurred'`
and its `reason_code IS NULL`. The reason records why attempt-1 replay was
suppressed; the selected immutable fact proves the exact attempt did not occur.

## 2. Proposed closed SQL validation branch

This is the P40 addition to the accepted physical P40 `CASE settlement_kind`
branch, not a new P39 column/table. It is added to both new-terminal insert and
unsettled→terminal update validators. The surrounding P40 trigger retains the
five accepted DG01 evidence branches, the separate DG03 Denied branch, the
all-NULL intent rule, and COALESCE fail-closed handling; every update to a
terminal row remains immutable.

```sql
WHEN NEW.settlement_kind = 'ReconciledNoEffect' THEN COALESCE((
  NEW.settlement_provenance = 'Reconciliation'
  AND NEW.effect_admission_state = 'MayHaveStarted'
  AND NEW.recovery_binding_state = 'Bound'
  AND NEW.recovery_binding_sha256 IS NOT NULL
  AND NEW.selected_attempt_no IS NOT NULL
  AND NEW.selected_fact_id IS NOT NULL
  AND NEW.result_ref IS NOT NULL
  AND NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
  AND NEW.observation_json IS NOT NULL
  AND NEW.observation_sha256 IS NOT NULL
  AND json_valid(NEW.settlement_json)
  AND json_valid(CAST(NEW.observation_json AS TEXT))
  AND json_extract(NEW.settlement_json, '$._tag') = 'ReconciledNoEffect'
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = 'ReconciledNoEffect'
  AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
    'AuthoritySnapshotChanged','ResourceSnapshotChanged',
    'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached'
  )
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
      json_extract(NEW.settlement_json, '$.reasonCode')
  AND json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') =
      NEW.selected_fact_id
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated')
      IN ('true','false')
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref
  AND EXISTS (
    SELECT 1 FROM tool_reconciliation_facts AS f
    WHERE f.fact_id = NEW.selected_fact_id
      AND f.invocation_id = NEW.invocation_id
      AND f.attempt_no = NEW.selected_attempt_no
      AND f.fact_origin = 'ProfileReconciliation'
      AND f.fact_disposition = 'RecoveryInput'
      AND f.binding_sha256 = NEW.recovery_binding_sha256
      AND f.outcome = 'NotOccurred'
      AND f.reason_code IS NULL
      AND f.evidence_ref IS NOT NULL
      AND f.evidence_sha256 IS NOT NULL
      AND length(f.evidence_sha256) = 64
      AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND f.result_ref IS NULL
  )
), 0)
```

The surrounding observation BLOB `CHECK` enforces SQLite BLOB type, valid JSON,
and `length(observation_json) BETWEEN 1 AND 16384`; the format/hash columns
enforce fixed version and lowercase 64-hex shape. SQLite does not calculate
SHA-256: the P4 writer/replay codec strictly validates UTF-8, canonical key and
array order, the version+LF+body hash, exact P39 typed fact/attempt/RecoveryBinding,
P3 action identity, and that the P4 ArtifactId resolves to its immutable
metadata. SQL verifies exact fact/tag/reason/ref relationships and the P39
selected-fact provenance. `COALESCE(...,0)` means absent JSON paths or NULL
comparisons reject a new terminal write.

The legacy terminal immutability trigger must also include all P40 evidence
columns and preserve P39 `settlement_provenance`, `selected_attempt_no`, and
`selected_fact_id`; P40 never changes those P39 fields. The accepted DG03
Denied branch remains separate and requires `NotAdmitted`, closed reasonCode,
version-1 projection, no result Artifact and all three P40 evidence columns
NULL.

## 3. Ref and P3 source qualification matrix

| Case | P39 selected fact / attempt | P39 proof refs | P4 row and Observation | P3 source/result identity |
|---|---|---|---|---|
| New valid RNO | same invocation + attempt; `RecoveryInput/NotOccurred`; P39 composite FK and P4 transaction verify exact binding/profile/effect key | selected fact id equals settlement and observation `reconciliationFactRef`; `evidence_ref/hash` required; fact `result_ref=NULL` | row `result_ref` is a valid P4 ArtifactRef; `CanonicalToolObservation.resultRef` equals row ref; exact bounded text/truncated in hashed P40 body | D0A/P39 reasonCode mapping unchanged; `ToolResult.modelOutputRef` carries exact selected fact/Artifact provenance; P3 `resultRef` is the existing bounded-payload hash, not Artifact/fact id; `observationRef` formula and all three source refs remain unchanged |
| Duplicate same P39 proof/fact | same `selected_fact_id`; no replacement | same exact `evidence_ref/hash`; NotOccurred fact result remains NULL | P4 terminal row/body/hash/ref are immutable and read as winner | one ToolResult, one Session source entry, one Action/Observation source and one cursor advancement |
| Different/conflicting fact or attempt | no fact replacement; composite FK and full P4 binding check fail closed | preserve both P39 facts as P39 dictates; no arbitrary selection | no RNO terminal/evidence overwrite; typed P39/P4 failure | no candidate ToolResult/cursor; follows existing unresolved P39 gate, not DG01 ExpectedFailure or Denied |
| Pre-P40 settled RNO, P3 action still Pending | preserve P39 selected fact and settlement | preserve P39 evidence/result refs | NULL P40 evidence remains; migration does not backfill | valid fence→`Missing`, RecoveryBlocked + one P9 replay-evidence fact/P10 marker; no ToolResult/Observation/Action/cursor; no reconciliation/Executor |
| Any RNO row, stale generation | do not read or mutate selection | do not read/project proof winner | do not inspect P40 evidence/ref | `LeaseFencingRejected` only; no P3 projection and no P9/P10 replay-evidence Attention; next valid generation checks exact winner |
| P4 terminal RNO commit, then crash before P3 | P39 selected proof and P40 envelope committed atomically | exact P39 fact | P4 returns the same verified canonical RNO observation after restart | P3 appends the original text/truncated and stable source once; Provider/Executor/reconcile are not re-run |

The P3 tuple is not redefined by P40: `P3 resultRef` is the bounded-payload
hash; `observationRef` is the existing stable
`observation_${executionId}_${sha256Hex(JSON.stringify({providerTurnId,callRef,resultRef}))}`;
Session source ref, ToolResult observationRef and AgentLoopStepAction
`observation_source_ref` remain equal. The P4 Artifact ID, P39 selected fact
ID and P3 content hash are three different identities and must not be aliased.

## 4. Migration, startup and cross-process kill matrix

| Boundary / race | Required state after restart or competing process |
|---|---|
| P39 has committed, P40 has not begun | Primary is at `user_version=39`; Runtime remains unavailable. Resume cumulative migration only; never serve P39-only RNO rows. |
| Kill before P40 DDL transaction | `user_version=39`, no partial P40 object/data; same full prefix retry. |
| Kill during P40 transaction | SQLite rolls back all P40 DDL and version bump; no RNO evidence backfill/selection rewrite. |
| Kill/response loss at P40 COMMIT | Reopen/read version and exact P40 schema transactionally: version 40 means committed, 39 allows identical serialized retry; ambiguous/corrupt state refuses service. |
| Kill after P40 commit, before service start | Version 40 and complete P40 objects; next startup may start only after prefix/schema checks. |
| Two OS daemons observe version 39 | Global startup migration coordinator serializes one cumulative runner; loser waits/re-reads version 40. Current runner qualification is still a release gate. |
| P4 RNO selected-fact/body commit before/after kill | Before commit: neither P39 terminal update nor P40 observation/hashes survive; after commit: both survive as one terminal immutable winner. No P39 fact or selected fact is duplicated/rewritten. |
| Two P4 connections/OS processes compete for same ToolInvocation | One P39/P4 terminal winner only; loser passes current fence, reads exact winner, validates P39 selected fact + P40 hash/ref and returns only winner Observation; no losing Artifact or fact selection. |
| Kill after P4 RNO commit, before P3 | Restart replays same exact text/truncated, reasonCode/fact/ref and P3 source once; no reconcile/executor/provider. |
| Legacy RNO missing P40 body under valid fence | Preserve row/selected fact; RecoveryBlocked + P9/P10 replay-evidence Attention; no ToolResult/cursor and no re-execution. |
| Stale generation sees legacy/corrupt RNO | Fence before row read: `LeaseFencingRejected` only, no evidence inspection or Attention; valid next generation handles the exact winner. |

P39's `--migration-block-report-db` preflight/sidecar remains the accepted
P39-only gate before pending P37/P38/P39 DDL. P40 neither changes nor reuses
that sidecar. P36–P40 prefix integration, cross-process migration serialization,
and Windows/local-filesystem sidecar durability are explicit unqualified
prerequisites. This matrix defines future qualification only; no tests,
migrations, daemon runs, or release checks were run for this proposal.

The runtime binary is also schema-gated: a P39-only/older binary must refuse
`user_version=40` before service startup. Only a binary whose closed
`p4-canonical-tool-observation-v1` decoder includes the separately accepted
RNO branch may serve the migrated schema.
