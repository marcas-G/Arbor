# AH10 Deliver Replay — P10 Storage and Migration Order Addendum

Status: **DRAFT / requires separate manual acceptance**
Suggested acceptance marker: `ACCEPT_AH10_DELIVER_P10_STORAGE_ADDENDUM`
Implementation authorization: **not granted**

This is an addendum to the accepted AH10 Deliver design proposal and its DID
v1.37 landing. It does not revise either record's hash or claim that the
existing landing is closed. It addresses only the two Blocking findings from
the post-landing review: migration numbering against the accepted P10/F21/AH7
prefix, and the mismatch between Deliver's failure fact and the existing
AssignWork-specific P10 projection table.

## Accepted baseline

- Original accepted proposal SHA-256:
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
- Existing DID v1.37 acceptance, P1/P2/P7/P9/P10 landing and decision record
  remain audit history. This addendum adds no runtime or test implementation.
- Accepted/planned schema prefix is fixed and append-only; it is not yet the
  current integrated migration registry. The inspected AH10 governance tree
  and main integration tree currently register through P35/user_version 35.
  P36 is accepted and implemented only in the isolated AH7 tree and is not yet
  merged into the mainline/integrated tree. Its authority and evidence are:
  AH7 design landing `34ed1c597c02d677d87f4fa9435d8339641ea3d6`, governance
  acceptance/landing record `5cab270642f3a738f1da3dcb846ce734d477f8b2`, and
  P36 implementation/L1 commit `fa732378e32e8949d39fa68b637418c2b6939e99`;
  see `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\results\AH7-DG-03-governance-acceptance-and-landing.review.md`
  and `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\results\AH7-DG-03-implementation-l1.result.md`.

  The ordered target prefix, once P36 is integrated, is:

  | Migration | Existing owner / use |
  |---|---|
  | `0034` | P10 Attention materialization, already accepted and deployed |
  | `0035` | F21 resource activation Attention, already accepted |
  | `0036` | accepted AH7/P36 schema; implemented and L1-qualified in the isolated AH7 tree only, not yet integrated |
  | `0037` | proposed additive AH10 Deliver P9 fact + P10 source-specific projection row |

Migration `0037` is the next version only after P36 has been integrated. It
MUST NOT be implemented, installed, or released independently of that P36
integration, and MUST NOT rewrite, renumber, squash, or replace `0034`, `0035`,
or `0036`. The current
AH10 v1.37 design's Deliver failure-fact table definition is superseded only
after this addendum is accepted; its behavior and identity contract remain.

## Recommended P10 storage decision

Keep the existing AssignWork-specific P10 Attention table and its source,
`failure_code`, and foreign-key contract unchanged. Add a separate marker table
`deliver_replay_attention_rows`, keyed by the P9 `attentionFactId`, and source
its displayed target, failure code, and timestamp by joining to the immutable
P9 fact. This avoids putting Deliver rows into a table whose constraints only
represent AssignWork evidence, and avoids duplicating mutable projection fields
that could disagree with the source fact.

The source-specific projection table is:

```sql
CREATE TABLE deliver_replay_attention_rows (
  attention_fact_id TEXT PRIMARY KEY
    REFERENCES deliver_replay_attention_facts(attention_fact_id)
);
```

The primary key is the projection's unique dedup identity: at most one visible
DeliverReplayFailure row per immutable P9 fact. The foreign key makes every
materialized projection marker point to its P9-owned source fact. The row
intentionally does not duplicate `project_id`, `target_workspace_id`,
`failure_code`, `first_detected_at`, or summary; the query joins the P9 fact and
uses its indexed `(project_id,target_workspace_id,first_detected_at)` path.
The fixed source tag is supplied by the loader, not stored in the marker.

The P9 fact remains the immutable source relation from the accepted baseline:

```sql
CREATE TABLE deliver_replay_attention_facts (
  attention_fact_id       TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id              TEXT NOT NULL,
  execution_id            TEXT NOT NULL,
  target_workspace_id     TEXT NOT NULL,
  logical_action_id       TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  failure_code            TEXT NOT NULL CHECK (failure_code IN (
    'LegacyMessageMissingEvent','LegacyEventMissingMessage',
    'LegacyMessageBindingMismatch','LegacyInboxConflict',
    'PriorReceiptDecodeMismatch','PriorReceiptResultMismatch',
    'RejectedReceiptEffectConflict','PriorReceiptEffectConflict'
  )),
  first_detected_at       TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, message_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);

CREATE INDEX deliver_replay_attention_target
  ON deliver_replay_attention_facts(project_id, target_workspace_id, first_detected_at);
```

P9 fact and `DeliverReplayEscalated(v1)` remain one atomic transaction. P10's
project-scoped event consumer transaction inserts the marker and advances its
own P1 offset together. Before that commit, restart sees neither marker nor
offset advancement and replays the event; after commit, re-delivery hits the
marker primary key and cannot duplicate the row. P10 never writes the P9 fact.

## P10 query union and rebuild contract

The query layer converts source-specific stores into the existing common
Attention DTO union. The Deliver branch is exactly:

```sql
SELECT
  'DeliverReplayFailure' AS source,
  'ActionRequired' AS severity,
  fact.target_workspace_id AS target_workspace_id,
  fact.attention_fact_id AS dedup_key,
  fact.failure_code AS failure_code,
  fact.first_detected_at AS occurred_at
FROM deliver_replay_attention_rows AS projected
JOIN deliver_replay_attention_facts AS fact
  ON fact.attention_fact_id = projected.attention_fact_id
WHERE fact.project_id = ?;
```

The row uses the Execution Workspace recorded in
`fact.target_workspace_id` (equal to `executions.workspace_id` when the fact is
created), `dedupKey=attentionFactId`, and the fixed safe summary accepted in
DID v1.37. The common query unions this source with existing source-specific
AssignWork Attention, the F21 activation source, and the existing derived
sources before project/workspace filtering, severity counts and subtree
aggregation. One P9 fact contributes one row/count; no duplicate raw event is
counted. Opaque MessageId/body/summary and parser/database diagnostics are not
presented.

An authorized P10 full rebuild resets the Deliver projection marker in the
same transaction as the other P10 source projections and the existing P1
consumer-offset rewind. It then repopulates `deliver_replay_attention_rows`
from all current P9 facts for each project before replaying retained events.
This source-fact seed is required so a pruned `DeliverReplayEscalated` event
does not erase Attention. Source reset, consistent P9-fact snapshot, marker
insert, and offset rewind commit or roll back together. Replaying retained
events after rebuild is idempotent. This addendum does not alter F21's
source-specific reset/refusal protocol, the P1 journal floor, or the AH7 P36
consumer-offset rules.

## Migration and installed-database sequence

Add only forward migration `0037_ah10_deliver_replay_attention_rows` at
`PRAGMA user_version=37`. It creates `deliver_replay_attention_facts`, its
target index, and `deliver_replay_attention_rows`; there is no historical
backfill, command/Message/Event change, or schema downgrade.

Required upgrade paths:

- Fresh/current v33 database: after P36 integration, apply accepted `0034` P10,
  then `0035` F21, then `0036` AH7/P36, then proposed `0037` Deliver.
- Existing deployment at `user_version=35`: first integrate/release the
  accepted P36 migration and apply `0036`, then apply `0037` in order. The
  `0037` release MUST NOT be made available as a standalone upgrade from 35.
- Existing deployment at `user_version=36`: this state is valid only after
  P36 has been integrated/applied; then apply `0037` only.
- The implementation must retain checksums/DDL for `0034`–`0036`; it must not
  edit their bodies or mark them as a compatibility shortcut. A v36 binary
  accepts v36 and refuses v37 until upgraded; the v37 binary accepts the full
  ordered prefix.

Migration qualification must use an actual equivalent v35 schema fixture and
the accepted P36 AH7 L1 baseline, then prove v35→v36→v37 and v36→v37 after P36
has landed in the target integration. Fresh migration qualification must prove
0034→0035→0036→0037 after that same integration. Preserve the existing F21 and
AH7 L1 evidence; do not claim it covers Deliver's new table or projection.

## Owner-document correction package after addendum acceptance

Only after this fixed addendum is independently reviewed and separately
accepted, land the following additive corrections:

- DID `§4.1B`/`§7.2`/`§9.3`/`§12.10`: record the v35/v36/v37 migration prefix,
  the separate P10 source-marker table/FK and query union, P9 source link,
  project rebuild/offset atomicity, and no change to MessageSent/Event v1.
- P9 `07`: bind the unchanged P9 fact to migration 0037 and expose the
  source-fact list used by the P10 rebuild.
- P10 `02`: replace the original generic-table Deliver mapping with the
  source-specific marker/query join; preserve the AssignWork table and rows.
- P10 `04`: own source reset, P9-fact snapshot/seed, P1 offset rewind, and
  rebuild atomicity for the Deliver marker without changing the accepted F21
  source reset/refusal semantics.
- P10 `07`: add the v35/v36 migration paths and the query-union, FK/dedup,
  P9-link, event-consumer and pruned-event rebuild cases to the accepted Story
  M qualification.
- P9/P10 indexes and DID version/integration digest are updated only after the
  exact owner changes land. P1/P2/P7 contracts from the prior landing remain
  unchanged by this storage correction.

## Required qualification matrix after separate implementation authorization

1. Schema: only after P36 is integrated, qualify v33→34→35→36→37,
   v35→36→37, and v36→37; compare existing 0034–0036 schema/checksum and prove
   no historical P9 fact/projection backfill. Also prove no P37-only release
   path can upgrade a v35 database while P36 is absent.
2. P9 source: before/after fact+event commit crash, exact retry dedup, conflicting
   tuple invariant, and P9 fact/message/event/inbox failure-code cases.
3. P10 consumer: marker+P1 offset commit before/after crash; exactly one
   `DeliverReplayFailure` Attention row and subtree count; existing AssignWork
   rows unchanged and visible once in the same query union.
4. P10 query: exact source, severity, target, dedup key and fixed summary;
   stable ordering/counts across AssignWork + Deliver + F21 + derived sources.
5. Rebuild: pruned MessageSent event with retained P9 fact still reconstructs
   one Deliver row; reset/fact seed/offset rewind are atomic; retained event
   replay does not duplicate. F21 rebuild refusal behavior and AH7 P36 L1
   baseline remain intact.
6. Negative effects: no canonical Message/MessageSent/Inbox/receipt/Work/
   Dependency changes from projection; no row appears without its P9 fact;
   no AssignWork projection schema, row or dedup identity changes.

The original AH10 v1.37 design landing remains historical and incomplete with
respect to this review. This addendum is **not accepted yet** and does not
authorize changing `docs/design/**`, production, migrations, tests, or any
deployment. The implementation remains separately gated after this addendum's
acceptance and its post-landing review.
