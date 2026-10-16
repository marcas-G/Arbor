# F23 P6 UnboundLegacy Governance Inbox Mechanics — Supplemental Proposal

状态：**DRAFT — supplemental P6 design package only; not accepted**

Recommended exact design-acceptance token:
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`

This proposal supplements the accepted P8 permanent replay-origin package
(`ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`, proposal
SHA-256 `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`).
The P8 package fixes the high-level requirement that an unprovable legacy
success preserves its Command receipt and gets a human-only, queryable
`UnboundLegacy` Governance Inbox item. P6 item identity/routing, owner-change
reconciliation, query/consumption, and rebuild mechanics were deliberately
left outside that accepted package. This proposal is a recommendation only;
it does not edit design files or authorize code, DDL, tests, migration
registration/execution, or online database upgrade.

## 1. Required disposition source, independent of receipts

The P8/P1-owned immutable `retry_verification_legacy_dispositions` fact must
contain enough identity to recreate the Inbox warning without reading or
decoding the permanent Command receipt. Recommended minimum fields are:

| Field | Purpose |
|---|---|
| `command_id` | Stable source/Inbox key and Command correlation |
| `project_id` | Project scope |
| `source_work_id` | Canonical Work from the exact decoded P8 result at legacy classification |
| `source_verification_id` | Exact orphaned source Verification identity |
| `disposition` | Fixed value `UnboundLegacy` |
| `reason_code` | Fixed bounded value `OriginEvidenceIncomplete` |
| `recorded_at` | Immutable disposition time |

No result JSON, summary content, fingerprint/schema, event JSON, or recipient
snapshot is stored. `source_work_id` and `source_verification_id` are the
minimum additional route/rebuild identity; other current-route identity must
be derived from canonical Work/Workspace/governance facts, not copied as an
immutable recipient. The disposition is permanent and is sufficient to
rebuild the P6 Inbox projection after Domain Event pruning, Command receipt
corruption, or receipt JSON retention/decoding failure. Rebuild must not
depend on CommandStore or re-decode the receipt.

Malformed/conflicting disposition identity is a typed persistence-corruption
condition and produces no fallback recipient. The legacy migration only
creates this fact for a receipt it has recognized as a successful P8 result;
the original receipt bytes/resolution are never rewritten or deleted.

## 2. Recommended stable entry and dynamic current route

Recommended entry:

- `InboxEntry.kind = RetryVerificationUnboundLegacy`.
- Stable `entryKey = "retry-verification-unbound:" + commandId`; the key is
  independent of recipient so owner/Parent changes move the same logical
  warning rather than creating a second item.
- Query payload is bounded to CommandId, ProjectId, source Work/Verification
  IDs, fixed disposition/reason, and timestamps. It excludes receipt/result
  JSON, summary content, source event JSON, fingerprint, path/host data, and
  provider/model content.
- The recipient is **not** an immutable origin-time snapshot. Every admission,
  rebuild, query, and route reconciliation derives current visibility from
  canonical Work/Workspace plus P8's current human-governance facts: Root Work
  uses its current Root-local human route; child Work uses its current exact
  direct Parent human route. P8 query authorization is checked at read time;
  an Inbox row never grants authority.
- A change to current Work ownership or Parent-governance relation is a route
  move, not a content conflict. The same key/source/disposition with a
  different current recipient is legal. CommandId, ProjectId, source Work,
  source Verification, disposition, or reason mismatch for that key is a
  typed integrity failure, not an overwrite or a route move.
- If the source tuple stays identical and only the authorized recipient
  changes, reconcile the recipient under the same stable key. Prefer doing so
  in the same transaction as the canonical owner/Parent relation change; if
  the P6 integration point cannot do that, the owner-change transaction must
  persist a durable `InboxRouteReconciliationRequired` fact that restart
  processing can complete idempotently. Do not rely on volatile callbacks.
- The disposition's `recorded_at` and Inbox row `created_at` are immutable.
  Each actual route move increments the Inbox row's safe-integer `revision`
  and sets `updated_at`; a no-op reconciliation changes neither. The legacy
  disposition itself is never updated or cleared.

### Stale projection, visibility and crash semantics

Every query re-resolves the source Work and current governance route; a stale
stored recipient is not an authorization input. Immediately after an owner or
Parent relation change, the old recipient fails the current authorization
filter even if the Inbox projection has not yet moved. The new recipient sees
the item in the same owner-change transaction or after the durable required
reconciliation completes; until then there is no broader visibility. A crash
before a same-transaction route move leaves the old canonical route and old
Inbox row together. A crash after commit leaves the new route and row together.
For a separately durable reconciliation, restart repeats the same key/source
move without duplication.

## 3. Query, consumption, rebuild and replay

- The Governance Inbox query returns a pending warning only to a human who
  currently passes the P8 governance check for the derived route. The fixed
  `UnboundLegacy`/`OriginEvidenceIncomplete` reason is a warning, not an
  approval or permission grant.
- Recommended v1 behavior is read-only: reading does not acknowledge, consume,
  clear, or promote the entry; no Agent Session, command, ProviderTurn, wake,
  or P10 Attention item is created. Any explicit dismissal/resolution action
  requires separate design acceptance.
- Inbox rebuild uses only the retained disposition and canonical Work/
  Workspace/governance facts. It upserts the same `entryKey`, recomputes the
  current recipient, preserves `created_at`, and advances `revision` /
  `updated_at` only for a real route move. A conflicting same-key source
  disposition fails closed; it does not inspect a receipt to repair the row.
- Migration/backfill writes disposition and initial Inbox item atomically.
  If current route cannot be proved, the migration rolls back rather than
  falling back to Project root or a previous recipient.
- UnboundLegacy has no P8 origin and cannot acquire replay authority. Its
  external replay remains a generic current Resolver denial before Gateway;
  Inbox visibility never changes that result.

## 4. Required owning-document changes if accepted

- **P6 `02-communication-protocol.md`:** entry kind/stable key, dynamic
  recipient, current query authorization, route-move conflict algebra,
  revision/timestamp rules, read-only/no-consume behavior, restartable route
  reconciliation, and receipt-independent rebuild source.
- **P6 `06-acceptance.md`:** Root and child recipients; owner/Parent change
  before/after transaction crashes; old-recipient query denial/new-recipient
  access; stale projection repair; duplicate and mismatch negatives;
  no-consume/no-Agent/no-Attention assertions.
- **P6 `00-contract-index.md`:** index the route-specific P8 governance
  warning and its query/rebuild owner.
- **P8 `01-verification-commands.md` / `06-acceptance.md`:** cross-reference
  the accepted P6 mechanics while keeping the origin/current-authorization
  and no-replay semantics unchanged.
- **P1 `04-sqlite-schema.md`:** extend the unbound disposition with source
  Work/Verification IDs and timestamp; preserve migration ID TBD and the
  atomic disposition+Inbox write. P1 `03`/migration owner defines transactional
  owner-change reconciliation only if the P6 design chooses that integration.
- **P12 `10-transport-shells.md` (and `02` only if needed):** define the
  authorized Inbox query boundary without turning an Inbox row into authority.
  No P10 document change is proposed.

## 5. Qualification after design acceptance

1. Exact key/schema and Root/child route derivation; wrong/foreign human sees
   no item or source details.
2. Same source/disposition with a new recipient is an idempotent route move;
   same key with different CommandId/ProjectId/Work/Verification/disposition
   is typed corruption, not overwrite.
3. Owner/Parent change before/after crash: old recipient is denied as soon as
   current authorization changes; new recipient gains access in the same
   transaction or only after durable route reconciliation completes.
4. Stale projection repair: remove only the Inbox projection row in a
   disposable fixture; rebuild from the disposition without receipt reads or
   decoding, preserve `created_at`, and produce one current-route item.
5. Verify route `revision` / `updated_at` changes on move, stays stable on
   duplicate/no-op rebuild; disposition `recorded_at` never changes.
6. Corrupt/prune the permanent Command receipt and prune Events; the
   disposition still rebuilds the same current route. Exact legacy replay
   stays generic-denied and no receipt is repaired.
7. Migration/owner-change crash matrix proves atomic disposition+Inbox and
   same-key recipient move, with no duplicate, Agent Session, command,
   ProviderTurn, wake, or Attention effects.

## 6. Acceptance boundary

Recommended exact token:
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`.

Acceptance authorizes only the fixed P6/P8/P1/P12 design-document amendments
and a post-landing consistency review. It does not authorize production code,
Inbox/route DDL, migration registration/execution, tests, or online database
upgrade. Those remain separately authorized after the P6 design landing.
