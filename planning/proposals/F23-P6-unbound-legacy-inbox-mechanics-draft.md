# F23 P6 UnboundLegacy Governance Inbox Mechanics — Supplemental Proposal

状态：**DRAFT — supplemental P6 design package only; not accepted**

Recommended exact design-acceptance token:
`ACCEPT_F23_P6_UNBOUND_LEGACY_GOVERNANCE_INBOX_MECHANICS`

This proposal supplements the accepted P8 permanent replay-origin package
(`ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`, proposal
SHA-256 `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`).
The P8 package fixes only that unprovable legacy success is preserved as
`UnboundLegacy` and receives a human-only, queryable Governance Inbox item.
It expressly leaves the P6 entry kind/key, recipient mapping, query,
consumption and rebuild mechanics to separate P6 owner acceptance. This
proposal does not edit design files, authorize production code/DDL/tests, or
register/execute a migration.

## 1. Recommended exact P6 entry

For one recognized legacy successful RetryVerification receipt that cannot be
backfilled to `retry_verification_origins`, the already-specified immutable
`retry_verification_legacy_dispositions` fact is the source of truth. The P6
Inbox relation is a queryable, human-only route-specific warning, not an
Approval, Message, P10 Attention source, or Agent instruction.

Recommended exact entry contract:

- `InboxEntry.kind = RetryVerificationUnboundLegacy`.
- Stable `entryKey = "retry-verification-unbound:" + commandId`; at most one
  entry exists per disposition/CommandId. An identical re-admission is a
  no-op; conflicting project/kind/recipient/reason for that key is a typed
  invariant failure, not an overwrite.
- Recipient is resolved from the strict decoded `RetryVerificationResult`
  `workId` and current canonical Work/Workspace facts: Root-owned Work goes to
  its Project root Workspace; child Work goes to the exact direct Parent
  Workspace, matching P8's human-governance route. Current authorized-human
  filtering is re-evaluated at query time; Inbox presence conveys no authority.
- The query exposes only CommandId, ProjectId, fixed `UnboundLegacy` /
  `OriginEvidenceIncomplete` reason, and creation time. It does not return
  receipt/result JSON, summary content, source event JSON, fingerprints,
  canonical paths, or provider/model data.
- The item is pending/read-only. Reading does not consume, acknowledge, clear,
  promote or wake it; P6 defines no v1 mutation action for this item. Any
  future resolution/dismissal action needs separate owner acceptance. The
  immutable disposition remains even if the Inbox projection is rebuilt.
- Inbox rebuild/upsert derives this item from the retained immutable
  `retry_verification_legacy_dispositions` row and reuses the same entry key
  and route. Rebuild never infers origin, rewrites/deletes the old Command
  receipt, creates a RetryVerification receipt, or grants replay authority.
- Disposition + Inbox admission are atomic in the migration/backfill
  transaction. If the strict receipt result or current P8 human-governance
  recipient cannot be resolved, migration fails closed and rolls back; do not
  route to Project root as an unqualified fallback.

The authorized P8 replay behavior stays unchanged by this supplement: an
UnboundLegacy CommandId has no permanent origin, so External replay is a
generic current Resolver denial before Gateway and receipt access. The Inbox
item is informational and cannot unblock that command.

## 2. Required owning-document landing if accepted

- **P6 `02-communication-protocol.md`:** fixed entry kind/key/recipient,
  authorized query projection, pending/no-consumption semantics,
  idempotent admission, rebuild source and no-Agent-promotion boundary.
- **P6 `06-acceptance.md`:** public/query and migration/rebuild qualification
  stories for Root Work, child Work, unauthorized reader, duplicate admission,
  and unresolved no-action behavior.
- **P6 `00-contract-index.md`:** add the P8 legacy governance warning row and
  cross-reference the owning protocol/acceptance files.
- **P8 `01-verification-commands.md` / `06-acceptance.md`:** link to the exact
  P6 entry key and state that the read-only item does not grant replay or
  create a new command/action.
- **P1 `04-sqlite-schema.md`:** link the already-defined disposition/outbox
  migration transaction to the P6 idempotent Inbox admission without changing
  the P8 origin fields. Migration number remains TBD until the separately
  authorized implementation sequence.

The P8 owner landing's `UnboundLegacy` reason, current-human requirement,
receipt preservation, no P10 Attention source, and no online migration remain
unchanged. No P10 document change is proposed.

## 3. Qualification required after acceptance

1. Exact key, recipient, fixed payload and query authorization for Root and
   child Work; wrong/foreign human sees no item/details.
2. Identical admission is a no-op; conflicting row is typed and fails closed.
3. Read does not consume/acknowledge; no Agent Session promotion, command,
   ProviderTurn, wake, or P10 Attention row occurs.
4. Rebuild after removing only the Inbox projection row recreates one exact
   entry from the immutable disposition; it does not alter origin, receipt,
   Events or canonical Work/Verification.
5. Migration before/after commit proves disposition + entry are both absent
   before commit and both present after commit; route-resolution failure
   rolls back all migration changes.
6. UnboundLegacy replay remains generic Resolver-denied with no Gateway
   receipt read; correct origin rows remain the only P8 replay source.

## 4. Acceptance boundary

Acceptance of the recommended token would authorize only landing these fixed
P6/P8/P1 design-document amendments and a post-landing consistency review.
It would not authorize production code, DDL, migration registration/execution,
test implementation, or online database upgrade. Those remain separately
gated after the P6 design landing.
