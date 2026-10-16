# F23 P6 UnboundLegacy Governance Inbox Mechanics — Supplemental Proposal

状态：**DRAFT — supplemental P6 design package only; not accepted**

Recommended exact design-acceptance token:
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`

This proposal supplements the accepted P8 permanent replay-origin package
(`ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`, proposal
SHA-256 `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`).
The P8 package fixes the high-level requirement that an unprovable legacy
success preserves its Command receipt and gets a human-only, queryable
`UnboundLegacy` Governance Inbox item. It expressly leaves the P6 entry kind,
key, dynamic recipient, query/consumption and rebuild mechanics to separate P6
owner acceptance. This proposal is a recommendation only; it does not edit
design files or authorize production code/DDL/tests, migration
registration/execution, or online database upgrade.

## 1. Permanent disposition, independent of receipt retention

The P8/P1-owned immutable `retry_verification_legacy_dispositions` fact must
contain enough source identity to rebuild its Inbox warning without reading or
decoding the permanent Command receipt. Recommended minimum fields are:

| Field | Purpose |
|---|---|
| `command_id` | Stable source/Inbox key and Command correlation |
| `project_id` | Project scope |
| `source_work_id` | Canonical Work identity from the exact decoded P8 result at legacy classification |
| `source_verification_id` | Exact orphaned source Verification identity |
| `disposition` | Fixed value `UnboundLegacy` |
| `reason_code` | Fixed bounded value `OriginEvidenceIncomplete` |
| `created_at` | Existing P1 timestamp spelling; immutable disposition creation time |

The row stores no result JSON, summary, fingerprint/schema, event JSON, or
recipient Workspace snapshot. `source_work_id` and `source_verification_id`
are the minimum durable route identity. The disposition has the Command
receipt's lifetime and is sufficient to reconstruct the Inbox entry after
Domain Event pruning, receipt corruption, or receipt JSON decode failure.
Rebuild never queries `CommandStore` or re-decodes a receipt. The P1
disposition row is immutable; a missing/malformed source identity is typed
corruption and never triggers a fallback recipient.

## 2. Reuse the existing Governance Inbox kind; keep one stable key

Do not add a new `InboxEntry.kind`. Reuse the existing `Governance` kind and
distinguish this entry by the stable key and typed payload subtype:

- `kind = Governance` (no enum extension in P6, P7, P14 or P10).
- `entryKey = "retry-verification-unbound:" + commandId`.
- payload subtype `RetryVerificationUnboundLegacy`, containing only
  CommandId, ProjectId, source WorkId/VerificationId, fixed disposition and
  reason code, plus the Inbox row's timestamps/revision. No receipt JSON,
  summary content, source event JSON, fingerprint, path, or host detail is
  exposed.
- one logical disposition has one stable key. Same source/disposition with a
  different recipient is a legal route move, not a key/content conflict.
  CommandId, ProjectId, source WorkId, source VerificationId, disposition, or
  reason mismatch for that key is typed integrity corruption, not an
  overwrite.

The entry is human-only, queryable under current P8 authorization, and is not
a Message, approval, Agent instruction, or P10 Attention source. Reading is
not consumption: no ACK/clear action, automatic consumer, Agent Session
promotion, command, wake, or ProviderTurn exists in this v1 scope. The
immutable disposition remains after the Inbox row is rebuilt.

## 3. Dynamic current recipient and atomic route moves

Recipient is not an immutable origin-time snapshot. Every admission, query,
rebuild and route reconciliation derives the current human governance route
from the disposition's Project/Work IDs and canonical Work/Workspace facts,
then applies the current P8 authorization check. Root Work uses its current
Root-local human governance route; child Work uses its current exact direct
Parent Workspace human route. The Inbox row itself grants no authority.

An owner or Parent-governance relation change moves the same stable Inbox key
to the newly authorized route; it does not create a duplicate. This recipient
projection move must commit in the **same P1 command transaction** as the
canonical owner/Parent relation change. At that commit, the old recipient
immediately loses visibility under current query authorization and the new
recipient receives the same-key entry. If the command cannot update the Inbox
recipient projection in that same transaction, the owner-change command
returns a typed terminal rejection (recommended existing
`AuthorityDenied`) and writes no canonical owner/Parent change, Inbox move,
Event or receipt. Do not add an asynchronous window or a durable
`InboxRouteReconciliationRequired` fact.

The same rule applies to any owner/Parent governance edit: its command either
atomically updates the same-key Inbox route or rejects without writes. A
separately invoked rebuild/repair runs in one transaction against current
canonical Work/Workspace facts; stale row recipient is not authorization and
the old recipient remains denied. If the P6 Inbox physically resides outside
the P1 transaction boundary, that physical architecture is insufficient for
this contract: its owning design/migration must bring the route row into the
same P1 database/transaction before owner-changing commands can be accepted.

### Identity and timestamps

- The disposition `created_at` is immutable and never changes on route move.
- Inbox `created_at` is preserved for the stable key; each actual recipient
  move increments the Inbox `revision` and updates `updated_at` in the same
  P1 transaction. Identical route reconciliation is a no-op with no timestamp
  or revision change.
- The route move does not rewrite/delete the disposition, origin, receipt or
  receipt JSON.

## 4. Rebuild and replay behavior

Inbox rebuild derives the row only from the retained
`retry_verification_legacy_dispositions` fact and canonical Project/Work/
Workspace/governance facts. It does not read, parse, or validate the permanent
Command receipt or retained Domain Events. It uses the same stable key and
subtype; same-source current-recipient changes update the recipient legally,
while mismatching source/disposition identity fails typed and closed.

An UnboundLegacy CommandId has no permanent P8 origin. Its External replay is
the existing generic current Resolver denial before Gateway/receipt lookup;
Inbox presence never grants authority. P8/P1 current-authorized origin replay
and Gateway tuple behavior otherwise remain unchanged. The Inbox entry is
informational and cannot unblock the command.

## 5. Required owning-document landing if accepted

- **P6 `02-communication-protocol.md`:** reuse `Governance` kind; define the
  stable key/subtype/payload, current recipient derivation, query filter,
  read-only/no-consume behavior, same-key route-move conflict algebra, and
  P1-transaction requirement.
- **P6 `06-acceptance.md`:** owner/Parent change tests, same-transaction route
  move, typed no-write rejection when atomic move is unavailable, old/new
  recipient query behavior, and stale-projection rebuild.
- **P6 `00-contract-index.md`:** cross-reference the P8 warning subtype; P7,
  P14 and P10 need only owner references if applicable, with no Inbox kind
  enum or Attention source extension.
- **P8 `01-verification-commands.md` / `06-acceptance.md`:** reference the
  accepted P6 route mechanics without changing P8 current-auth/replay rules.
- **P1 `04-sqlite-schema.md`:** add source WorkId/VerificationId to the
  disposition and specify the Inbox row's P1 transaction/createdAt/updatedAt/
  revision representation. Migration ID remains TBD. P1 `03` owns the atomic
  owner-change transaction boundary.
- **P12 `10-transport-shells.md` / `02-authority-resolver.md`:** query reads
  re-evaluate current P8 human authorization; Inbox row is not authority.

No P10 Attention source is proposed. If current P6/P1 physical storage cannot
support the same P1 transaction, implementation is blocked until those owners
accept a compatible physical design; do not substitute asynchronous repair.

## 6. Qualification required after acceptance

1. Existing `Governance` kind is reused; there is no P6/P7/P14/P10 enum
   extension. Stable key/subtype/payload and current-route query authorization
   are exact.
2. Same source/disposition with a new recipient is a legal same-key route
   move; changed CommandId/ProjectId/WorkId/VerificationId/disposition/reason
   is typed corruption, not overwrite.
3. Owner/Parent change before/after commit crash: rollback leaves canonical
   owner relation and Inbox recipient unchanged; commit makes both new. If
   same-transaction Inbox move is unavailable, owner-change command returns
   typed rejection with zero canonical/Event/Inbox/receipt writes.
4. Immediately after committed route change, old recipient query is denied and
   current recipient query returns the same-key entry. No asynchronously
   reconciled visibility interval exists.
5. Remove only the Inbox projection row in a disposable fixture, corrupt or
   prune the receipt and prune the Events; rebuild from disposition and
   canonical Work/Workspace only, preserve `created_at`, and produce one
   current-recipient row. This proves receipt-independent reconstruction.
6. Verify `revision`/`updated_at` advance once on a recipient move, remain
   unchanged on duplicate/no-op rebuild, and disposition `created_at` never
   changes. Read does not consume/clear; no Agent Session, command, ProviderTurn,
   wake, or P10 Attention effect occurs.
7. Migration crash before/after commit proves disposition + Governance Inbox
   entry are both absent before commit and both present after commit. The
   disposition retains source IDs so rebuild does not consult receipt/event
   retention.

## 7. Acceptance boundary

Recommended exact token:
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`.

Acceptance would authorize only the fixed P6/P8/P1/P12 design-document
amendments and post-landing consistency review. It would not authorize
production code, Inbox/route DDL, migration registration/execution, tests, or
online database upgrade. Those remain separately gated after the P6 design
landing.
