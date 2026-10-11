# AH7-DG-01 Physical Schema Supplement — Draft for Manual Review

状态：**DRAFT / 物理合同补充；未接受、未授权落地**

日期：2026-10-11

依赖已接受语义提案 SHA-256（LF）：
`19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`

语义提案 commit：`00fe6975341abb35e7d48536295423fe2fa75e1f`

基线：`f80ee9132774c0c1fb570744d81398fad17da188`，数据库全局 `user_version=35`

此稿只补列 P40 物理 schema、P9 fact/event、P10 Action Required row、migration、
rollback/rebuild 及重复写入合同，供独立 review 和 Governor 决策。它不修改 owner
文档或实现。P10 采用 source-specific replay-evidence marker table；failure code 留在
内部 projection row，不扩展公开 DTO，也不投影任何工具输出、cause 或 secret。

## 1. P40 前缀与发布边界

P40 `tool_observation_evidence` 只能出现在完整前缀之后：

```text
P36 AH7-DG-03 → P37 AH10 → P38 EA → P39 AH7-DG-02 (conditional) → P40 AH7-DG-01
```

这些 migration id/order 来自当前协调授权。P36–P39 的 owner DDL 与 commit 仍须先各自
集成；本稿不把条件性的 P39 视为当前 f80 基线已有的 migration。P40 不可作为单独
release、不能从 `user_version=35` 跳过 P36–P39 运行，也不进入 phase-local
`P4_MIGRATIONS`。集成时仅能由包含已集成 P39 的 cumulative production migration array
注册 P40，并要求入口 `user_version=39`；成功后更新为 `40`。

DG03 的 accepted proposal source commit 是
`ce08b55debcadc8d255bf43f6702ca8da592c129`，owner landing 是
`34ed1c597c02d677d87f4fa9435d8339641ea3d6`，landing record 是
`5cab270642f3a738f1da3dcb846ce734d477f8b2`，独立 implementation branch head 是
`codex/ah7-approval-settlement-governance@db929654128b8e864d3733b95088f4edda0e4c43`。
它们均不在 f80 的祖先链（merge-base `6fcbc17e27b694f201792aedd6c2ec368508b542`）。
P40 depends on that prefix integration; no DG03 Denied/Interrupted clauses are duplicated
here. After the prefix merge, owner consistency review must confirm P40 still matches the
accepted DG03 P4 terminal Denied/Interrupted representation.

### P40 runner and rollback

P40 is one atomic forward-only SQLite migration containing P4 field/trigger DDL and the
selected P9/P10 DDL. `runMigrations` commits migration statements and the `user_version`
bump in one transaction. Sequential retry at version 39 reapplies the whole migration after
rollback; sequential repeat at version 40 executes no statements. No data backfill is run:
historical `settlement_kind`, `settlement_json`, `result_ref`, `settled_at`, and all existing
rows remain byte/field unchanged. In particular, legacy nonSuccess rows with non-null
`result_ref` are preserved and are handled by the accepted `UnexpectedResultRef` replay
failure; P40 never clears, rewrites, or reclassifies them.

The current `runMigrations` implementation reads `user_version` before applying its per-
migration transaction. It does not establish cross-process exclusion for two simultaneous
migration runners that both read version 39. P40 rollout therefore requires the integrated
startup migration coordinator to serialize the cumulative migration run; if P36–P39 does
not supply that one-runner property, a migration-runner contract change is a separate
physical prerequisite. This supplement does not claim concurrent migration-runner safety.

## 2. P4 `tool_invocations` observation evidence DDL

The accepted logical package selected inline evidence, not a BlobStore reference. The exact
encoding is a BLOB containing the version-1 canonical UTF-8 JSON body, capped at 16,384
bytes. The SHA-256 is computed over
`UTF-8(observation_format_version + LF + observation_json_bytes)` and stored as 64 lowercase
hex characters. Hash computation and tag/field validation remain application responsibilities;
SQLite checks storage shape, version, body size/JSON validity, and cross-column/tag/ref
consistency.

Candidate additive column statements for `P40`:

```sql
ALTER TABLE tool_invocations ADD COLUMN observation_format_version TEXT
  CHECK (observation_format_version IS NULL OR
         observation_format_version = 'p4-canonical-tool-observation-v1');

ALTER TABLE tool_invocations ADD COLUMN observation_json BLOB
  CHECK (observation_json IS NULL OR
         (typeof(observation_json) = 'blob'
          AND length(observation_json) BETWEEN 1 AND 16384
          AND json_valid(CAST(observation_json AS TEXT))));

ALTER TABLE tool_invocations ADD COLUMN observation_sha256 TEXT
  CHECK (observation_sha256 IS NULL OR
         (length(observation_sha256) = 64
          AND observation_sha256 NOT GLOB '*[^0-9a-f]*'));
```

The three fields are all-null or all-present. A SQLite table-level `CHECK` cannot be added
to the existing table without rebuilding it, so P40 adds triggers after the nullable
columns. Existing terminal rows are grandfathered because P40 does not update/reinsert
them; new terminal inserts/transitions must carry the full evidence tuple. `Pending` intent
rows must have no observation fields. Candidate trigger contract:

```sql
CREATE TRIGGER tool_invocations_observation_insert_guard
BEFORE INSERT ON tool_invocations
WHEN
  (NEW.settled_at IS NULL AND
    (NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
     NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
     NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL))
  OR
  (NEW.settled_at IS NOT NULL AND NOT (
    NEW.settlement_kind IS NOT NULL
    AND NEW.settlement_json IS NOT NULL
    AND
    NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
    AND NEW.observation_json IS NOT NULL
    AND NEW.observation_sha256 IS NOT NULL
    AND json_valid(NEW.settlement_json)
    AND json_valid(CAST(NEW.observation_json AS TEXT))
    AND json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind
    AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind
    AND CASE NEW.settlement_kind
      WHEN 'Success' THEN (
        ((NEW.result_ref IS NULL AND
          json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null')
         OR
         (NEW.result_ref IS NOT NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref))
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
      WHEN 'ExpectedFailure' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
      WHEN 'Interrupted' THEN NEW.result_ref IS NULL
      WHEN 'OutcomeUnknown' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array'
        AND json_extract(NEW.settlement_json, '$.reconciliationRefs') =
            json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
        AND json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8
        AND NOT EXISTS (
          SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
          WHERE type <> 'text' OR length(CAST(value AS BLOB)) > 128))
      WHEN 'RuntimeFailure' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text'
        AND length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024
        AND json_extract(NEW.settlement_json, '$.cause') =
            json_extract(CAST(NEW.observation_json AS TEXT), '$.cause'))
      ELSE 0
    END
  ))
BEGIN
  SELECT RAISE(ABORT, 'tool invocation observation evidence invariant');
END;

CREATE TRIGGER tool_invocations_observation_update_guard
BEFORE UPDATE OF settled_at, settlement_kind, settlement_json, result_ref,
  observation_format_version, observation_json, observation_sha256
ON tool_invocations
WHEN
  (OLD.settled_at IS NULL AND NEW.settled_at IS NULL AND
    (NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
     NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
     NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL))
  OR
  (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND NOT (
    NEW.settlement_kind IS NOT NULL
    AND NEW.settlement_json IS NOT NULL
    AND
    NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
    AND NEW.observation_json IS NOT NULL
    AND NEW.observation_sha256 IS NOT NULL
    AND json_valid(NEW.settlement_json)
    AND json_valid(CAST(NEW.observation_json AS TEXT))
    AND json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind
    AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind
    AND CASE NEW.settlement_kind
      WHEN 'Success' THEN (
        ((NEW.result_ref IS NULL AND
          json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null')
         OR
         (NEW.result_ref IS NOT NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref))
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
      WHEN 'ExpectedFailure' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
      WHEN 'Interrupted' THEN NEW.result_ref IS NULL
      WHEN 'OutcomeUnknown' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array'
        AND json_extract(NEW.settlement_json, '$.reconciliationRefs') =
            json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
        AND json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8
        AND NOT EXISTS (
          SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
          WHERE type <> 'text' OR length(CAST(value AS BLOB)) > 128))
      WHEN 'RuntimeFailure' THEN (
        NEW.result_ref IS NULL
        AND json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text'
        AND length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024
        AND json_extract(NEW.settlement_json, '$.cause') =
            json_extract(CAST(NEW.observation_json AS TEXT), '$.cause'))
      ELSE 0
    END
  ))
  OR
  (OLD.settled_at IS NOT NULL AND (
    NEW.settled_at IS NOT OLD.settled_at OR
    NEW.settlement_kind IS NOT OLD.settlement_kind OR
    NEW.settlement_json IS NOT OLD.settlement_json OR
    NEW.result_ref IS NOT OLD.result_ref OR
    NEW.observation_format_version IS NOT OLD.observation_format_version OR
    NEW.observation_json IS NOT OLD.observation_json OR
    NEW.observation_sha256 IS NOT OLD.observation_sha256
  ))
BEGIN
  SELECT RAISE(ABORT, 'tool invocation terminal evidence is immutable');
END;
```

The listed SQL guards enforce this bounded subset; the P4 application codec MUST also
validate the full accepted settlement/observation schemas and artifact identity before
commit/replay. In particular:

- `Success`: `observation_json.$.resultRef` is JSON null iff row `result_ref` is SQL NULL;
  otherwise it is the exact row string and a valid P4 ArtifactId/Artifact reference.
- `ExpectedFailure`, `Interrupted`, `OutcomeUnknown`, `RuntimeFailure`: row `result_ref IS NULL`.
- `OutcomeUnknown`: canonical `reconciliationRefs` are the same ordered refs in settlement
  and observation JSON, count 1–8, each UTF-8 length ≤128 bytes.
- `RuntimeFailure`: canonical `cause` exactly matches settlement JSON and is ≤1,024 UTF-8
  bytes.
- `ExpectedFailure`/`Success`: `observation.text` is the first-settlement canonical text
  (≤2,000 UTF-16 code units), with the stored boolean `truncated` unchanged on replay.
- `Interrupted`: exact tag only; its existing Application projection remains the P3
  terminal/nonterminal path specified by the accepted logical proposal.

Application canonicalization MUST additionally preserve the accepted cap disposition before
the first settlement/return: oversized Success `resultRef` is omitted using the accepted
fixed Success fallback text and `truncated=true`, without taking the auto-Artifact branch;
oversized RuntimeFailure cause is replaced in both settlement and observation by
`RuntimeFailureDetailOmitted:ObservationEnvelopeExceeded` while retaining the tag; too many
or too-long OutcomeUnknown refs or an envelope still over 16,384 bytes keep the invocation
unsettled and return the accepted typed uncertain-effect path into existing reconciliation.
No first-write Success/ExpectedFailure/RuntimeFailure fact may be erased or rewritten as
OutcomeUnknown to fit storage.

| Canonical tag | Settlement and observation fields | `result_ref` / Artifact rule | P3 projection facts that must replay unchanged |
|---|---|---|---|
| `Success` | settlement `{_tag:"Success"}`; observation has bounded `text`, `truncated`, and null-or-valid Artifact `resultRef` | row ref equals observation ref; non-null ref must decode as ArtifactId and resolve to valid Artifact metadata. Auto-Artifact only when executor resultRef was originally null. No loser Artifact; no Artifact read to reconstruct text. | `Succeeded`, exact text/truncated/invocationId/source; only valid non-null ref becomes artifactRef. Invalid legacy ref → `ResultRefMismatch`. |
| `ExpectedFailure` | settlement `{_tag:"ExpectedFailure"}`; original bounded text/truncated | SQL `result_ref` null, no Artifact; discard executor-private resultRef | `Failed`, exact bounded text/truncated and no artifactRefs. Legacy non-null ref → `UnexpectedResultRef`. |
| `Interrupted` | exact `{_tag:"Interrupted"}` settlement and observation; no text/truncated in P4 ADT | SQL `result_ref` null, no Artifact | existing Application text `tool invocation interrupted`, `truncated=false`; legacy non-null ref → `UnexpectedResultRef`. |
| `OutcomeUnknown` | exact settlement refs and same ordered observation `reconciliationRefs` (1–8; each ≤128 UTF-8 bytes); no bounded text | SQL `result_ref` null, no Artifact. Legacy oversized refs → `Malformed`. | Existing terminal ToolResult/status/source/hash, Action `ReconciliationPending`, fixed text `Control action settled the execution (OutcomeUnknown)`, `truncated=false`, no artifacts. |
| `RuntimeFailure` | exact same settlement/observation `cause` (≤1,024 UTF-8 bytes after canonicalization) | SQL `result_ref` null, no Artifact | `Failed`; existing renderer text from cause, `truncated=false`; legacy oversized cause → `Malformed`. |

Across all tags, row settlement kind and both `_tag`s agree. P3 source remains the accepted
exact `(executionId, providerTurnId, actionIndex, callRef, toolName, inputHash)` source, and
the P4 invocation/result identity is not inferred from returned text, current tool state,
Artifact bytes or Session text. Legacy terminal rows lacking any new evidence field remain
nullable and immutable; same-action replay fail-closes as `Missing` (or the exact typed
version/hash/shape/settlement/intent/ref code) into RecoveryBlocked/P9 fact/P10 Attention,
without re-executor, ToolResult, cursor advance, evidence rewrite or Artifact projection.
When an existing row has a recognized non-Success settlement tag and non-null `result_ref`,
`UnexpectedResultRef` takes precedence even if its new observation columns are null; do not
read or attach that ref's Artifact. For a recognized Success row with missing evidence, use
`Missing`; once evidence is present, an invalid/mismatched Success reference is
`ResultRefMismatch`.

SQLite enforces the all-null/all-present transition, fixed version, BLOB/size/JSON/hash
shape, tag equality, and tag-specific result_ref consistency. P4 typed codecs additionally
validate strict UTF-8 (reject invalid byte sequences), canonical key order, SHA-256, exact
intent tuple, field caps and all tag-specific semantics before returning any winner
Observation. SQL cannot recompute SHA-256 without a registered extension; no new SQL hash
extension is proposed.

No new index or unique constraint is required on `tool_invocations`: its existing
`invocation_id PRIMARY KEY` is the settlement race key; existing execution/unsettled indexes
remain unchanged. `UPDATE ... WHERE invocation_id=? AND settled_at IS NULL` remains the
winner CAS. The CAS transaction must first pass the current lease fence, read the row, then
materialize/link an auto Artifact only if the row is still unsettled; update all terminal
and observation fields once. A zero-row update reads the committed winner, validates it, and
returns its evidence. Only the winner may commit Artifact metadata/result_ref. A killed
transaction rolls its SQLite DDL/data writes back; a content-addressed blob written before
rollback may remain unreferenced under P4 `07`.

## 3. P9 source-specific durable failure fact

The accepted logical proposal fixes a source-specific fact/event, dedup tuple
`(executionId, invocationId)`, and bound `logicalActionId / providerTurnId / callRef /
failureCode`; no raw arguments, observation, parser or OS error may be written. Candidate
P9 table (event/fact are inserted in one P40-era transaction):

```sql
CREATE TABLE tool_observation_replay_attention_facts (
  attention_fact_id   TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id          TEXT NOT NULL,
  execution_id        TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  logical_action_id   TEXT NOT NULL,
  provider_turn_id    TEXT NOT NULL,
  call_ref            TEXT NOT NULL,
  invocation_id       TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  failure_code        TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  first_detected_at   TEXT NOT NULL,
  UNIQUE (execution_id, invocation_id),
  UNIQUE (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);
CREATE INDEX tool_observation_replay_fact_target
  ON tool_observation_replay_attention_facts
    (project_id, target_workspace_id, first_detected_at);
```

Supplemental deterministic fact-id decision: serialize exactly the UTF-8 bytes of the
canonical JSON object `{"executionId":<id>,"invocationId":<id>,"version":1}` (UTF-8
lexicographic key order, no whitespace, no trailing newline), hash those bytes with SHA-256,
and prefix lowercase hex with `att_`. The event type is
`ToolObservationReplayEvidenceEscalated`, version 1; candidate payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId, providerTurnId,
callRef, invocationId, failureCode}`. Supplemental event-envelope decision follows the
accepted P9 source-fact pattern: `projectId` from Execution, `occurredAt=firstDetectedAt`,
`aggregateRef=targetWorkspaceId`, `actor=system:recovery`,
`correlationRef=logicalActionId`, `causedByCommandId=null`. The P9 handler rechecks the
current full lease before row reads/fact writes; a stale generation writes no Attention.
Exact duplicate `(executionId,invocationId)` returns the same fact/event only when the
bound tuple and failure code match; conflict fails closed.

The accepted logical proposal pins tuple, identity fields, failure-code set, no-leak rule,
dedup behavior and fact/event atomicity. It does not separately pin the exact
`attentionFactId` serialization/hash or event envelope. The preceding two paragraphs are
therefore explicit supplemental decisions for independent review/acceptance, based on P9's
existing versioned fact/event convention; they are not silently attributed to the accepted
proposal and are not landed design.

## 4. P10 source-specific Action Required marker row

Accepted AH7-DG-01 semantics fix `ActionRequired`, target=`executions.workspace_id`,
dedup=`attentionFactId`, a fixed path-free summary, and no canonical mutation. P10's current
`attention_projection_rows` has `source`/severity CHECKs and a `source_fact_id` FK specifically
to `assign_work_binding_attention_facts`; adding this P9 fact there would redesign that
cross-source contract. Following the accepted AH10 source-specific-table strategy, P10 adds
a dedicated marker row table:

```sql
CREATE TABLE tool_observation_replay_attention_rows (
  project_id          TEXT NOT NULL,
  dedup_key           TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'ToolObservationReplayEvidenceFailure'
                      CHECK (source = 'ToolObservationReplayEvidenceFailure'),
  severity            TEXT NOT NULL DEFAULT 'ActionRequired'
                      CHECK (severity = 'ActionRequired'),
  target_workspace_id TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'
                      CHECK (summary = 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'),
  failure_code        TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  occurred_at         TEXT NOT NULL,
  source_event_id     TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  source_fact_id      TEXT NOT NULL,
  PRIMARY KEY (project_id, dedup_key),
  CHECK (dedup_key = source_fact_id),
  FOREIGN KEY (source_fact_id, project_id, target_workspace_id, source_event_id)
    REFERENCES tool_observation_replay_attention_facts
      (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (target_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id)
);
CREATE INDEX tool_observation_replay_row_target
  ON tool_observation_replay_attention_rows
    (project_id, target_workspace_id, occurred_at);
```

This table stores source/severity/fixed path-free summary, target, the closed typed failure
classification, event/fact provenance and timestamp. `failure_code` is internal projection
detail, like AH10's row; it is not added to the public Attention DTO. The fixed summary is
the only user-facing detail and contains no opaque ids, output, path, provider response,
parser/OS text, cause, or secret. This preserves generic AssignWork table/FKs and mirrors
P10's source-specific `workspace_resource_activation_attention_rows` and accepted AH10
Attention materialization pattern. The exact source literal and summary are supplemental
physical/read-model decisions, subject to owner review before landing.

The P10 query unions this source-specific table with its existing source rows into the
existing Attention result contract, mapping `source`, `ActionRequired`, target and fixed
summary; `dedup_key` is the exact P9 `attentionFactId`. It does not add a DTO detail field.
The marker uses execution's `workspace_id` (the owning/Parent Workspace), checked against
both P9 fact and workspace FK. Existing subtree counts derive from deduplicated rows and are
not separately persisted or incremented.

### Offset/rebuild contract

- Use the existing per-project shared `P10_ATTENTION_CONSUMER_ID`; do not add a second offset.
- P10 applies `ToolObservationReplayEvidenceEscalated` only after reading and exactly
  validating its P9 fact/event pair. The selected P10 row write and P1 attention consumer
  offset advance share one `TransactionScope`; exact duplicate event/fact is a no-op and a
  conflict is projection corruption.
- `AttentionProjectionStore.resetProject(projectId)` must include the selected source table.
  A full P10 rebuild clears that table, rewinds the same shared offset to `floor-1`, then
  catches up retained journal events in the existing P10 atomic rebuild/reset transaction.
  If the current offset is below the retained event floor, preserve the current rows and
  return the existing `ConsumerRebuildRefused`; do not silently use P9 facts as an unapproved
  level-triggered rebuild source.
- Restart/duplicate consumer delivery must yield at most one row keyed by
  `(projectId, attentionFactId)` and one P10 Action Required DTO. No dismissed/repair action,
  P4 mutation, Work/Permission/Execution mutation, or generic new Attention source is added.

This supplemental physical contract does not widen CAPA approval consume/binding, add an
approval transaction participant, change any `SideEffectSemantics` admission/reconciliation
rule, or authorize a second executor attempt. The existing approval and effect contracts
remain authoritative; P40 only binds the already selected terminal settlement to its exact
bounded observation evidence.

## 5. Owner map and review confirmations

| Owner | Physical clauses to review before owner landing |
|---|---|
| P4 `06` + global P40 migration | `tool_invocations` BLOB fields/checks/triggers, no backfill, terminal immutability, rollback/retry and prefix-only migration registration. |
| P4 `01/02/06/07` | BLOB encoding/hash byte contract, five tag/settlement/result_ref/artifact consistency, winner CAS, fence-before-read, auto Artifact created only by winner. |
| P9 `07` + event catalog / store | fact/event DDL, exact tuple and hash serialization, fixed failure codes/payload/envelope, current-fence checks, atomicity and no secret leakage. |
| P10 `02/04/07` + read ports | source-specific marker table/DTO mapping; fixed source/severity/summary and internal-only failure code; shared offset, apply-then-advance, reset/rebuild/refused-floor behavior. |
| P2/P3 indexes | P4/P3 stale-generation ownership-loss and current-generation winner convergence remain the accepted lease/source contract. |

Open independent-review confirmations before owner landing:

1. Confirm the supplemental P9 fact-id serialization and event envelope, or return exact
   fields for a narrow accepted amendment.
2. Confirm the P10 source literal and fixed path-free summary against the P10 query/detail
   owner; failure code remains internal and no public DTO field is added.
3. Confirm P40 cumulative migration registration can enforce the P36–P39 prefix and
   serialized one-runner startup prerequisite.

Until these choices receive manual review and acceptance, P40 is a DDL candidate only:
**do not edit `docs/design/**`, execute a migration, or claim AH7-DG-01 owner landing complete.**
